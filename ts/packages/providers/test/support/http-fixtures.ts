/** Raw HTTP response builders and shared inputs for provider differential cases. */
import type { Response, Script } from "./scripted-server.ts";

export type CallbackMode = "record" | "raise" | "stop" | "none";

export interface ProviderCase {
  id: string;
  provider: "openai" | "anthropic";
  method: "stream" | "complete" | "construct";
  /** Python constructor keyword arguments (snake_case); `base`/`key`/`model` get test defaults. */
  init?: Record<string, unknown>;
  /** Attributes assigned after construction (the profile resolver's Anthropic runtime fields). */
  attrs?: Record<string, unknown>;
  /** Relative run-loop deadline in seconds. */
  deadline?: number;
  messages?: unknown[];
  tools?: unknown[];
  callbacks?: { delta?: CallbackMode; reasoning?: CallbackMode; tool?: CallbackMode };
  responses?: Response[];
  /** Timing-dependent case: compare only the sleep count and not `exception_type`. */
  timing?: boolean;
}

export const MESSAGES = [
  { role: "system", content: "You are terse." },
  { role: "user", content: "hi 你好 \u2028 \"quoted\"" },
];

export const TOOLS = [{
  type: "function",
  function: { name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } },
}];

export const MARKER = "\n\nXUENESS_MULTIMODAL_V1:";
export const PNG_B64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString("base64");
export const JPEG_B64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]).toString("base64");

const REASONS: Record<number, string> = {
  200: "OK", 302: "Found", 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found",
  429: "Too Many Requests", 500: "Internal Server Error", 503: "Service Unavailable", 529: "Overloaded",
};

/** A complete response with a Content-Length body. */
export function raw(status: number, headers: Record<string, string>, body: string, { length = true } = {}): string {
  const lines = [`HTTP/1.1 ${status} ${REASONS[status] ?? "Status"}`];
  for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`);
  if (length) lines.push(`Content-Length: ${Buffer.byteLength(body, "utf8")}`);
  lines.push("Connection: close");
  return `${lines.join("\r\n")}\r\n\r\n${body}`;
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): string {
  return raw(status, { "Content-Type": "application/json", ...headers }, typeof body === "string" ? body : JSON.stringify(body));
}

/** The head of an EOF-delimited event stream. */
export const SSE_HEAD = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream; charset=utf-8\r\nConnection: close\r\n\r\n";

/** One `data:` event per object; strings are written verbatim. */
export function events(items: unknown[], { done = true } = {}): string {
  const body = items.map((item) => (typeof item === "string" ? item : `data: ${JSON.stringify(item)}\n\n`)).join("");
  return body + (done ? "data: [DONE]\n\n" : "");
}

export function sse(items: unknown[], options: { done?: boolean } = {}): Script {
  return [SSE_HEAD + events(items, options)];
}

/** An OpenAI chunk with one choice. */
export function chunk(delta: Record<string, unknown>, finish: string | null = null): Record<string, unknown> {
  return { id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] };
}

export const USAGE_CHUNK = { id: "c1", choices: [], usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 } };

export const TEXT_STREAM = sse([chunk({ role: "assistant", content: "" }), chunk({ content: "Hel" }), chunk({ content: "lo 世界" }),
  chunk({}, "stop"), USAGE_CHUNK]);

/** An Anthropic event with an `event:` line, as the Messages API sends it. */
export function event(type: string, body: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...body })}\n\n`;
}

export const MESSAGE_START = event("message_start", {
  message: { id: "m1", type: "message", role: "assistant", content: [], usage: { input_tokens: 9, output_tokens: 1 } },
});

export function textBlock(index: number, ...parts: string[]): string[] {
  return [
    event("content_block_start", { index, content_block: { type: "text", text: "" } }),
    ...parts.map((text) => event("content_block_delta", { index, delta: { type: "text_delta", text } })),
    event("content_block_stop", { index }),
  ];
}

export function messageEnd(stop = "end_turn", output = 7): string[] {
  return [event("message_delta", { delta: { stop_reason: stop }, usage: { output_tokens: output } }), event("message_stop", {})];
}

export function anthropicStream(...parts: (string | string[])[]): Script {
  return [SSE_HEAD + parts.flat().join("")];
}

export const ANTHROPIC_TEXT = anthropicStream(MESSAGE_START, textBlock(0, "Hi", " there ✓"), messageEnd());
