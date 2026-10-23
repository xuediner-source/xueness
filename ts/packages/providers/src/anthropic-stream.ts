/** Anthropic Messages stream parsing and compatibility state. */
import {
  PyTypeError, PyValueError, isDict, pyAdd, pyDictGet, pyHashKey, pyJoin, pyJsonDumps, pyJsonLoads, pySlice,
  pySortKeys, pyTruthy, pyTypeName,
} from "@xueness/contracts";
import { ProviderTransportError, notifyStreamCallback } from "./errors.ts";
import type { HttpResponse } from "./http.ts";
import { finishReason, reportedModel, reportedUsage, type Usage } from "./metadata.ts";
import { normalizeModelToolArguments } from "./tool-input-normalization.ts";
import { readSse } from "./sse.ts";
import { raiseStreamError } from "./transport.ts";
import type { StreamObservers, StreamResult, ToolSnapshot } from "./streams.ts";

type Dict = Record<string, unknown>;

interface Slot {
  key: unknown;
  block: Dict;
}

/** A Python dict keyed by arbitrary hashable JSON values (the original key is kept). */
class PyKeyedBlocks {
  readonly #slots = new Map<string, Slot>();

  set(key: unknown, block: Dict): void {
    const hash = pyHashKey(key);
    const slot = this.#slots.get(hash);
    if (slot) slot.block = block;
    else this.#slots.set(hash, { key, block });
  }

  get(key: unknown): Dict | undefined {
    return this.#slots.get(pyHashKey(key))?.block;
  }

  delete(key: unknown): void {
    this.#slots.delete(pyHashKey(key));
  }

  setdefault(key: unknown, block: Dict): Dict {
    const hash = pyHashKey(key);
    const slot = this.#slots.get(hash);
    if (slot) return slot.block;
    this.#slots.set(hash, { key, block });
    return block;
  }

  sorted(): Dict[] {
    const byKey = new Map([...this.#slots.values()].map((slot) => [slot.key, slot.block]));
    return pySortKeys([...byKey.keys()]).map((key) => byKey.get(key) as Dict);
  }

  clear(): void {
    this.#slots.clear();
  }
}

export interface AnthropicStreamOptions extends StreamObservers {
  markDelivered: () => void;
  finishMetadata?: Dict | null;
  idleTimeoutMs?: number;
  signal?: AbortSignal | null;
}

const incomplete = (message: string): ProviderTransportError =>
  new ProviderTransportError("connection_failed", "ConnectionError", message);

/** `_read_anthropic_stream`: Messages API events into the journal's reply shape. */
export async function readAnthropicStream(
  response: HttpResponse,
  options: AnthropicStreamOptions,
): Promise<StreamResult> {
  const { markDelivered, finishMetadata = null } = options;
  const textParts: unknown[] = [];
  const blocks = new PyKeyedBlocks();
  const suppressedIndexes = new Set<string>();
  const toolIdsByIndex = new Map<string, string>();
  const toolIndexesById = new Map<string, string>();
  let stopped = false;
  const usage: Usage = {};
  const orEmpty = (value: unknown): unknown => (pyTruthy(value) ? value : {});

  for await (const payload of readSse(response, { idleTimeoutMs: options.idleTimeoutMs, signal: options.signal })) {
    const event = pyJsonLoads(payload);
    if (!isDict(event)) throw new PyValueError("provider SSE event must be an object");
    const kind = get(event, "type");
    if (kind === "error" || get(event, "error") !== null) raiseStreamError(event);
    if (kind === "message_start") {
      blocks.clear();
      suppressedIndexes.clear();
      toolIdsByIndex.clear();
      toolIndexesById.clear();
      reportedModel(finishMetadata, pyDictGet(orEmpty(get(event, "message")), "model"));
      Object.assign(usage, reportedUsage(orEmpty(pyDictGet(orEmpty(get(event, "message")), "usage"))));
    } else if (kind === "message_delta") {
      Object.assign(usage, reportedUsage(orEmpty(get(event, "usage"))));
      const reason = finishReason(pyDictGet(orEmpty(get(event, "delta")), "stop_reason"));
      if (reason !== null && finishMetadata) finishMetadata["_finish_reason"] = reason;
    }

    if (kind === "content_block_start") {
      const index = get(event, "index", 0);
      const indexKey = pyHashKey(index);
      if (suppressedIndexes.has(indexKey)) continue;
      const block = orEmpty(get(event, "content_block"));
      const type = pyDictGet(block, "type");
      if (type === "tool_result") {
        blocks.delete(index);
        suppressedIndexes.add(indexKey);
        continue;
      }
      if (type === "tool_use") {
        const id = pyDictGet(block, "id", "");
        assertToolCallIdentity(indexKey, id, toolIdsByIndex, toolIndexesById);
        blocks.set(index, {
          type: "tool_use", id, name: pyDictGet(block, "name", ""),
          input: pyDictGet(block, "input"), json: "", closed: false,
        });
        if (options.onToolDelta) {
          notifyToolSnapshot(options.onToolDelta, markDelivered, index, id, pyDictGet(block, "name", ""), "");
        }
      } else if (type === "thinking" || type === "reasoning") {
        const initial = pyDictGet(block, "thinking", pyDictGet(block, "text", ""));
        blocks.set(index, {
          type: "reasoning", thinking: initial,
          startSignature: pyDictGet(block, "signature"), hasNativeSignatureDelta: false, nativeSignature: "",
        });
        if (typeof initial === "string" && initial && options.onReasoningDelta) {
          markDelivered();
          notifyStreamCallback(options.onReasoningDelta, initial);
        }
      } else if (type === "redacted_thinking") {
        blocks.set(index, { type: "redacted_thinking", data: pyDictGet(block, "data") });
      } else {
        blocks.set(index, { type: "text", text: pyDictGet(block, "text", "") });
      }
    } else if (kind === "content_block_delta") {
      const index = get(event, "index", 0);
      const indexKey = pyHashKey(index);
      if (suppressedIndexes.has(indexKey)) continue;
      const delta = orEmpty(get(event, "delta"));
      const block = blocks.setdefault(index, { type: "text", text: "" });
      if (block["type"] === "tool_use" && block["closed"] === true) continue;
      const type = pyDictGet(delta, "type");
      if (type === "text_delta") {
        const raw = pyDictGet(delta, "text");
        const value = pyTruthy(raw) ? raw : "";
        block["text"] = pyAdd(get(block, "text", ""), value);
        textParts.push(value);
        if (pyTruthy(value)) {
          markDelivered();
          if (options.onDelta) notifyStreamCallback(options.onDelta, value);
        }
      } else if (type === "thinking_delta" || type === "reasoning_delta") {
        const value = pyDictGet(delta, "thinking", pyDictGet(delta, "reasoning", pyDictGet(delta, "text", "")));
        if (typeof value === "string") block["thinking"] = pyAdd(get(block, "thinking", ""), value);
        if (typeof value === "string" && value && options.onReasoningDelta) {
          markDelivered();
          notifyStreamCallback(options.onReasoningDelta, value);
        }
      } else if (type === "signature_delta" && block["type"] === "reasoning") {
        const signature = pyDictGet(delta, "signature");
        if (typeof signature === "string") {
          block["hasNativeSignatureDelta"] = true;
          block["nativeSignature"] = pyAdd(get(block, "nativeSignature", ""), signature);
        }
      } else if (type === "input_json_delta") {
        const partial = pyDictGet(delta, "partial_json");
        block["json"] = pyAdd(get(block, "json", ""), pyTruthy(partial) ? partial : "");
        if (options.onToolDelta && block["type"] === "tool_use") {
          notifyToolSnapshot(options.onToolDelta, markDelivered, index, get(block, "id", ""), get(block, "name", ""), block["json"]);
        }
      }
    } else if (kind === "content_block_stop") {
      const index = get(event, "index", 0);
      const indexKey = pyHashKey(index);
      if (suppressedIndexes.delete(indexKey)) {
        blocks.delete(index);
        continue;
      }
      const block = blocks.get(index);
      if (block) block["closed"] = true;
    } else if (kind === "message_stop") {
      stopped = true;
      break;
    }
  }

  if (!stopped) throw incomplete("incomplete provider stream");
  const calls: Dict[] = [];
  const reasoningBlocks: Dict[] = [];
  for (const block of blocks.sorted()) {
    appendReasoningMetadata(block, reasoningBlocks);
    if (block["type"] !== "tool_use" || block["closed"] !== true) continue;
    let args: unknown;
    if (pyTruthy(get(block, "json"))) {
      const text = block["json"];
      if (typeof text !== "string") throw new PyTypeError(`the JSON object must be str, bytes or bytearray, not ${pyTypeName(text)}`);
      try {
        pyJsonLoads(text);
      } catch {
        const finish = finishMetadata ? get(finishMetadata, "_finish_reason") : null;
        // A cut-off argument is not a repair opportunity: keep the termination and text only.
        if (finish !== null && finish !== "stop" && finish !== "tool_calls") continue;
      }
      args = text;
    } else {
      args = get(block, "input");
    }
    calls.push({
      id: get(block, "id", ""), type: "function",
      function: { name: get(block, "name", ""), arguments: normalizeModelToolArguments(args) },
    });
  }
  if (finishMetadata) finishMetadata["_reasoning_blocks"] = reasoningBlocks;
  if ("prompt_tokens" in usage && "completion_tokens" in usage) {
    usage["total_tokens"] = (usage["prompt_tokens"] as number) + (usage["completion_tokens"] as number);
  }
  return { text: pyJoin(textParts), calls, usage };
}

function assertToolCallIdentity(
  indexKey: string,
  id: unknown,
  idsByIndex: Map<string, string>,
  indexesById: Map<string, string>,
): void {
  if (typeof id !== "string" || id.length === 0) return;
  const previousId = idsByIndex.get(indexKey);
  if (previousId !== undefined) {
    throw new PyValueError(previousId === id ? "duplicate tool call identity" : "conflicting tool call identity");
  }
  if (indexesById.has(id)) throw new PyValueError("duplicate tool call ID");
  idsByIndex.set(indexKey, id);
  indexesById.set(id, indexKey);
}

function appendReasoningMetadata(block: Dict, output: Dict[]): void {
  if (block["closed"] !== true) return;
  if (block["type"] === "redacted_thinking") {
    if (typeof block["data"] === "string") output.push({ type: "redacted_thinking", data: block["data"] });
    return;
  }
  if (block["type"] !== "reasoning") return;
  const signature = block["hasNativeSignatureDelta"] ? block["nativeSignature"] : block["startSignature"];
  if (typeof block["thinking"] !== "string" || typeof signature !== "string" || signature.length === 0) return;
  output.push({ type: "thinking", thinking: block["thinking"], signature });
}

/** Keep tool snapshots bounded and display-only; observer failures do not affect parsing. */
function notifyToolSnapshot(
  callback: (snapshot: ToolSnapshot) => unknown,
  markDelivered: () => void,
  index: unknown,
  callId: unknown,
  name: unknown,
  args: unknown,
): void {
  markDelivered();
  try {
    callback({
      index, call_id: sliceValue(callId, 256), name: sliceValue(name, 128), partial_input: sliceValue(args, 4096),
      input_chars: lengthOf(args), truncated: lengthOf(args) > 4096,
    });
  } catch {
    // Observers are display-only (Python's `except Exception: pass`).
  }
}

function sliceValue(value: unknown, count: number): unknown {
  if (typeof value === "string") return pySlice(value, count);
  if (Array.isArray(value)) return value.slice(0, count);
  throw new PyTypeError(`'${pyTypeName(value)}' object is not subscriptable`);
}

function lengthOf(value: unknown): number {
  if (typeof value === "string") return Array.from(value).length;
  if (Array.isArray(value)) return value.length;
  if (isDict(value)) return Object.keys(value).length;
  throw new PyTypeError(`object of type '${pyTypeName(value)}' has no len()`);
}

function get(record: Dict, key: string, fallback: unknown = null): unknown {
  return Object.hasOwn(record, key) ? record[key] : fallback;
}

