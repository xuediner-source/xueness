/**
 * Streamable HTTP and legacy SSE transports (Python `mcp_http.py`, `sse.py`).
 *
 * Only https, or http to a loopback IP literal with `allowLoopbackHttp`; no
 * credentials, query or fragment in the URL; redirects fail closed so a
 * credential never follows a new destination. Authentication headers come
 * from named environment variables (Authorization / X-Api-Key only). A
 * truthy `oauth` object then replaces Authorization. A JSON or SSE reply is
 * capped at 1 MB; remote details are never surfaced.
 */
import { isDict } from "@xueness/contracts";
import type { Context } from "@xueness/kernel";
import { isLoopbackLiteral, pyUrlSplit } from "@xueness/providers";
import type { Row } from "./names.ts";
import { oauthAuthorization } from "./oauth.ts";
import { McpTransportError, RpcChannel } from "./rpc.ts";
import type { Transport } from "./stdio.ts";

const MAX_BODY = 1_000_000;
const MAX_LINE = 65_536;
const USER_WAIT_MS = 600_000;

/** Python `_transport_timeout`: an elicitation server may pause inside one read. */
function transportTimeoutMs(server: Row, timeoutMs: number): number {
  return server.elicitation === true ? Math.max(timeoutMs, USER_WAIT_MS + timeoutMs) : timeoutMs;
}

async function withOauth(server: Row, headers: Record<string, string>): Promise<Record<string, string>> {
  const authorization = await oauthAuthorization(server);
  if (authorization) headers.Authorization = authorization;
  return headers;
}

export function checkedUrl(server: Row): string {
  const url = typeof server.url === "string" ? server.url : "";
  const parts = pyUrlSplit(url);
  if (parts.username !== null || parts.password !== null || parts.query || parts.fragment || !parts.hostname) throw new McpTransportError("invalid MCP URL");
  if (parts.scheme !== "https" && !(parts.scheme === "http" && server.allowLoopbackHttp === true && isLoopbackLiteral(parts.hostname))) throw new McpTransportError("invalid MCP URL");
  return url;
}

export function authHeaders(server: Row, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const headers: Record<string, string> = {};
  const configured = server.headersEnv ?? {};
  if (!isDict(configured)) throw new McpTransportError("invalid authentication header configuration");
  for (const [key, name] of Object.entries(configured)) {
    if (!["authorization", "x-api-key"].includes(key.toLowerCase()) || typeof name !== "string") throw new McpTransportError("invalid authentication header configuration");
    const value = env[name] ?? "";
    if (!value || value.includes("\r") || value.includes("\n")) throw new McpTransportError("authentication environment variable missing or invalid");
    headers[key] = value;
  }
  return headers;
}

/** Server-sent events, one JSON message per `data:` block (event name kept for legacy SSE). */
export async function* sseEvents(body: ReadableStream<Uint8Array>, limit = MAX_BODY): AsyncGenerator<{ event: string; data: string }> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let total = 0;
  let event = "message";
  let data: string[] = [];
  for await (const chunk of body) {
    total += chunk.length;
    if (total > limit) throw new McpTransportError("MCP event stream too large");
    buffer += decoder.decode(chunk, { stream: true });
    for (let newline = buffer.indexOf("\n"); newline !== -1; newline = buffer.indexOf("\n")) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (line.length > MAX_LINE) throw new McpTransportError("MCP event line too long");
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
      else if (!line && data.length) {
        yield { event, data: data.join("\n") };
        event = "message"; data = [];
      } else if (!line) event = "message";
    }
    if (buffer.length > MAX_LINE) throw new McpTransportError("MCP event line too long");
  }
}

async function readCapped(response: Response): Promise<string> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (response.body) for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_BODY) throw new McpTransportError("MCP response too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sessionIdOf(response: Response): string | null {
  const value = response.headers.get("mcp-session-id");
  if (!value) return null;
  if (value.length > 256 || [...value].some((char) => char.charCodeAt(0) < 33 || char.charCodeAt(0) > 126)) throw new McpTransportError("invalid MCP session id");
  return value;
}

/** Streamable HTTP: each POST carries one message; a request's reply comes back on its response. */
export class HttpTransport implements Transport {
  readonly #ctx: Context;
  readonly #server: Row;
  readonly #timeoutMs: number;
  #sessionId: string | null = null;
  #started = false;
  protocolVersion: string | null = null;
  channel: RpcChannel;

  constructor(ctx: Context, server: Row, timeoutMs: number) {
    this.#ctx = ctx;
    this.#server = server;
    this.#timeoutMs = timeoutMs;
    this.channel = new RpcChannel((message, signal) => this.#post(message, signal));
  }

  get active(): boolean {
    return this.#started && !this.channel.closed;
  }

  markStarted(): void {
    this.#started = true;
  }

  async headers(accept = "application/json, text/event-stream"): Promise<Record<string, string>> {
    return withOauth(this.#server, {
      ...authHeaders(this.#server), "Content-Type": "application/json", Accept: accept,
      ...(this.#sessionId ? { "Mcp-Session-Id": this.#sessionId } : {}),
      ...(this.protocolVersion ? { "MCP-Protocol-Version": this.protocolVersion } : {}),
    });
  }

  async #post(message: Row, signal?: AbortSignal): Promise<void> {
    const channel = this.channel;
    const requestSignal = AbortSignal.any([AbortSignal.timeout(transportTimeoutMs(this.#server, this.#timeoutMs)), ...(signal ? [signal] : [])]);
    const response = await this.#ctx.fetch(checkedUrl(this.#server), {
      method: "POST", headers: await this.headers(), body: JSON.stringify(message), redirect: "error", signal: requestSignal,
    }).catch(() => { throw new McpTransportError("HTTP MCP request failed (remote details suppressed)"); });
    try {
      const sessionId = sessionIdOf(response);
      if (sessionId) this.#sessionId = sessionId;
      if (!("id" in message) || "result" in message || "error" in message) { await response.body?.cancel().catch(() => {}); return; }
      if (response.status < 200 || response.status > 299) throw new McpTransportError("HTTP MCP request failed (remote details suppressed)");
      let answered = false;
      const reply = (value: Row): void => {
        if (value.id === message.id && !("method" in value)) {
          if (value.jsonrpc !== "2.0") throw new McpTransportError("invalid HTTP MCP response");
          if ("error" in value) throw new McpTransportError("HTTP MCP server rejected request");
          if (!isDict(value.result)) throw new McpTransportError("invalid HTTP MCP response");
          answered = true;
        }
        channel.receive(value);
      };
      if ((response.headers.get("content-type") ?? "").includes("text/event-stream") && response.body) {
        for await (const { data } of sseEvents(response.body)) {
          let parsed: unknown;
          try { parsed = JSON.parse(data); } catch { throw new McpTransportError("invalid HTTP MCP response"); }
          if (!isDict(parsed)) continue;
          reply(parsed);
          if (answered) break;
        }
        await response.body.cancel().catch(() => {});
        if (!answered) throw new McpTransportError("HTTP MCP request failed (remote details suppressed)");
        return;
      }
      let parsed: unknown;
      try { parsed = JSON.parse(await readCapped(response)); } catch (error) { throw error instanceof McpTransportError ? error : new McpTransportError("invalid HTTP MCP response"); }
      if (!isDict(parsed) || parsed.id !== message.id) throw new McpTransportError("invalid HTTP MCP response");
      reply(parsed);
    } catch (error) {
      await response.body?.cancel().catch(() => {});
      throw error instanceof McpTransportError ? error : new McpTransportError("HTTP MCP request failed (remote details suppressed)");
    }
  }

  async open(): Promise<void> {
    this.#started = false;
    this.#sessionId = null;
    this.protocolVersion = null;
    this.channel = new RpcChannel((message, signal) => this.#post(message, signal));
  }

  async close(): Promise<void> {
    // Session deletion is optional in the protocol; closing never replays a call.
    this.#started = false;
    this.#sessionId = null;
    this.channel.close(new McpTransportError("HTTP MCP disconnected"));
  }
}

/** Legacy SSE: a GET event stream names a same-origin POST endpoint; replies arrive on the stream. */
export class SseTransport implements Transport {
  readonly #ctx: Context;
  readonly #server: Row;
  readonly #timeoutMs: number;
  #endpoint: string | null = null;
  #abort: AbortController | null = null;
  #started = false;
  protocolVersion: string | null = null;
  channel: RpcChannel;

  constructor(ctx: Context, server: Row, timeoutMs: number) {
    this.#ctx = ctx;
    this.#server = server;
    this.#timeoutMs = timeoutMs;
    this.channel = new RpcChannel((message, signal) => this.#post(message, signal));
  }

  get active(): boolean {
    return this.#started && !!this.#endpoint && !this.channel.closed;
  }

  markStarted(): void {
    this.#started = true;
  }

  async #headers(accept: string): Promise<Record<string, string>> {
    return withOauth(this.#server, { ...authHeaders(this.#server), "Content-Type": "application/json", Accept: accept, ...(this.protocolVersion ? { "MCP-Protocol-Version": this.protocolVersion } : {}) });
  }

  async #post(message: Row, signal?: AbortSignal): Promise<void> {
    if (!this.#endpoint || this.channel.closed) throw new McpTransportError("SSE MCP disconnected");
    const requestSignal = AbortSignal.any([AbortSignal.timeout(transportTimeoutMs(this.#server, this.#timeoutMs)), ...(signal ? [signal] : [])]);
    const response = await this.#ctx.fetch(this.#endpoint, { method: "POST", headers: await this.#headers("application/json, text/event-stream"), body: JSON.stringify(message), redirect: "error", signal: requestSignal })
      .catch(() => { throw new McpTransportError("SSE MCP request failed (details suppressed)"); });
    await response.body?.cancel().catch(() => {});
    if (![200, 202, 204].includes(response.status)) throw new McpTransportError("SSE MCP request failed (details suppressed)");
  }

  async open(): Promise<void> {
    await this.close();
    this.channel = new RpcChannel((message, signal) => this.#post(message, signal));
    const channel = this.channel;
    const url = checkedUrl(this.#server);
    const abort = new AbortController();
    this.#abort = abort;
    // The connect timeout must not end the stream itself, so it aborts only until the endpoint arrives.
    const connecting = setTimeout(() => abort.abort(), this.#timeoutMs);
    const response = await this.#ctx.fetch(url, { method: "GET", headers: { ...await this.#headers("text/event-stream") }, redirect: "error", signal: abort.signal })
      .catch(() => { clearTimeout(connecting); throw new McpTransportError("SSE MCP initialization failed"); });
    if (!(response.headers.get("content-type") ?? "").includes("text/event-stream") || !response.body) {
      clearTimeout(connecting);
      await response.body?.cancel().catch(() => {});
      throw new McpTransportError("SSE MCP initialization failed");
    }
    let ready!: (ok: boolean) => void;
    const endpoint = new Promise<boolean>((resolve) => (ready = resolve));
    const base = new URL(url);
    void (async () => {
      try {
        for await (const { event, data } of sseEvents(response.body!, Number.MAX_SAFE_INTEGER)) {
          if (event === "endpoint") {
            const target = new URL(data, base);
            if (target.protocol !== base.protocol || target.hostname !== base.hostname || target.port !== base.port || target.username || target.password || target.hash) throw new McpTransportError("cross-origin SSE endpoint");
            this.#endpoint = target.href;
            ready(true);
          } else if (event === "message") {
            let parsed: unknown;
            try { parsed = JSON.parse(data); } catch { continue; }
            channel.receive(parsed);
          }
        }
      } catch { /* the connection is gone */ }
      finally { this.#started = false; channel.close(new McpTransportError("SSE MCP disconnected")); ready(false); }
    })();
    const ok = await endpoint;
    clearTimeout(connecting);
    if (!ok || !this.#endpoint) { await this.close(); throw new McpTransportError("SSE MCP initialization failed"); }
  }

  async close(): Promise<void> {
    this.#started = false;
    this.#endpoint = null;
    this.#abort?.abort();
    this.#abort = null;
    this.channel.close(new McpTransportError("SSE MCP disconnected"));
  }
}
