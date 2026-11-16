/** OpenAI Responses API & endpoint URL resolution helpers for full-URL or gateway profiles. */
import { PyValueError, isDict, pyJsonDumps, pyJsonLoads } from "@xueness/contracts";
import { ProviderTransportError, notifyStreamCallback } from "./errors.ts";
import type { HttpResponse } from "./http.ts";
import { reportedModel, reportedUsage, type Usage } from "./metadata.ts";
import { readSse } from "./sse.ts";
import { normalizeModelToolArguments } from "./tool-input-normalization.ts";
import { notifyToolSnapshot, type OpenAiStreamOptions, type StreamResult } from "./streams.ts";
import { raiseStreamError } from "./transport.ts";

type Dict = Record<string, unknown>;
const stripTrailingSlashes = (base: string): string => base.replace(/\/+$/u, "");
export const isResponsesEndpoint = (base: string): boolean => /\/responses$/iu.test(stripTrailingSlashes(base));
export const chatCompletionsUrl = (base: string): string => { const c = stripTrailingSlashes(base); return /\/chat\/completions$/iu.test(c) ? c : `${c}/chat/completions`; };
export const responsesUrl = (base: string): string => { const c = stripTrailingSlashes(base); return /\/responses$/iu.test(c) ? c : `${c}/responses`; };
export const anthropicMessagesUrl = (base: string): string => {
  const c = stripTrailingSlashes(base);
  if (/\/messages$/iu.test(c)) return c;
  return /\/anthropic$/iu.test(c) ? `${c}/v1/messages` : `${c}/messages`;
};
export const modelsDiscoveryUrl = (base: string): string => `${stripTrailingSlashes(base).replace(/\/(?:chat\/completions|responses)$/iu, "")}/models`;

function partText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter(isDict).filter((p) => p.type === "text" && typeof p.text === "string").map((p) => String(p.text)).join("\n");
}

function toResponsesContent(content: unknown, assistant = false): unknown {
  if (!Array.isArray(content)) return typeof content === "string" ? content : "";
  return content.filter(isDict).flatMap((part): Dict[] => {
    if (part.type === "text") return [{ type: assistant ? "output_text" : "input_text", text: String(part.text ?? "") }];
    if (part.type === "image_url") {
      const url = isDict(part.image_url) ? part.image_url.url : part.image_url;
      return typeof url === "string" && url ? [{ type: "input_image", image_url: url }] : [];
    }
    if (part.type === "file" && isDict(part.file)) {
      return [{ type: "input_file", filename: String(part.file.filename ?? "document.pdf"), file_data: String(part.file.file_data ?? "") }];
    }
    return [];
  });
}

/** Convert an OpenAI Chat Completions payload into an OpenAI Responses API payload. */
export function buildResponsesPayload(chat: Dict): Dict {
  const raw = Array.isArray(chat.messages) ? chat.messages.filter(isDict) : [];
  const instructions: string[] = [];
  let idx = 0;
  while (idx < raw.length && raw[idx]!.role === "system") {
    const text = partText(raw[idx]!.content).trim();
    if (text) instructions.push(text);
    idx += 1;
  }
  const input: Dict[] = [];
  for (const msg of raw.slice(idx)) {
    const role = msg.role;
    if (role === "assistant") {
      const text = partText(msg.content);
      if (text) input.push({ role: "assistant", content: text });
      const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls.filter(isDict) : [];
      for (const call of calls) {
        const fn = isDict(call.function) ? call.function : {};
        const args = fn.arguments;
        input.push({
          type: "function_call", call_id: String(call.id ?? ""), name: String(fn.name ?? ""),
          arguments: typeof args === "string" ? args : pyJsonDumps(args ?? {}),
        });
      }
    } else if (role === "tool") {
      input.push({
        type: "function_call_output", call_id: String(msg.tool_call_id ?? ""),
        output: typeof msg.content === "string" ? msg.content : pyJsonDumps(msg.content ?? ""),
      });
    } else if (role === "user" || role === "developer" || role === "system") {
      input.push({ role: role === "system" ? "developer" : role, content: toResponsesContent(msg.content) });
    }
  }
  // The whole history is sent on every request, so nothing needs to be kept on the provider's side.
  const body: Dict = { model: chat.model, input, store: false };
  if (instructions.length) body.instructions = instructions.join("\n\n");
  if (Array.isArray(chat.tools)) {
    body.tools = chat.tools.filter(isDict).map((tool) => {
      const fn = isDict(tool.function) ? tool.function : tool;
      const out: Dict = { type: "function", name: fn.name, parameters: fn.parameters ?? { type: "object", properties: {} } };
      if (typeof fn.description === "string" && fn.description) out.description = fn.description;
      if (fn.strict === true) out.strict = true;
      return out;
    });
  }
  if (chat.stream === true) body.stream = true;
  for (const key of ["parallel_tool_calls", "temperature", "top_p"] as const) {
    if (Object.hasOwn(chat, key)) body[key] = chat[key];
  }
  if (Object.hasOwn(chat, "tool_choice")) {
    // Chat Completions names a forced function as {type, function: {name}}; Responses wants {type, name}.
    const choice = chat.tool_choice;
    body.tool_choice = isDict(choice) && choice.type === "function" && isDict(choice.function) ? { type: "function", name: choice.function.name } : choice;
  }
  const limit = chat.max_completion_tokens ?? chat.max_tokens;
  if (typeof limit === "number" && Number.isInteger(limit)) body.max_output_tokens = Math.max(16, limit);
  if (typeof chat.reasoning_effort === "string") body.reasoning = { effort: chat.reasoning_effort };
  return body;
}

function responsesUsage(raw: unknown): Usage | null {
  if (!isDict(raw)) return null;
  const shaped: Dict = { ...raw };
  if (isDict(raw.input_tokens_details)) shaped.prompt_tokens_details = raw.input_tokens_details;
  if (isDict(raw.output_tokens_details)) shaped.completion_tokens_details = raw.output_tokens_details;
  const usage = reportedUsage(shaped);
  if ("prompt_tokens" in usage && "completion_tokens" in usage) usage.total_tokens = (usage.prompt_tokens as number) + (usage.completion_tokens as number);
  return Object.keys(usage).length ? usage : null;
}

function responsesFinish(resp: Dict, hasCalls: boolean): string {
  if (hasCalls) return "tool_calls";
  if (resp.status === "incomplete") {
    const why = isDict(resp.incomplete_details) ? resp.incomplete_details.reason : null;
    return why === "content_filter" ? "content_filter" : "length";
  }
  return "stop";
}

/** Parse a non-streamed Responses API JSON object into Xueness's normalized assistant reply. */
export function parseResponsesBody(payload: unknown): Dict {
  if (!isDict(payload)) throw new PyValueError("invalid provider response");
  const resp = isDict(payload.response) ? payload.response : payload;
  if (!Array.isArray(resp.output)) throw new PyValueError("invalid Responses API output");
  const texts: string[] = [];
  const calls: Dict[] = [];
  for (const item of resp.output) {
    if (!isDict(item)) continue;
    if (item.type === "message" && Array.isArray(item.content)) {
      for (const part of item.content) {
        if (isDict(part) && (part.type === "output_text" || part.type === "text") && typeof part.text === "string") texts.push(part.text);
      }
    } else if (item.type === "function_call") {
      calls.push({
        id: String(item.call_id ?? item.id ?? ""), type: "function",
        function: { name: String(item.name ?? ""), arguments: normalizeModelToolArguments(item.arguments ?? "{}") },
      });
    }
  }
  const result: Dict = { role: "assistant", content: texts.join(""), tool_calls: calls, _finish_reason: responsesFinish(resp, calls.length > 0) };
  reportedModel(result, resp.model);
  const usage = responsesUsage(resp.usage);
  if (usage) result._usage = usage;
  return result;
}

/** Read an OpenAI Responses API SSE stream into Xueness's StreamResult shape. */
export async function readResponsesStream(response: HttpResponse, options: OpenAiStreamOptions): Promise<StreamResult> {
  const { markDelivered, finishMetadata = null } = options;
  const textParts: string[] = [];
  const slots = new Map<string, { order: number; id: string; name: string; arguments: string }>();
  let usage: Usage | null = null;
  let finished = false;
  let order = 0;

  for await (const payload of readSse(response, { idleTimeoutMs: options.idleTimeoutMs, signal: options.signal })) {
    if (payload === "[DONE]") { finished = true; break; }
    const event = pyJsonLoads(payload);
    if (!isDict(event)) throw new PyValueError("provider SSE event must be an object");
    const kind = event.type;
    if (kind === "error" || kind === "response.failed" || event.error != null) raiseStreamError(event);
    if (kind === "response.output_text.delta" && typeof event.delta === "string" && event.delta) {
      textParts.push(event.delta);
      markDelivered();
      if (options.onDelta) notifyStreamCallback(options.onDelta, event.delta);
    } else if ((kind === "response.reasoning_summary_text.delta" || kind === "response.reasoning_text.delta") && typeof event.delta === "string" && event.delta) {
      if (options.onReasoningDelta) { markDelivered(); notifyStreamCallback(options.onReasoningDelta, event.delta); }
    } else if (kind === "response.output_item.added" && isDict(event.item) && event.item.type === "function_call") {
      const item = event.item;
      const key = String(item.id ?? item.call_id ?? event.output_index ?? order);
      if (!slots.has(key)) slots.set(key, { order: order++, id: String(item.call_id ?? item.id ?? ""), name: String(item.name ?? ""), arguments: typeof item.arguments === "string" ? item.arguments : "" });
      const slot = slots.get(key)!;
      if (options.onToolDelta) notifyToolSnapshot(options.onToolDelta, markDelivered, slot.order, slot.id, slot.name, slot.arguments);
    } else if (kind === "response.function_call_arguments.delta" && typeof event.delta === "string") {
      const key = String(event.item_id ?? event.output_index ?? 0);
      const slot = slots.get(key);
      if (slot) {
        slot.arguments += event.delta;
        if (options.onToolDelta) notifyToolSnapshot(options.onToolDelta, markDelivered, slot.order, slot.id, slot.name, slot.arguments);
      }
    } else if (kind === "response.output_item.done" && isDict(event.item) && event.item.type === "function_call") {
      const item = event.item;
      const key = String(item.id ?? item.call_id ?? event.output_index ?? order);
      const slot = slots.get(key) ?? { order: order++, id: String(item.call_id ?? item.id ?? ""), name: String(item.name ?? ""), arguments: "" };
      if (!slot.id) slot.id = String(item.call_id ?? item.id ?? "");
      if (!slot.name) slot.name = String(item.name ?? "");
      if (!slot.arguments && typeof item.arguments === "string") slot.arguments = item.arguments;
      slots.set(key, slot);
    } else if ((kind === "response.completed" || kind === "response.incomplete") && isDict(event.response)) {
      finished = true;
      reportedModel(finishMetadata, event.response.model);
      const nextUsage = responsesUsage(event.response.usage);
      if (nextUsage) usage = { ...(usage ?? {}), ...nextUsage };
      if (finishMetadata) finishMetadata._finish_reason = responsesFinish(event.response, slots.size > 0);
    }
  }
  if (!finished) throw new ProviderTransportError("connection_failed", "ConnectionError", "incomplete provider stream");
  const calls: Dict[] = [...slots.values()].sort((a, b) => a.order - b.order).map((slot) => ({
    id: slot.id, type: "function", function: { name: slot.name, arguments: normalizeModelToolArguments(slot.arguments || "{}") },
  }));
  return { text: textParts.join(""), calls, usage };
}
