/**
 * One HTTP exchange with urllib's failure semantics.
 *
 * - `timeoutMs` bounds every idle socket period (Python's socket timeout);
 *   `deadlineMs` (`performance.now()` clock) bounds the whole exchange like
 *   `_SocketDeadlineGuard`; `signal` is cancellation. Failures are typed by
 *   Python family: `ProviderTransportError` for urllib's `URLError` / `OSError`
 *   (retryable), `ProviderProtocolError` for `HTTPException` (never retried).
 * - No redirects are followed and no cookies, compression or keep-alive.
 */
import http from "node:http";
import https from "node:https";
import type { Socket } from "node:net";
import { performance } from "node:perf_hooks";
import tls from "node:tls";
import { ProviderCancelled, ProviderProtocolError, ProviderTransportError, type TransportHint } from "./errors.ts";
import { isTlsCode } from "./failure-codes.ts";
import { isIpLiteral, type SplitUrl } from "./endpoint.ts";
import { IdleTimer } from "./idle.ts";
import { httpsProxyFor, pyUnquote, type ProxyTarget } from "./proxy.ts";
import { trustedSecureContext } from "./trust.ts";

export interface HttpRequestSpec {
  url: SplitUrl;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body: Uint8Array | null;
  timeoutMs: number;
  deadlineMs?: number | null;
  signal?: AbortSignal | null;
  /** Null for loopback literals, which never use a proxy. */
  proxy?: ProxyTarget | null;
}

const CONNECT_PHASE = new Set(["connect"]);
const TRANSPORT_CODES: Record<string, ["timeout" | "service_unready" | "connection_failed", string]> = {
  ECONNREFUSED: ["service_unready", "ConnectionRefusedError"],
  ETIMEDOUT: ["timeout", "TimeoutError"],
  ECONNRESET: ["connection_failed", "ConnectionResetError"],
  EPIPE: ["connection_failed", "BrokenPipeError"],
  ECONNABORTED: ["connection_failed", "ConnectionAbortedError"],
};

/** Response with a bounded, failure-typed body reader. */
export class HttpResponse {
  readonly status: number;
  readonly #exchange: Exchange;
  readonly #res: http.IncomingMessage;
  #buf: Buffer = Buffer.alloc(0);
  #ended = false;
  #wake: (() => void) | null = null;

  constructor(exchange: Exchange, res: http.IncomingMessage) {
    this.status = res.statusCode ?? 0;
    this.#exchange = exchange;
    this.#res = res;
    exchange.blocked(false);
    res.on("data", (chunk: Buffer) => {
      this.#buf = this.#buf.length ? Buffer.concat([this.#buf, chunk]) : chunk;
      if (this.#buf.length > 1 << 20) res.pause();
      this.#notify();
    });
    res.on("end", () => {
      this.#ended = true;
      exchange.finished();
      this.#notify();
    });
    res.on("error", () => this.#notify());
    res.on("close", () => this.#notify());
  }

  /** First value of a header, case-insensitive (Python's `Message.get`). */
  header(name: string): string | undefined {
    const lower = name.toLowerCase();
    const raw = this.#res.rawHeaders;
    for (let index = 0; index + 1 < raw.length; index += 2) {
      if ((raw[index] as string).toLowerCase() === lower) return raw[index + 1];
    }
    return undefined;
  }

  /** Change the idle timeout (diagnostic error bodies use 0.25 s). */
  setIdleTimeout(ms: number): void {
    this.#exchange.setIdleTimeout(ms);
  }

  #notify(): void {
    const wake = this.#wake;
    this.#wake = null;
    wake?.();
  }

  #take(count: number): Buffer {
    const out = this.#buf.subarray(0, count);
    this.#buf = this.#buf.subarray(count);
    if (this.#buf.length < 1 << 20 && this.#res.isPaused()) this.#res.resume();
    return out;
  }

  async #more(): Promise<void> {
    const failure = this.#exchange.bodyFailure(this.#res);
    if (failure === "eof") {
      this.#ended = true;
      return;
    }
    if (failure) throw failure;
    this.#exchange.blocked(true);
    try {
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
        if (this.#res.isPaused()) this.#res.resume();
      });
    } finally {
      this.#exchange.blocked(false);
    }
  }

  /** The rest of the buffer at the end of the body, or the reset that ended it. */
  #rest(): Buffer {
    if (!this.#buf.length) {
      const failure = this.#exchange.abruptEnd(this.#res);
      if (failure) throw failure;
    }
    return this.#take(this.#buf.length);
  }

  /** `readline(limit)`: up to `limit` bytes, through the first newline. */
  async readline(limit: number): Promise<Buffer> {
    for (;;) {
      const newline = this.#buf.indexOf(0x0a);
      if (newline >= 0 && newline < limit) return this.#take(newline + 1);
      if (this.#buf.length >= limit) return this.#take(limit);
      if (this.#ended) return this.#rest();
      await this.#more();
    }
  }

  /** `read(limit)`: until `limit` bytes or the end of the body. */
  async read(limit: number): Promise<Buffer> {
    for (;;) {
      if (this.#buf.length >= limit) return this.#take(limit);
      if (this.#ended) return this.#rest();
      await this.#more();
    }
  }

  close(): void {
    this.#exchange.close();
  }
}

class Exchange {
  phase: "connect" | "response" | "body" = "connect";
  reason: Error | null = null;
  socketError: string | null = null;
  req: http.ClientRequest | null = null;
  socket: Socket | null = null;
  #timers: NodeJS.Timeout[] = [];
  #onAbort: (() => void) | null = null;
  readonly #spec: HttpRequestSpec;
  readonly #idle: IdleTimer;

  constructor(spec: HttpRequestSpec) {
    this.#spec = spec;
    this.#idle = new IdleTimer(spec.timeoutMs, () => this.kill(this.timeoutError()));
  }

  /** Bound `socket` by the idle timeout (Python's socket timeout); returns the untrack hook. */
  track(socket: Socket): () => void {
    return this.#idle.watch(socket);
  }

  /** Activity that restarts the idle period: connected, handshake done, tunnel opened. */
  touch(): void {
    this.#idle.touch();
  }

  /** A request is going out (one `sendall` period) or has gone out. */
  sending(on: boolean): void {
    this.#idle.sending(on);
  }

  /** Python's timeout only runs while a call waits (here: for data). */
  blocked(on: boolean): void {
    this.#idle.block(on);
  }

  /** The body is complete: like Python, no further read can time out. */
  finished(): void {
    this.#idle.stop();
  }

  /** Destroy the exchange, recording why so pending reads report it. */
  kill(reason: Error): void {
    this.reason ??= reason;
    this.#idle.stop();
    this.req?.destroy();
    this.socket?.destroy();
  }

  timeoutError(): ProviderTransportError {
    // urllib wraps connect-phase failures in URLError; later reads raise bare TimeoutError.
    return new ProviderTransportError("timeout", CONNECT_PHASE.has(this.phase) ? "URLError" : "TimeoutError", "timed out");
  }

  setIdleTimeout(ms: number): void {
    this.#idle.set(ms);
  }

  watch(): void {
    const { deadlineMs, signal } = this.#spec;
    if (deadlineMs !== undefined && deadlineMs !== null) {
      // Timers run on the event loop's cached millisecond clock and may fire
      // just before `performance.now()` reaches the deadline; re-arm until it
      // has, so the caller's own deadline check agrees (like `_SocketDeadlineGuard`).
      const arm = (): void => {
        const left = deadlineMs - performance.now();
        if (left <= 0) {
          this.kill(new ProviderTransportError("timeout", "TimeoutError", "provider request deadline exceeded"));
          return;
        }
        const timer = setTimeout(arm, Math.ceil(left));
        timer.unref();
        this.#timers.push(timer);
      };
      const timer = setTimeout(arm, Math.max(0, Math.ceil(deadlineMs - performance.now())));
      timer.unref();
      this.#timers.push(timer);
    }
    if (signal) {
      this.#onAbort = () => this.kill(new ProviderCancelled());
      signal.addEventListener("abort", this.#onAbort, { once: true });
    }
  }

  /**
   * An EOF-delimited body cut by a reset: Node's parser completes such a
   * message, while http.client's `recv` raises `ConnectionResetError`.
   */
  abruptEnd(res: http.IncomingMessage): Error | null {
    if (this.reason) return this.reason;
    const code = this.socketError;
    if (!code || !TRANSPORT_CODES[code]) return null;
    if (res.headers["content-length"] !== undefined || /chunked/i.test(String(res.headers["transfer-encoding"] ?? ""))) return null;
    const [category, name] = TRANSPORT_CODES[code] as [never, string];
    return new ProviderTransportError(category, name);
  }

  /**
   * Why a body read cannot continue, or null while it can. Like
   * http.client, a peer that closes a Content-Length body early yields a
   * short read ("eof"); only broken chunked framing is `IncompleteRead`.
   */
  bodyFailure(res: http.IncomingMessage): Error | "eof" | null {
    if (this.reason) return this.reason;
    if (!res.destroyed && !res.readableAborted && !res.errored) return null;
    if (this.socketError && TRANSPORT_CODES[this.socketError]) {
      const [category, name] = TRANSPORT_CODES[this.socketError] as [never, string];
      return new ProviderTransportError(category, name);
    }
    if (!/chunked/i.test(String(res.headers["transfer-encoding"] ?? ""))) return "eof";
    return new ProviderProtocolError("IncompleteRead", "incomplete read");
  }

  /** Map a request-level error before the response, like urllib's `do_open`. */
  requestFailure(error: NodeJS.ErrnoException, hint: TransportHint | null = null): Error {
    if (this.reason) return this.reason;
    const code = error.code ?? "";
    if (isTlsCode(code)) hint = "tls"; // CERT_* / ERR_TLS_*: Python's URLError, never retried by ZCode
    if (code.startsWith("HPE_")) return new ProviderProtocolError("BadStatusLine", "invalid HTTP response");
    if (code === "ERR_UNESCAPED_CHARACTERS" || code === "ERR_INVALID_CHAR") return new ProviderProtocolError("InvalidURL", "invalid URL");
    if (this.phase === "connect") {
      const category = code === "ECONNREFUSED" ? "service_unready" : code === "ETIMEDOUT" ? "timeout" : "connection_failed";
      return new ProviderTransportError(category, "URLError", undefined, hint);
    }
    if (code === "ECONNRESET" && /socket hang up/.test(error.message)) {
      return new ProviderTransportError("connection_failed", "RemoteDisconnected", undefined, hint);
    }
    const [category, name] = TRANSPORT_CODES[code] ?? ["connection_failed", "OSError"];
    return new ProviderTransportError(category, name, undefined, hint);
  }

  close(): void {
    this.#idle.stop();
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers = [];
    if (this.#onAbort) this.#spec.signal?.removeEventListener("abort", this.#onAbort);
    this.#onAbort = null;
    this.req?.destroy();
    this.socket?.destroy();
  }
}

/** `CONNECT host:port` through an HTTP proxy; resolves with the raw tunnel socket. */
function openTunnel(exchange: Exchange, spec: HttpRequestSpec, proxy: ProxyTarget, target: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Host: target };
    if (proxy.authorization) headers["Proxy-Authorization"] = proxy.authorization;
    const req = http.request({ host: proxy.host, port: proxy.port, method: "CONNECT", path: target, headers, agent: false });
    exchange.req = req;
    let untrack = (): void => undefined;
    req.on("socket", (socket: Socket) => {
      untrack = exchange.track(socket);
      socket.once("connect", () => exchange.touch());
    });
    req.on("finish", () => exchange.sending(false));
    req.on("error", (error: NodeJS.ErrnoException) => reject(exchange.requestFailure(error, "proxy")));
    req.on("connect", (res, socket) => {
      untrack();
      exchange.touch();
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new ProviderTransportError("connection_failed", "URLError", "Tunnel connection failed", "proxy"));
        return;
      }
      resolve(socket);
    });
    req.end();
  });
}

/** Send one request and resolve once the status line and headers arrive. */
export async function openHttp(spec: HttpRequestSpec): Promise<HttpResponse> {
  if (spec.signal?.aborted) throw new ProviderCancelled();
  const exchange = new Exchange(spec);
  exchange.watch();
  const secure = spec.url.scheme === "https";
  const host = spec.url.hostname ?? "";
  const port = spec.url.port ? Number(spec.url.port) : secure ? 443 : 80;
  const path = `${spec.url.path || "/"}${spec.url.query ? `?${spec.url.query}` : ""}`;
  // urllib's Host is the URL's netloc as written (Node would add `:443` without an agent).
  const netloc = pyUnquote(spec.url.netloc);
  const headers: Record<string, string> = {
    ...spec.headers, Host: netloc.slice(netloc.lastIndexOf("@") + 1), Connection: "close", "Accept-Encoding": "identity", "User-Agent": "Xueness-TS",
  };
  if (spec.body) headers["Content-Length"] = String(spec.body.length);
  try {
    const proxy = secure ? (spec.proxy === undefined ? httpsProxyFor(spec.url.netloc) : spec.proxy) : null;
    const tunnel = proxy ? await openTunnel(exchange, spec, proxy, `${host.includes(":") ? `[${host}]` : host}:${port}`) : null;
    return await new Promise<HttpResponse>((resolve, reject) => {
      const tlsOptions = secure ? { secureContext: trustedSecureContext(), ...(isIpLiteral(host) ? {} : { servername: host }) } : {};
      // Node ignores `createConnection` under an agent, and `agent: false` makes one.
      const viaTunnel = tunnel ? { createConnection: () => tls.connect({ socket: tunnel, ...tlsOptions }) } : null;
      const options: https.RequestOptions = {
        host, port, path, method: spec.method, headers, ...tlsOptions, ...(viaTunnel ?? { agent: false }),
      };
      const req = (secure ? https : http).request(options);
      exchange.req = req;
      exchange.sending(true);
      let sent = false;
      let early: http.IncomingMessage | null = null;
      const respond = (res: http.IncomingMessage): void => {
        exchange.phase = "body";
        resolve(new HttpResponse(exchange, res));
      };
      req.on("socket", (socket) => {
        exchange.socket = socket;
        exchange.track(socket);
        socket.on("error", (error: NodeJS.ErrnoException) => {
          exchange.socketError ??= error.code ?? "EIO";
        });
        // Like Python's connect and TLS handshake, each gets the full timeout.
        socket.once("connect", () => exchange.touch());
        if (secure) socket.once("secureConnect", () => exchange.touch());
      });
      req.on("finish", () => {
        // Node reports a failed last write as finished too; its error follows.
        if (req.socket?.errored) return;
        sent = true;
        exchange.sending(false);
        // urllib wraps failures in URLError until the request is sent (`h.request`).
        if (exchange.phase === "connect") exchange.phase = "response";
        if (early) respond(early);
      });
      req.on("error", (error: NodeJS.ErrnoException) => reject(exchange.requestFailure(error)));
      // Destroyed with a held response, Node reports no error: the kill's reason is it.
      req.on("close", () => reject(exchange.reason ?? new ProviderTransportError("connection_failed", "URLError")));
      // urllib reads a response only after `sendall` sent the whole request.
      req.on("response", (res) => (sent ? respond(res) : (early = res)));
      // Submit bounded writes sequentially. A single huge Windows write can
      // complete into the kernel's buffer before the peer consumes anything,
      // incorrectly moving failures into the response phase. Keeping one
      // bounded write in flight also bounds Node's pending writable queue.
      let offset = 0;
      const send = (): void => {
        if (req.destroyed) return;
        if (!spec.body || offset >= spec.body.length) { req.end(); return; }
        const next = spec.body.subarray(offset, offset + (64 << 10));
        offset += next.length;
        req.write(next, (error) => { if (!error) send(); });
      };
      send();
    });
  } catch (error) {
    exchange.close();
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ERR_INVALID_ARG_VALUE") throw new ProviderProtocolError("InvalidURL", "invalid URL");
    throw error;
  }
}
