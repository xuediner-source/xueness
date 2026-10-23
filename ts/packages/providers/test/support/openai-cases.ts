/** OpenAI-compatible differential cases: streams, fallbacks, retries and failures. */
import {
  JPEG_B64, MARKER, MESSAGES, PNG_B64, SSE_HEAD, TEXT_STREAM, TOOLS, USAGE_CHUNK, chunk, events, json, raw, sse,
  type ProviderCase,
} from "./http-fixtures.ts";

const call = (index: number, extra: Record<string, unknown>) => chunk({ tool_calls: [{ index, ...extra }] });
const OK_JSON = { id: "x", choices: [{ index: 0, message: { role: "assistant", content: "done ✓" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } };
const TOOL_STREAM = sse([
  call(0, { id: "call_1", type: "function", function: { name: "read", arguments: "" } }),
  call(0, { function: { arguments: "{\"path\": " } }),
  call(0, { function: { arguments: "\"a.txt\"}" } }),
  call(1, { id: "call_2", type: "function", function: { name: "read", arguments: "{\"path\":\"b\"}" } }),
  chunk({}, "tool_calls"), USAGE_CHUNK,
]);

const stream = (id: string, extra: Partial<ProviderCase>): ProviderCase => ({ id, provider: "openai", method: "stream", ...extra });
const complete = (id: string, extra: Partial<ProviderCase>): ProviderCase => ({ id, provider: "openai", method: "complete", ...extra });

export const OPENAI_STREAM_CASES: ProviderCase[] = [
  stream("o-text", { responses: [TEXT_STREAM] }),
  stream("o-reasoning", { responses: [sse([chunk({ reasoning_content: "think " }), chunk({ reasoning: "more" }),
    chunk({ content: "answer" }), chunk({}, "stop")])] }),
  stream("o-tools", { tools: TOOLS, responses: [TOOL_STREAM] }),
  stream("o-tools-unobserved", { tools: TOOLS, callbacks: { tool: "none", reasoning: "none" }, responses: [TOOL_STREAM] }),
  stream("o-tool-observer-raises", { tools: TOOLS, callbacks: { tool: "raise" }, responses: [TOOL_STREAM] }),
  stream("o-tool-noncontiguous", { tools: TOOLS, responses: [sse([
    call(1, { id: "b", function: { name: "read", arguments: "{}" } }), call(0, { id: "a", function: { name: "read", arguments: "{}" } }),
    chunk({}, "tool_calls")])] }),
  stream("o-tool-conflict", { tools: TOOLS, responses: [sse([call(0, { id: "a", function: { name: "read", arguments: "{" } }),
    call(0, { id: "b", function: { arguments: "}" } }), chunk({}, "tool_calls")])] }),
  stream("o-tool-bad-arguments", { tools: TOOLS, responses: [sse([call(0, { id: "a", function: { name: "read", arguments: "{\"path\": NaN}" } }),
    chunk({}, "tool_calls")])] }),
  stream("o-json-fallback", { responses: [json(200, OK_JSON)] }),
  stream("o-json-fallback-tools", { responses: [json(200, { choices: [{ message: { role: "assistant", content: null,
    tool_calls: [{ id: "t", type: "function", function: { name: "read", arguments: "{}" } }] } }] })] }),
  stream("o-finish-length", { responses: [sse([chunk({ content: "cut" }, "length")])] }),
  stream("o-after-finish", { responses: [sse([chunk({ content: "a" }, "stop"), chunk({ content: "b" })])] }),
  stream("o-choices-not-list", { responses: [sse([{ choices: {} }])] }),
  stream("o-empty-choices-then-done", { responses: [sse([{ choices: [] }])] }),
  stream("o-bad-json", { responses: [sse(["data: {not json}\n\n"])] }),
  stream("o-sse-framing", { responses: [[SSE_HEAD + ": keep-alive\r\n\r\nevent: chunk\r\ndata:"
    + JSON.stringify(chunk({ content: "x" })) + "\r\n\r\nid: 7\ndata: " + JSON.stringify(chunk({ content: "y" }))
    + "\n\ndata: [DONE]\n\n"]] }),
  stream("o-sse-invalid-utf8", { responses: [[SSE_HEAD, Buffer.from([0x64, 0x61, 0x74, 0x61, 0x3a, 0x20, 0xff, 0x0a, 0x0a])]] }),
  stream("o-sse-long-line", { responses: [[SSE_HEAD + "data: " + "x".repeat(300_000) + "\n\n"]] }),
  stream("o-error-envelope", { responses: [sse([{ error: { type: "rate_limit_error", message: "slow down" } }], { done: false })] }),
  stream("o-error-envelope-overflow", { responses: [sse([{ error: { code: "context_length_exceeded", type: "invalid_request_error" } }])] }),
  stream("o-error-envelope-quota", { responses: [sse([{ error: { code: "insufficient_quota", message: "resets 2026-10-19T08:00:00Z" } }])] }),
  stream("o-429-retry-after", { responses: [json(429, { error: { message: "slow" } }, { "Retry-After": "1" }), TEXT_STREAM] }),
  stream("o-503-retry-after-date", { responses: [json(503, {}, { "Retry-After": "Wed, 21 Oct 2015 07:28:00 GMT" }), TEXT_STREAM] }),
  stream("o-500x3", { responses: [json(500, { error: { message: "boom" } })] }),
  stream("o-400-overflow", { responses: [json(400, { error: { code: "context_length_exceeded", message: "too long" } })] }),
  stream("o-429-quota", { responses: [json(429, { error: { code: "insufficient_quota", message: "quota resets at 2026-10-19T00:00:00Z" } })] }),
  stream("o-401", { responses: [json(401, { error: { message: "bad key" } })] }),
  stream("o-incomplete-before", { responses: [[SSE_HEAD], TEXT_STREAM] }),
  stream("o-incomplete-after", { responses: [sse([chunk({ content: "partial" })], { done: false })] }),
  stream("o-reset-before", { responses: [[{ reset: true }], TEXT_STREAM] }),
  stream("o-reset-always", { responses: [[{ reset: true }]] }),
  stream("o-reset-mid-stream", { responses: [[SSE_HEAD + events([chunk({ content: "x" })], { done: false }), { delay: 30 }, { reset: true }]] }),
  stream("o-redirect", { responses: [raw(302, { Location: "http://127.0.0.1:9/elsewhere" }, "")] }),
  stream("o-redirect-bare", { responses: [raw(302, {}, "")] }),
  stream("o-callback-raise", { callbacks: { delta: "raise" }, responses: [TEXT_STREAM] }),
  stream("o-callback-stop", { callbacks: { delta: "stop" }, responses: [TEXT_STREAM] }),
  stream("o-reasoning-callback-raise", { callbacks: { reasoning: "raise" }, responses: [sse([chunk({ reasoning_content: "r" })])] }),
  stream("o-deadline-hang", { deadline: 0.6, timing: true, responses: [[SSE_HEAD, { hang: true }]] }),
  stream("o-invalid-deadline", { attrs: { request_deadline: "soon" }, responses: [TEXT_STREAM] }),
  stream("o-lightweight-retry", { init: { runtime_profile: "lightweight", key: "", lightweight_options: { transportRetries: 1 } },
    responses: [json(500, {}), TEXT_STREAM] }),
  stream("o-lightweight-no-retry", { init: { runtime_profile: "lightweight" }, responses: [json(500, {})] }),
];

export const OPENAI_COMPLETE_CASES: ProviderCase[] = [
  complete("o-complete", { responses: [json(200, OK_JSON)] }),
  complete("o-complete-retry", { responses: [json(503, {}), json(200, OK_JSON)] }),
  complete("o-complete-bad-json", { responses: [raw(200, { "Content-Type": "application/json" }, "not json")] }),
  complete("o-complete-no-choices", { responses: [json(200, {})] }),
  complete("o-complete-null-message", { responses: [json(200, { choices: [{ message: null }] })] }),
  complete("o-complete-reset", { responses: [[{ reset: true }]] }),
  complete("o-complete-truncated", { responses: [["HTTP/1.1 200 OK\r\nContent-Length: 50\r\n\r\n{\"choices\""]] }),
  complete("o-complete-quota", { responses: [json(429, { error: { code: "insufficient_quota" } })] }),
  complete("o-complete-deadline", { deadline: 0.6, timing: true, responses: [["HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\n", { hang: true }]] }),
  complete("o-lightweight-complete", { init: { runtime_profile: "lightweight", lightweight_options: { temperature: 0.2, topP: 0.9, seed: 7 } },
    responses: [json(200, OK_JSON)] }),
];

const MULTIMODAL = `look ${MARKER}${JSON.stringify([{ mimeType: "image/png", data: PNG_B64, name: "a.png" }])}`;
const VIDEO = `clip ${MARKER}${JSON.stringify([{ mimeType: "video/mp4", framesData: [JPEG_B64, JPEG_B64] }])}`;
const HISTORY = [
  ...MESSAGES,
  { role: "assistant", content: "", tool_calls: [{ id: "t1", type: "function", function: { name: "read", arguments: "{\"path\":\"a\"}" } }],
    _private: "dropped" },
  { role: "tool", tool_call_id: "t1", content: "file body" },
];

export const OPENAI_BODY_CASES: ProviderCase[] = [
  complete("o-body-compat", { tools: TOOLS, init: { compatibility: { streamUsage: false, parallelToolCalls: true,
    maxTokensField: "max_completion_tokens", toolChoice: "required" }, max_output_tokens: 512, context_window: 4096,
  reasoning_effort: "high" }, responses: [json(200, OK_JSON)] }),
  stream("o-body-stream-compat", { tools: TOOLS, init: { compatibility: { streamUsage: true, think: false }, reasoning_effort: "low" },
    responses: [TEXT_STREAM] }),
  complete("o-body-reasoning-model", { init: { model: "o3-mini", max_output_tokens: 256 }, responses: [json(200, OK_JSON)] }),
  complete("o-body-history", { messages: HISTORY, tools: TOOLS, responses: [json(200, OK_JSON)] }),
  complete("o-body-image", { init: { model: "gpt-4o" }, messages: [{ role: "user", content: MULTIMODAL }], responses: [json(200, OK_JSON)] }),
  complete("o-body-video", { init: { model: "gpt-4o" }, messages: [{ role: "user", content: VIDEO }], responses: [json(200, OK_JSON)] }),
  complete("o-body-image-unsupported", { messages: [{ role: "user", content: MULTIMODAL }], responses: [json(200, OK_JSON)] }),
  stream("o-body-bad-base64", { init: { model: "gpt-4o" },
    messages: [{ role: "user", content: `x${MARKER}[{"mimeType":"image/png","data":"iVBOR=w0"}]` }], responses: [TEXT_STREAM] }),
  stream("o-body-media-refs", { messages: [{ role: "user", content: "x", _media_refs: [{ id: "m1" }] }], responses: [TEXT_STREAM] }),
  complete("o-body-lightweight-json", { init: { runtime_profile: "lightweight", tool_calling: "json", context_window: 4096 }, tools: TOOLS,
    responses: [json(200, OK_JSON)] }),
  complete("o-body-astral", { messages: [{ role: "user", content: "emoji 😀 and \ud800 lone" }], responses: [json(200, OK_JSON)] }),
];
