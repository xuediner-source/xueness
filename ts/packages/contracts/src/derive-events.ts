/**
 * Port of `xueness/events.py`: derive the v1 event list from a stored session.
 *
 * Pure and deterministic. The output must equal the Python derivation value
 * for value and key for key; `test/events-golden.test.ts` checks the frozen
 * golden file and `test/events-differential.test.ts` compares against the
 * Python implementation on generated sessions.
 */
import {
  ERROR_CODES, MAX_EVENTS_LIMIT, XUENESS_EVENT_SCHEMA, XUENESS_EVENTS_SCHEMA, XUENESS_PROTOCOL_VERSION,
} from "./events-v1.ts";
import {
  isDict, isTurnId, pyGet, pyJsonDumps, pySlice, pyStr, pyStrip, pyTruthy,
} from "./python-compat.ts";

type Dict = Record<string, unknown>;
/** Derived events keep Python's field values, which may be any JSON value. */
export type DerivedEvent = Dict & { schema: string; seq: number; sessionId: string; type: string };

export interface DerivedEnvelope {
  schema: string;
  protocolVersion: number;
  sessionId: string;
  status: unknown;
  steps: unknown;
  mode: unknown;
  events: DerivedEvent[];
  cursor: number;
  nextCursor: number;
  head: number;
  hasMore: boolean;
}

/** Map a legacy `(ok, error)` pair to a stable code; first matching rule wins. */
export function errorCode(ok: boolean, error: string): string {
  if (ok) return "";
  const text = pyStrip(error ?? "").toLowerCase();
  if (!text) return ERROR_CODES.toolFailed;
  if (text.startsWith("denied")) return ERROR_CODES.denied;
  if (text.includes("cancel")) return ERROR_CODES.cancelled;
  if (text.includes("not found") || text.includes("no such")) return ERROR_CODES.notFound;
  if (text.includes("invalid") || text.includes("required")) return ERROR_CODES.invalidArgument;
  return ERROR_CODES.toolFailed;
}

function parseArguments(raw: unknown): unknown {
  // `json.loads(arguments or "{}")`; non-string input raises TypeError there.
  if (!pyTruthy(raw)) return {};
  if (typeof raw !== "string") return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** Short path/argv label for a tool call. Never file contents. */
export function toolSubject(name: string, rawArguments: unknown): string {
  const args = parseArguments(rawArguments);
  if (!isDict(args)) return "";
  let subject: unknown = "";
  if (name === "read" || name === "list" || name === "write" || name === "edit") {
    subject = pyGet(args, "path", "");
  } else if (name === "glob" || name === "grep") {
    subject = pyGet(args, "path", ".");
  } else if (name === "exec") {
    const argv = pyGet(args, "argv", []);
    const valid = Array.isArray(argv) && argv.every((item) => typeof item === "string");
    subject = valid ? pyJsonDumps(argv, { separators: [",", ":"] }) : "";
  }
  return pySlice(pyStr(subject), 200);
}

function userContent(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  return content
    .filter((item): item is Dict => isDict(item) && pyGet(item, "type") === "text" && typeof pyGet(item, "text") === "string")
    .map((item) => item.text as string)
    .join("\n");
}

function completionFields(record: Dict): Dict {
  const evidence = pyGet(record, "evidence");
  const count = pyGet(record, "evidence_count");
  const evidenceCount = typeof count === "number" && Number.isInteger(count) && count >= 0
    ? count
    : Array.isArray(evidence) ? evidence.length : 0;
  const fields: Dict = {
    verified: pyGet(record, "verified") === true,
    summary: pySlice(pyStr(pyGet(record, "summary", "")), 500),
    evidenceCount,
  };
  const optional: Array<[string, string, readonly string[]]> = [
    ["status", "status", ["verified", "unverified", "not_applicable", "incomplete"]],
    ["tool_execution_status", "toolExecutionStatus", ["succeeded", "failed", "incomplete", "not_applicable"]],
    ["delivery_status", "deliveryStatus", ["passed", "failed", "not_assessed"]],
  ];
  for (const [source, target, allowed] of optional) {
    const value = pyGet(record, source);
    if (typeof value === "string" && allowed.includes(value)) fields[target] = value;
  }
  const turnId = pyGet(record, "turn_id");
  if (isTurnId(turnId)) fields.turnId = turnId;
  return fields;
}

function completionsByTurn(history: unknown): Map<string, Dict[]> {
  const byTurn = new Map<string, Dict[]>();
  if (!Array.isArray(history)) return byTurn;
  for (const record of history.slice(-200)) {
    if (!isDict(record)) continue;
    const turnId = pyGet(record, "turn_id");
    if (!isTurnId(turnId)) continue;
    const list = byTurn.get(turnId) ?? [];
    list.push(record);
    byTurn.set(turnId, list);
  }
  return byTurn;
}

/** Deterministically derive the v1 event list from a stored session journal. */
export function deriveEvents(session: Dict): DerivedEvent[] {
  const sessionId = pyStr(pyGet(session, "id", ""));
  const out: DerivedEvent[] = [];
  const emit = (type: string, fields: Dict): void => {
    out.push({ schema: XUENESS_EVENT_SCHEMA, seq: out.length + 1, sessionId, type, ...fields });
  };

  emit("session.status", {
    status: pyGet(session, "status"),
    steps: pyGet(session, "steps", 0),
    mode: pyTruthy(pyGet(session, "mode")) ? pyGet(session, "mode") : "",
  });

  const rawResults = pyGet(session, "results");
  const results: Dict = isDict(rawResults) ? rawResults : {};
  const subjects = new Map<string, string>();
  const names = new Map<string, string>();
  const rawMessages = pyGet(session, "messages");
  const messages = Array.isArray(rawMessages) ? rawMessages : [];
  const byTurn = completionsByTurn(pyGet(session, "completion_history"));
  let turn = 1n;
  const turnId = (): string => `turn-${turn}`;
  const settleTurn = (): void => {
    for (const record of byTurn.get(turnId()) ?? []) emit("session.completion", completionFields(record));
  };

  let firstUserSeen = false;
  for (const message of messages) {
    if (!isDict(message)) continue;
    const role = pyGet(message, "role");
    if (role === "assistant") {
      const calls = pyGet(message, "tool_calls");
      for (const call of Array.isArray(calls) ? calls : []) {
        if (!isDict(call)) continue;
        const fn = pyGet(call, "function", {});
        const fnDict: Dict = isDict(fn) ? fn : {};
        const name = pyStr(pyGet(fnDict, "name", ""));
        const subject = toolSubject(name, pyGet(fnDict, "arguments", ""));
        const callId = pyStr(pyGet(call, "id", ""));
        subjects.set(callId, subject);
        names.set(callId, name);
        emit("tool.call", { turnId: turnId(), toolCallId: callId, name, subject });
      }
      const content = pyGet(message, "content");
      if (pyTruthy(content)) emit("assistant.text", { turnId: turnId(), preview: pySlice(pyStr(content), 500) });
    } else if (role === "tool") {
      const callId = pyStr(pyGet(message, "tool_call_id", ""));
      const result = pyGet(results, callId, {});
      const ok = isDict(result) ? pyTruthy(pyGet(result, "ok")) : false;
      const error = isDict(result) ? pySlice(pyStr(pyGet(result, "error", "")), 120) : "";
      emit("tool.result", {
        turnId: turnId(), toolCallId: callId, name: names.get(callId) ?? "", subject: subjects.get(callId) ?? "",
        ok, errorCode: errorCode(ok, error), error,
      });
    } else if (role === "user") {
      const explicit = pyGet(message, "_turn_id");
      if (!firstUserSeen) {
        // The first user message is the task itself and never becomes turn.user.
        firstUserSeen = true;
        if (isTurnId(explicit)) turn = BigInt(explicit.slice(5));
        continue;
      }
      if (pyGet(message, "_input_kind") !== "guide") {
        settleTurn();
        turn = isTurnId(explicit) ? BigInt(explicit.slice(5)) : turn + 1n;
      }
      const content = userContent(pyGet(message, "content", ""));
      emit("turn.user", { turnId: turnId(), preview: pySlice(pyStr(content), 500) });
    }
  }

  const completion = pyGet(session, "completion");
  settleTurn();
  if (isDict(completion) && pyTruthy(completion)) {
    const completionTurn = pyGet(completion, "turn_id");
    if (!(typeof completionTurn === "string" && byTurn.has(completionTurn))) {
      emit("session.completion", completionFields(completion));
    }
  }
  const pending = pyGet(session, "pending_question");
  if (pyTruthy(pending)) emit("session.pending_question", { question: pySlice(pyStr(pending), 1000) });
  return out;
}

/** Highest `seq` in a derived list (0 when empty). */
export function headSeq(events: readonly DerivedEvent[]): number {
  return events.length ? (events[events.length - 1] as DerivedEvent).seq : 0;
}

/** Build the v1 envelope for a cursor/limit window (`page_events`). */
export function pageEvents(session: Dict, events: readonly DerivedEvent[], cursor: number, limit: number): DerivedEnvelope {
  const window = Math.max(1, Math.min(Math.trunc(limit), MAX_EVENTS_LIMIT));
  const from = Math.trunc(cursor);
  const remaining = events.filter((event) => event.seq > from);
  const page = remaining.slice(0, window);
  return {
    schema: XUENESS_EVENTS_SCHEMA,
    protocolVersion: XUENESS_PROTOCOL_VERSION,
    sessionId: pyStr(pyGet(session, "id", "")),
    status: pyGet(session, "status"),
    steps: pyGet(session, "steps", 0),
    mode: pyTruthy(pyGet(session, "mode")) ? pyGet(session, "mode") : "",
    events: page,
    cursor: from,
    nextCursor: page.length ? (page[page.length - 1] as DerivedEvent).seq : from,
    head: headSeq(events),
    hasMore: remaining.length > page.length,
  };
}

/** Render events as a Server-Sent Events body, byte-identical to `sse_body`. */
export function sseBody(events: readonly DerivedEvent[]): string {
  const chunks: string[] = [];
  for (const event of events) {
    chunks.push("id: " + pyStr(pyGet(event, "seq", "")));
    chunks.push("event: " + pyStr(pyGet(event, "type", "message")));
    chunks.push("data: " + pyJsonDumps(event));
    chunks.push("");
  }
  return chunks.length ? chunks.join("\n") + "\n" : "";
}
