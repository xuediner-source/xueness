/**
 * Streaming reply parsers: `_read_openai_stream` and `_read_anthropic_stream`.
 * Python's operators are reproduced through the `py*` helpers so malformed
 * events fail with the same exception family (and therefore stage).
 */
import {
  PyTypeError, PyValueError, isDict, pyDictGet, pyJsonLoads, pySlice, pyTruthy, pyTypeName,
} from "@xueness/contracts";
import { ProviderTransportError, notifyStreamCallback } from "./errors.ts";
import type { HttpResponse } from "./http.ts";
import { finishReason, reportedModel, reportedUsage, type Usage } from "./metadata.ts";
import { readSse } from "./sse.ts";
import { NativeCallAssembler, type AssembledCall } from "./tool-protocol.ts";
import { raiseStreamError } from "./transport.ts";

type Dict = Record<string, unknown>;

export interface ToolSnapshot {
  index: unknown;
  call_id: unknown;
  name: unknown;
  partial_input: unknown;
  input_chars: number;
  truncated: boolean;
}

export interface StreamObservers {
  onDelta?: ((text: unknown) => unknown) | null;
  onReasoningDelta?: ((text: unknown) => unknown) | null;
  onToolDelta?: ((snapshot: ToolSnapshot) => unknown) | null;
}

export interface StreamResult {
  text: string;
  calls: Dict[];
  usage: Usage | null;
}

function get(record: Dict, key: string, fallback: unknown = null): unknown {
  return Object.hasOwn(record, key) ? record[key] : fallback;
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

/** `_notify_tool_snapshot`: display-only facts; a failing observer never loses the call. */
export function notifyToolSnapshot(
  callback: (snapshot: ToolSnapshot) => unknown, markDelivered: () => void,
  index: unknown, callId: unknown, name: unknown, args: unknown,
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

const incomplete = (message: string): ProviderTransportError => new ProviderTransportError("connection_failed", "ConnectionError", message);

export interface OpenAiStreamOptions extends StreamObservers {
  markDelivered: () => void;
  requireDone?: boolean;
  finishMetadata?: Dict | null;
  idleTimeoutMs?: number;
  signal?: AbortSignal | null;
}

/** `_read_openai_stream`: text, assembled native calls and usage. */
export async function readOpenAiStream(response: HttpResponse, options: OpenAiStreamOptions): Promise<StreamResult> {
  const { markDelivered, finishMetadata = null } = options;
  const textParts: string[] = [];
  const calls = new NativeCallAssembler();
  let finished = false;
  let doneMarker = false;
  let usage: Usage | null = null;
  for await (const payload of readSse(response, { idleTimeoutMs: options.idleTimeoutMs, signal: options.signal })) {
    if (payload === "[DONE]") {
      finished = true;
      doneMarker = true;
      break;
    }
    const item = pyJsonLoads(payload);
    if (!isDict(item)) throw new PyValueError("provider SSE event must be an object");
    if (get(item, "error") !== null) raiseStreamError(item);
    reportedModel(finishMetadata, get(item, "model"));
    const rawUsage = get(item, "usage");
    if (isDict(rawUsage)) usage = { ...(usage ?? {}), ...reportedUsage(rawUsage) };
    const rawChoices = get(item, "choices");
    const choices = pyTruthy(rawChoices) ? rawChoices : [];
    if (!Array.isArray(choices)) throw new PyValueError("provider SSE choices must be a list");
    if (!choices.length) continue;
    const choice = choices[0];
    if (!isDict(choice)) throw new PyValueError("invalid provider SSE choice");
    const rawDelta = get(choice, "delta");
    const delta = pyTruthy(rawDelta) ? rawDelta : {};
    if (!isDict(delta)) throw new PyValueError("provider SSE delta must be an object");
    if (finished && ["content", "tool_calls", "reasoning_content", "reasoning", "thinking"].some((key) => pyTruthy(get(delta, key)))) {
      throw new PyValueError("provider SSE payload after completion");
    }
    if (get(choice, "finish_reason") !== null) {
      finished = true;
      calls.close();
      if (finishMetadata) finishMetadata["_finish_reason"] = finishReason(choice["finish_reason"]);
    }
    // Compatible APIs name reasoning differently; it only reaches the opt-in observer.
    for (const key of ["reasoning_content", "reasoning", "thinking"]) {
      const reasoning = get(delta, key);
      if (typeof reasoning === "string" && reasoning && options.onReasoningDelta) {
        markDelivered();
        notifyStreamCallback(options.onReasoningDelta, reasoning);
      }
    }
    const content = get(delta, "content");
    if (typeof content === "string" && content) {
      textParts.push(content);
      markDelivered();
      if (options.onDelta) notifyStreamCallback(options.onDelta, content);
    }
    const fragments = get(delta, "tool_calls");
    if (fragments !== null) {
      calls.add(fragments);
      if (options.onToolDelta) {
        const indexes = [...new Set((fragments as Dict[]).map((fragment) => get(fragment, "index", 0) as number))];
        for (const index of indexes) {
          const call = calls.calls.get(index) as AssembledCall;
          notifyToolSnapshot(options.onToolDelta, markDelivered, index, call.id, call.function.name, call.function.arguments);
        }
      }
    }
  }
  if (!finished) throw incomplete("incomplete provider stream");
  if (options.requireDone && !doneMarker) throw incomplete("provider stream ended without the required done marker");
  return { text: textParts.join(""), calls: calls.finish(true) as unknown as Dict[], usage };
}

export { readAnthropicStream } from "./anthropic-stream.ts";
export type { AnthropicStreamOptions } from "./anthropic-stream.ts";
