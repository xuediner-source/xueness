/**
 * Port of `providers/tool_protocol.py`: lossless native-call assembly and
 * normalization plus bounded, content-free protocol failure diagnostics.
 * Never extract an executable call from prose or guess missing arguments.
 */
import { createHash } from "node:crypto";
import {
  PyJsonDecodeError, PyTypeError, PyValueError, isDict, pyEncodeUtf8, pyEncodeUtf8SurrogatePass, pyJsonDumps,
  pyJsonLoads, pyStrip, pyTypeName,
} from "@xueness/contracts";
import { FINISH_REASONS } from "./metadata.ts";
import { normalizeModelToolArguments } from "./tool-input-normalization.ts";

type Dict = Record<string, unknown>;

export const DIAGNOSTIC_CODES = new Set(["wrong_protocol", "missing_text", "invalid_json", "duplicate_json_key",
  "invalid_envelope", "invalid_json_value", "tool_unavailable", "invalid_native_envelope",
  "duplicate_call_id", "invalid_native_arguments"]);

/** `json.loads` refusing duplicate keys and NaN/Infinity constants. */
export function strictJson(text: unknown): unknown {
  if (typeof text !== "string") {
    throw new PyTypeError(`the JSON object must be str, bytes or bytearray, not ${pyTypeName(text)}`);
  }
  return pyJsonLoads(text, { rejectDuplicates: true, rejectNonFinite: true });
}

/** `json.dumps(value, ensure_ascii=False, allow_nan=False).encode("utf-8")`. */
export function finiteJsonText(value: unknown): string {
  const text = pyJsonDumps(value, { allowNan: false });
  pyEncodeUtf8(text);
  return text;
}

/** A strict JSON object of tool arguments. */
export function argumentsObject(text: unknown): Dict {
  const value = strictJson(text);
  if (!isDict(value)) throw new PyValueError("tool arguments must be an object");
  finiteJsonText(value);
  return value;
}

const FENCE = /^```(?:json)?[ \t]*\r?\n([\s\S]*)\r?\n```$/iu;

/** Accept a BOM or one complete JSON fence, preserving the payload verbatim. */
export function envelopeText(content: string): string {
  let text = pyStrip(content);
  if (text.startsWith("\ufeff")) text = text.slice(1);
  text = pyStrip(text);
  const fence = FENCE.exec(text);
  return fence ? pyStrip(fence[1] ?? "") : text;
}

function codePointLength(text: string): number {
  let count = 0;
  for (const _ of text) count += 1;
  return count;
}

/** A failed reply with a content-free diagnostic (length, digest, coordinates). */
export function failure(response: Dict, code: string, instruction: string, error: unknown = null): Dict {
  const content = response["content"];
  const diagnostic: Dict = { code };
  if (typeof content === "string") {
    diagnostic["responseChars"] = codePointLength(content);
    diagnostic["responseSha256"] = createHash("sha256").update(pyEncodeUtf8SurrogatePass(content)).digest("hex");
  }
  if (error instanceof PyJsonDecodeError) {
    // Error messages/keys/values can contain credentials. Coordinates cannot.
    Object.assign(diagnostic, { position: error.pos, line: error.lineno, column: error.colno });
  }
  return { ...response, _protocol_error: instruction, _protocol_diagnostic: diagnostic };
}

const ENVELOPE = "Return complete native function calls with IDs, names and arguments.";

/** Normalize final native calls without inventing IDs or repairing malformed arguments. */
export function normalizeNative(response: unknown, usedIds: Iterable<string> = []): unknown {
  if (!isDict(response)) return response;
  const rawCalls = Object.hasOwn(response, "tool_calls") ? response["tool_calls"] : null;
  if (rawCalls === null || rawCalls === undefined) return response;
  if (!Array.isArray(rawCalls)) return failure(response, "invalid_native_envelope", "Return a valid native tool_calls list.");
  const calls: Dict[] = [];
  const seen = new Set<unknown>(usedIds);
  for (const call of rawCalls) {
    if (!isDict(call) || !isDict(call["function"])) return failure(response, "invalid_native_envelope", ENVELOPE);
    const cid = call["id"];
    const fn: Dict = { ...(call["function"] as Dict) };
    if (typeof cid !== "string" || !cid || call["type"] !== "function" || typeof fn["name"] !== "string"
      || (!fn["name"].trim() && call["providerExecuted"] === true)) {
      return failure(response, "invalid_native_envelope", ENVELOPE);
    }
    if (seen.has(cid)) {
      return failure(response, "duplicate_call_id", "Use a fresh unique ID for each native call; do not repeat a completed call.");
    }
    seen.add(cid);
    fn["name"] = fn["name"].trim();
    try {
      fn["arguments"] = normalizeModelToolArguments(fn["arguments"]);
    } catch {
      return failure(response, "invalid_native_arguments", "Use finite JSON values and valid Unicode in tool arguments.");
    }
    // Invalid JSON strings remain ordinary failed tool results. They are not
    // replaced with {}, which could execute a mutating zero-argument tool.
    calls.push({ ...call, function: fn });
  }
  return { ...response, tool_calls: calls };
}

export interface FailureRecordOptions {
  protocol: string;
  attempt: number;
  finish?: string | null;
  turnId?: string | null;
}

/** Append one repairing diagnostic, keeping the latest 24. */
export function recordFailure(session: Dict, diagnostic: Dict, options: FailureRecordOptions): Dict {
  const row: Dict = {
    ...diagnostic, protocol: options.protocol, attempt: options.attempt,
    step: Object.hasOwn(session, "steps") ? session["steps"] : 0, turn_id: options.turnId ?? null,
    outcome: "repairing",
  };
  if (options.finish !== undefined && options.finish !== null) row["finishReason"] = options.finish;
  if (!Object.hasOwn(session, "protocol_diagnostics")) session["protocol_diagnostics"] = [];
  const history = session["protocol_diagnostics"] as unknown[];
  history.push(row);
  history.splice(0, Math.max(0, history.length - 24));
  return row;
}

function boundedInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 2_000_000;
}

/** Whitelist even journal metadata; never expose arbitrary stored fields. */
export function publicDiagnostics(raw: unknown): Dict[] {
  if (!Array.isArray(raw)) return [];
  const rows: Dict[] = [];
  for (const row of raw.slice(-24)) {
    if (!isDict(row) || typeof row["code"] !== "string" || !DIAGNOSTIC_CODES.has(row["code"])
      || !["json", "native"].includes(row["protocol"] as string)
      || !["repairing", "recovered", "exhausted"].includes(row["outcome"] as string)) continue;
    const safe: Dict = { code: row["code"], protocol: row["protocol"], outcome: row["outcome"] };
    for (const key of ["step", "attempt", "responseChars", "position", "line", "column"]) {
      if (boundedInt(row[key])) safe[key] = row[key];
    }
    if (typeof row["responseSha256"] === "string" && /^[a-f0-9]{64}$/.test(row["responseSha256"])) {
      safe["responseSha256"] = row["responseSha256"];
    }
    if (typeof row["finishReason"] === "string" && FINISH_REASONS.has(row["finishReason"])) {
      safe["finishReason"] = row["finishReason"];
    }
    rows.push(safe);
  }
  return rows;
}

export interface AssembledCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** Assemble SSE fragments only; execution awaits the complete response. */
export class NativeCallAssembler {
  readonly calls = new Map<number, AssembledCall>();
  readonly #ids = new Map<string, number>();
  readonly #objectArguments = new Set<number>();
  #closed = false;

  add(fragments: unknown): void {
    if (!Array.isArray(fragments)) throw new PyValueError("tool call fragments must be a list");
    for (const call of fragments) {
      if (!isDict(call)) throw new PyValueError("invalid tool call fragment");
      const index = Object.hasOwn(call, "index") ? call["index"] : 0;
      if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= 128) {
        throw new PyValueError("invalid tool call index");
      }
      let target = this.calls.get(index);
      if (!target) {
        target = { id: "", type: "function", function: { name: "", arguments: "" } };
        this.calls.set(index, target);
      }
      const hint = Object.hasOwn(call, "id") ? call["id"] : null;
      // Some compatible gateways emit id: "" on a continuation/final delta.
      // Only an already-bound identity can make that an omitted hint.
      const cid = hint === "" && target.id ? null : hint;
      if (cid !== null && cid !== undefined) {
        if (typeof cid !== "string" || !cid || (target.id && target.id !== cid)
          || (this.#ids.has(cid) && this.#ids.get(cid) !== index)) {
          throw new PyValueError("conflicting tool call identity");
        }
        target.id = cid;
        this.#ids.set(cid, index);
      }
      if ((Object.hasOwn(call, "type") ? call["type"] : "function") !== "function") throw new PyValueError("invalid tool call type");
      const fn = Object.hasOwn(call, "function") ? call["function"] : {};
      if (!isDict(fn)) throw new PyValueError("invalid tool function fragment");
      for (const field of ["name", "arguments"] as const) {
        let value = Object.hasOwn(fn, field) ? fn[field] : null;
        if (value === null || value === undefined) continue;
        if (field === "arguments" && isDict(value)) {
          if (target.function[field]) throw new PyValueError("mixed argument object and fragments");
          value = finiteJsonText(value);
          this.#objectArguments.add(index);
        } else if (field === "arguments" && truthy(value) && this.#objectArguments.has(index)) {
          throw new PyValueError("mixed argument object and fragments");
        }
        if (typeof value !== "string") throw new PyValueError("tool function fragment must be text");
        target.function[field] += value;
      }
    }
  }

  /** A provider finish event closes the input lifecycle; parseable JSON alone cannot. */
  close(): void { this.#closed = true; }

  finish(requireClosed = false): AssembledCall[] {
    if (requireClosed && !this.#closed) return [];
    return [...this.calls.keys()].sort((a, b) => a - b).map((index) => this.calls.get(index) as AssembledCall);
  }
}

function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (isDict(value)) return Object.keys(value).length > 0;
  return Boolean(value);
}
