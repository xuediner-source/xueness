/**
 * JSON-RPC 2.0 core shared by the MCP transports (Python `McpClient._request`,
 * `_await`, `_answer_server_request`).
 *
 * A transport delivers every message the server sends to `receive`; replies
 * to our requests settle their waiter, and a request the server sends us is
 * answered at once. Xueness offers no client capabilities natively (servers
 * that opt into elicitation stay on the Python executor), so every server
 * request gets "method not found", as Python answers when elicitation is off.
 * A client may install `answerServer` after every `open` (open replaces the
 * channel). With no installer, elicitation is refused and every other server
 * request is "method not found". Failures carry metadata only.
 */
import { isDict } from "@xueness/contracts";
import type { Row } from "./names.ts";

/** The connection is unusable (timeout, EOF, bad write): close it. */
export class McpTransportError extends Error {
  override name = "McpTransportError";
}
/** The server answered with a JSON-RPC error. */
export class McpServerError extends Error {
  override name = "McpServerError";
}
/** A caller cancelled its pending request. `notification` settles when the best-effort notice was sent. */
export class McpCancelledError extends Error {
  override name = "McpCancelledError";
  readonly notification: Promise<void>;
  constructor(notification: Promise<void>) { super("cancelled"); this.notification = notification; }
}

export const PROTOCOL_VERSION = "2024-11-05";
export const HTTP_PROTOCOL_VERSION = "2025-03-26";
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = Object.freeze(["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"]);
export const CLIENT_INFO = Object.freeze({ name: "xueness", version: "0.1" });

/** Python `is_server_request`: a request we must answer, not a notification or a reply. */
export function isServerRequest(message: unknown): boolean {
  if (!isDict(message) || typeof message.method !== "string") return false;
  const id = message.id;
  if (typeof id === "number") return Number.isInteger(id);
  return typeof id === "string" && id.length >= 1 && id.length <= 128 && [...id].every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) < 127);
}

export function serverRequestReply(message: Row): Row {
  const disabled = message.method === "elicitation/create";
  return { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: disabled ? "elicitation is disabled" : "method not found" } };
}

/** Python `_error_summary`. */
export function errorSummary(error: unknown): string {
  if (isDict(error)) return error.code === undefined || error.code === null ? "unlabelled" : `code ${typeof error.code === "string" ? error.code : JSON.stringify(error.code)}`;
  return error === null || error === undefined ? "unknown" : typeof error;
}

interface Waiter { resolve(message: Row): void; reject(error: Error): void }

/**
 * Matches replies to requests. `send` writes one message (stdio, legacy SSE);
 * a Streamable HTTP transport delivers the reply from its POST response instead.
 */
export type ServerAnswer = (message: Row) => Row | Promise<Row>;
export type RpcNotificationHandler = (message: Row) => void | Promise<void>;

export class RpcChannel {
  readonly #waiters = new Map<number, Waiter>();
  #next = 1;
  #closed: Error | null = null;
  readonly #send: (message: Row, signal?: AbortSignal) => Promise<void>;
  readonly #reply: (message: Row) => Promise<void>;
  /** Installed again after `open` replaces this channel. Null keeps the default refusal. */
  answerServer: ServerAnswer | null = null;
  /** Notifications are observational and never hold up the transport's read loop. */
  notificationHandler: RpcNotificationHandler | null = null;
  onClosed: (() => void) | null = null;

  constructor(send: (message: Row, signal?: AbortSignal) => Promise<void>, reply?: (message: Row) => Promise<void>) {
    this.#send = send;
    this.#reply = reply ?? send;
  }

  get closed(): boolean {
    return this.#closed !== null;
  }

  get pendingCount(): number { return this.#waiters.size; }

  nextId(): number {
    return this.#next++;
  }

  /** Feed one parsed message from the server. */
  receive(message: unknown): void {
    if (!isDict(message)) return;
    if (isServerRequest(message)) {
      const custom = this.answerServer;
      if (!custom) { this.#reply(serverRequestReply(message as Row)).catch(() => {}); return; }
      // The read loop must not wait out the operator. The reply is sent when the promise settles.
      void Promise.resolve(custom(message as Row)).then((value) => { if (!this.#closed) this.#reply(value).catch(() => {}); }).catch(() => {});
      return;
    }
    if (typeof message.method === "string" && !Object.hasOwn(message, "id")) {
      const handler = this.notificationHandler;
      if (handler) void Promise.resolve().then(() => handler(message as Row)).catch(() => {});
      return;
    }
    if (typeof message.id !== "number") return; // notifications and foreign ids are ignored
    const waiter = this.#waiters.get(message.id);
    if (!waiter) return;
    this.#waiters.delete(message.id);
    waiter.resolve(message);
  }

  /** The reply to one request, bounded by `timeoutMs`; a timeout is a transport failure. */
  async request(method: string, params: Row | undefined, timeoutMs: number, id = this.nextId(), signal?: AbortSignal): Promise<Row> {
    if (this.#closed) throw new McpTransportError("server process is not running");
    if (signal?.aborted) throw new McpCancelledError(Promise.resolve());
    const message: Row = { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) };
    let timer: NodeJS.Timeout | undefined;
    const reply = new Promise<Row>((resolve, reject) => {
      this.#waiters.set(id, { resolve, reject });
      timer = setTimeout(() => {
        this.#waiters.delete(id);
        reject(new McpTransportError(`timeout after ${(timeoutMs / 1000).toFixed(1)}s`));
      }, timeoutMs);
    });
    const cancel = (): void => {
      const waiter = this.#waiters.get(id);
      if (!waiter) return;
      this.#waiters.delete(id);
      const notification = this.#send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: "cancelled" } }).catch(() => {});
      waiter.reject(new McpCancelledError(notification));
    };
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      void this.#send(message, signal).catch((error: unknown) => {
        const waiter = this.#waiters.get(id);
        if (!waiter) return;
        this.#waiters.delete(id);
        waiter.reject(error instanceof Error ? error : new McpTransportError("MCP request send failed"));
      });
      const response = await reply;
      if (response.error !== undefined && response.error !== null) throw new McpServerError(`server error: ${errorSummary(response.error)}`);
      return isDict(response.result) ? response.result : {};
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      this.#waiters.delete(id);
      reply.catch(() => {});
    }
  }

  async notify(method: string, params?: Row): Promise<void> {
    if (this.#closed) throw new McpTransportError("server process is not running");
    await this.#send({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
  }

  /** Fail every waiter; later requests fail at once. */
  close(reason: Error = new McpTransportError("server closed stdout before replying")): void {
    if (this.#closed) return;
    this.#closed = reason;
    for (const waiter of this.#waiters.values()) waiter.reject(reason);
    this.#waiters.clear();
    try { this.onClosed?.(); } catch { /* close observers cannot prevent transport shutdown */ }
  }
}

/** Python `_record_handshake`: an error text, or the negotiated details. */
export function handshakeOf(result: unknown): { error: string } | { version: string; info: Row; capabilities: Row } {
  if (!isDict(result)) return { error: "malformed initialize result" };
  const version = result.protocolVersion;
  if (typeof version !== "string" || !version) return { error: "initialize result is missing protocolVersion" };
  if (!SUPPORTED_PROTOCOL_VERSIONS.includes(version)) return { error: `unsupported protocol version: ${version}` };
  return { version, info: isDict(result.serverInfo) ? { ...result.serverInfo } : {}, capabilities: isDict(result.capabilities) ? { ...result.capabilities } : {} };
}

/** Python `_version_ladder`: the preferred version, then the rest newest first. */
export function versionLadder(server: Row, fallback = PROTOCOL_VERSION): string[] {
  const pinned = server.protocolVersion;
  const preferred = typeof pinned === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(pinned) ? pinned : fallback;
  return [preferred, ...[...SUPPORTED_PROTOCOL_VERSIONS].reverse().filter((version) => version !== preferred)];
}

/** Server `timeout` (seconds) overrides the default, capped like Python (10 s default, 30 s cap). */
export function timeoutMs(server: Row, fallbackSeconds = 10, capSeconds = 30): number {
  const own = positive(server.timeout);
  return Math.min(own ?? fallbackSeconds, capSeconds) * 1000;
}

function positive(value: unknown): number | null {
  let number: number;
  if (typeof value === "number") number = value;
  else if (typeof value === "string" && value.trim() && !/^0[xob]/i.test(value.trim())) number = Number(value.trim().replace(/_/g, ""));
  else if (typeof value === "boolean") number = value ? 1 : 0;
  else return null;
  return Number.isFinite(number) && number > 0 ? number : null;
}
