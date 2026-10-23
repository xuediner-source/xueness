/** Anthropic Messages differential cases plus constructor validation for both adapters. */
import {
  ANTHROPIC_TEXT, MARKER, MESSAGES, MESSAGE_START, PNG_B64, SSE_HEAD, TOOLS, anthropicStream, event, json, messageEnd, raw,
  textBlock, type ProviderCase,
} from "./http-fixtures.ts";

const stream = (id: string, extra: Partial<ProviderCase>): ProviderCase => ({ id, provider: "anthropic", method: "stream", ...extra });
const complete = (id: string, extra: Partial<ProviderCase>): ProviderCase => ({ id, provider: "anthropic", method: "complete", ...extra });

function toolBlock(index: number, id: string, ...parts: string[]): string[] {
  return [
    event("content_block_start", { index, content_block: { type: "tool_use", id, name: "read", input: {} } }),
    ...parts.map((partial_json) => event("content_block_delta", { index, delta: { type: "input_json_delta", partial_json } })),
    event("content_block_stop", { index }),
  ];
}

const THINKING = [
  event("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "" } }),
  event("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "ponder " } }),
  event("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "more" } }),
  event("content_block_delta", { index: 0, delta: { type: "signature_delta", signature: "sig" } }),
  event("content_block_stop", { index: 0 }),
];

const OK_MESSAGE = {
  id: "m", type: "message", role: "assistant", stop_reason: "tool_use", usage: { input_tokens: 3, output_tokens: 4 },
  content: [{ type: "text", text: "ok ✓" }, { type: "tool_use", id: "tu_1", name: "read", input: { path: "a" } }],
};
const OVERLOADED = { type: "error", error: { type: "overloaded_error", message: "busy" } };
const LIGHTWEIGHT = { runtime_profile: "lightweight", context_window: 8192, max_output_tokens: 1024, tool_calling: "native",
  compatibility: {}, lightweight_options: { transportRetries: 1 } };
const HISTORY = [
  ...MESSAGES,
  { role: "user", content: `see ${MARKER}${JSON.stringify([{ mimeType: "image/png", data: PNG_B64 }])}` },
  { role: "assistant", content: "checking", tool_calls: [{ id: "t1", type: "function", function: { name: "read", arguments: "{\"path\":\"a\"}" } }] },
  { role: "tool", tool_call_id: "t1", content: "file body" },
  { role: "tool", tool_call_id: "t2", content: "second" },
  { role: "user", content: "next" },
];

export const ANTHROPIC_CASES: ProviderCase[] = [
  stream("a-text", { responses: [ANTHROPIC_TEXT] }),
  stream("a-tool", { tools: TOOLS, responses: [anthropicStream(MESSAGE_START, textBlock(0, "Let me look."),
    toolBlock(1, "tu_1", "{\"pa", "th\": \"a.txt\"}"), toolBlock(2, "tu_2"), messageEnd("tool_use"))] }),
  stream("a-thinking", { responses: [anthropicStream(MESSAGE_START, THINKING, textBlock(1, "answer"), messageEnd())] }),
  stream("a-bad-tool-json", { tools: TOOLS, responses: [anthropicStream(MESSAGE_START, toolBlock(0, "tu", "{bad"), messageEnd("tool_use"))] }),
  stream("a-tool-observer-raises", { tools: TOOLS, callbacks: { tool: "raise" },
    responses: [anthropicStream(MESSAGE_START, toolBlock(0, "tu", "{}"), messageEnd("tool_use"))] }),
  stream("a-error-event", { responses: [anthropicStream(MESSAGE_START, event("error", { error: OVERLOADED.error }))] }),
  stream("a-529-retry", { responses: [json(529, OVERLOADED), ANTHROPIC_TEXT] }),
  stream("a-incomplete-after", { responses: [anthropicStream(MESSAGE_START, event("content_block_start",
    { index: 0, content_block: { type: "text", text: "" } }), event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "x" } }))] }),
  stream("a-incomplete-before", { responses: [[SSE_HEAD], ANTHROPIC_TEXT] }),
  stream("a-max-tokens", { responses: [anthropicStream(MESSAGE_START, textBlock(0, "cut"), messageEnd("max_tokens"))] }),
  stream("a-callback-raise", { callbacks: { delta: "raise" }, responses: [ANTHROPIC_TEXT] }),
  stream("a-callback-stop", { callbacks: { delta: "stop" }, responses: [ANTHROPIC_TEXT] }),
  stream("a-not-json", { responses: [[SSE_HEAD + "event: ping\ndata: nope\n\n"]] }),
  stream("a-400", { responses: [json(400, { type: "error", error: { type: "invalid_request_error", message: "prompt is too long" } })] }),
  stream("a-lightweight", { attrs: LIGHTWEIGHT, responses: [json(500, {}), ANTHROPIC_TEXT] }),
  stream("a-deadline-hang", { deadline: 0.6, timing: true, responses: [[SSE_HEAD + MESSAGE_START, { hang: true }]] }),
  stream("a-media-error", { messages: [{ role: "user", content: "x", _media_refs: [{ id: "m1" }] }], responses: [ANTHROPIC_TEXT] }),
  complete("a-complete", { tools: TOOLS, responses: [json(200, OK_MESSAGE)] }),
  complete("a-complete-529", { responses: [json(529, OVERLOADED, { "Retry-After": "3" })] }),
  complete("a-complete-quota", { responses: [json(429, { type: "error", error: { type: "rate_limit_error", code: "insufficient_quota" } })] }),
  complete("a-complete-bad-json", { responses: [raw(200, { "Content-Type": "application/json" }, "{")] }),
  complete("a-complete-no-content", { responses: [json(200, { id: "m" })] }),
  complete("a-complete-reset", { responses: [[{ reset: true }]] }),
  complete("a-complete-redirect", { responses: [raw(307, { Location: "http://127.0.0.1:9/x" }, "")] }),
  complete("a-complete-lightweight", { attrs: LIGHTWEIGHT, responses: [json(500, {}), json(200, OK_MESSAGE)] }),
  complete("a-complete-deadline", { deadline: 0.6, timing: true, responses: [["HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\n", { hang: true }]] }),
  complete("a-complete-media-error", { messages: [{ role: "user", content: "x", _media_refs: [{ id: "m1" }] }], responses: [json(200, OK_MESSAGE)] }),
  complete("a-body-history", { messages: HISTORY, tools: TOOLS, init: { max_tokens: 2048, capabilities: ["image"] },
    responses: [json(200, OK_MESSAGE)] }),
  complete("a-body-no-image-capability", { messages: HISTORY, init: { capabilities: ["pdf"] }, responses: [json(200, OK_MESSAGE)] }),
];

const construct = (id: string, provider: "openai" | "anthropic", init: Record<string, unknown>): ProviderCase =>
  ({ id, provider, method: "construct", init });

export const CONSTRUCT_CASES: ProviderCase[] = [
  construct("c-o-ok", "openai", { base: "https://api.example.com/v1/", model: "gpt-4.1-mini" }),
  construct("c-o-ftp", "openai", { base: "ftp://api.example.com" }),
  construct("c-o-query", "openai", { base: "https://api.example.com/v1?x=1" }),
  construct("c-o-credentials", "openai", { base: "https://u:p@api.example.com" }),
  construct("c-o-http-no-opt-in", "openai", { base: "http://127.0.0.1:8080/v1" }),
  construct("c-o-http-hostname", "openai", { base: "http://localhost:8080/v1", allow_loopback_http: true }),
  construct("c-o-http-mapped", "openai", { base: "http://[::ffff:127.0.0.1]:8080/v1", allow_loopback_http: true }),
  construct("c-o-no-model", "openai", { base: "https://api.example.com", model: null }),
  construct("c-o-empty-key-remote", "openai", { base: "https://api.example.com", key: "" }),
  construct("c-o-empty-key-loopback", "openai", { base: "http://127.0.0.1:1", key: "", allow_loopback_http: true }),
  construct("c-o-empty-key-denied", "openai", { base: "http://127.0.0.1:1", key: "", allow_loopback_http: true, allow_empty_key: false }),
  construct("c-o-lightweight", "openai", { base: "http://127.0.0.1:1", key: "", runtime_profile: "lightweight" }),
  construct("c-o-effort", "openai", { base: "https://api.example.com", reasoning_effort: "extreme" }),
  construct("c-o-profile", "openai", { base: "https://api.example.com", runtime_profile: "turbo" }),
  construct("c-o-context", "openai", { base: "https://api.example.com", context_window: 100 }),
  construct("c-o-output-half", "openai", { base: "https://api.example.com", context_window: 4096, max_output_tokens: 4096 }),
  construct("c-o-compat-unknown", "openai", { base: "https://api.example.com", compatibility: { fast: true } }),
  construct("c-o-compat-bool", "openai", { base: "https://api.example.com", compatibility: { streamUsage: "yes" } }),
  construct("c-o-json-standard", "openai", { base: "https://api.example.com", tool_calling: "json" }),
  construct("c-o-options-unknown", "openai", { base: "https://api.example.com", lightweight_options: { turbo: 1 } }),
  construct("c-o-options-range", "openai", { base: "http://127.0.0.1:1", runtime_profile: "lightweight",
    lightweight_options: { requestTimeoutSeconds: 0 } }),
  construct("c-o-capabilities", "openai", { base: "https://api.example.com", model: "o4-mini", capabilities: ["image", "pdf"] }),
  construct("c-a-ok", "anthropic", { base: "https://api.anthropic.com/v1", capabilities: ["image", "audio"] }),
  construct("c-a-http", "anthropic", { base: "http://127.0.0.1:1" }),
  construct("c-a-ftp", "anthropic", { base: "ftp://x.example" }),
  construct("c-a-fragment", "anthropic", { base: "https://x.example/#frag" }),
  construct("c-a-no-key", "anthropic", { base: "https://x.example", key: "" }),
];
