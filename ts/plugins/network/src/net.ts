/**
 * The two operations the transport needs from the outside world: the system
 * resolver (`socket.getaddrinfo`) and one HTTPS exchange pinned to a checked
 * address while TLS verifies the requested host (`_PinnedHTTPS`). Tests swap
 * in scripted versions; failures carry Node's error codes.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type { IncomingMessage } from "node:http";

export interface HttpExchange { host: string; address: string; method: "GET" | "POST"; path: string; headers: Record<string, string>; body?: Buffer; timeoutMs: number; signal?: AbortSignal }
export interface HttpResponse {
  status: number;
  /** `getheader("Content-Type", "")`. */
  contentType: string;
  /** `getheader("Location")`; older test doubles may omit it. */
  location?: string;
  /** `response.read(limit)`: at most `limit` bytes of the body. */
  read(limit: number): Promise<Buffer>;
  close(): void;
}
export interface Net {
  /** `getaddrinfo(host, 443, SOCK_STREAM)` addresses; rejects with the resolver's code (ENOTFOUND, EAI_AGAIN, ...). */
  lookup(host: string): Promise<string[]>;
  request(exchange: HttpExchange): Promise<HttpResponse>;
}
export interface NodeNetOptions {
  /** Tests only: extra trusted CA and where a pinned address really connects. */
  ca?: string;
  redirect?: (address: string) => { host: string; port: number };
}

class Coded extends Error { readonly code: string; constructor(code: string, message: string) { super(message); this.code = code; } }

function body(response: IncomingMessage, limit: number, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0, done = false;
    const finish = (error: Error | null): void => {
      if (done) return; done = true; response.socket?.setTimeout(0);
      if (error) reject(error); else resolve(Buffer.concat(chunks, size).subarray(0, limit));
    };
    response.socket?.setTimeout(timeoutMs, () => { finish(new Coded("ETIMEDOUT", "read timed out")); response.destroy(); });
    response.on("data", (chunk: Buffer) => { chunks.push(chunk); size += chunk.length; if (size >= limit) { finish(null); response.destroy(); } });
    response.on("end", () => finish(response.complete ? null : new Coded("ECONNRESET", "incomplete read")));
    response.on("aborted", () => finish(new Coded("ECONNRESET", "incomplete read")));
    response.on("error", (error) => finish(error));
    response.on("close", () => finish(response.complete ? null : new Coded("ECONNRESET", "incomplete read")));
  });
}

export function nodeNet(options: NodeNetOptions = {}): Net {
  return {
    async lookup(host) {
      const records = await dnsLookup(host, { all: true, verbatim: true });
      return records.map((record) => record.address);
    },
    request(exchange) {
      return new Promise((resolve, reject) => {
        const target = options.redirect?.(exchange.address) ?? { host: exchange.address, port: 443 };
        const family = isIP(target.host) || 4;
        const literal = isIP(exchange.host) !== 0;
        const request = httpsRequest({
          host: exchange.host, port: target.port, method: exchange.method, path: exchange.path, agent: false,
          headers: { ...exchange.headers, ...(exchange.body ? { "Content-Length": String(exchange.body.length) } : {}) },
          ...(literal ? {} : { servername: exchange.host }), ...(options.ca ? { ca: options.ca } : {}),
          lookup: ((_name: string, lookupOptions: { all?: boolean }, callback: (...args: unknown[]) => void) => {
            if (lookupOptions?.all) callback(null, [{ address: target.host, family }]); else callback(null, target.host, family);
          }) as never,
          ...(exchange.signal ? { signal: exchange.signal } : {}),
        });
        const timer = (): void => { request.destroy(new Coded("ETIMEDOUT", "timed out")); };
        request.setTimeout(exchange.timeoutMs, timer);
        request.once("error", reject);
        request.once("response", (response: IncomingMessage) => {
          request.setTimeout(0);
          const header = response.headers["content-type"];
          const location = response.headers.location;
          resolve({ status: response.statusCode ?? 0, contentType: Array.isArray(header) ? header.join(", ") : header ?? "",
            ...(typeof location === "string" ? { location } : {}),
            read: (limit) => body(response, limit, exchange.timeoutMs), close: () => { response.destroy(); request.destroy(); } });
        });
        request.end(exchange.body);
      });
    },
  };
}

/** Python's exception class for a Node failure: what `except` clause would catch it. */
export function failureKind(error: unknown): "timeout" | "certificate" | "tls" | "other" {
  const code = String((error as { code?: unknown } | null)?.code ?? "");
  if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT") return "timeout";
  if (/^(?:CERT_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_|ERR_TLS_CERT_ALTNAME_INVALID|HOSTNAME_MISMATCH|INVALID_PURPOSE|PATH_LENGTH_EXCEEDED)/.test(code)) return "certificate";
  if (code === "EPROTO" || /^ERR_SSL_/.test(code) || /^ERR_TLS_/.test(code)) return "tls";
  return "other";
}
