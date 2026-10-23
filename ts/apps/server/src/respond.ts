/**
 * Responses in the Python backend's shape: same headers (`Content-Type`,
 * `Content-Length`, `Cache-Control: no-store`, `X-Content-Type-Options:
 * nosniff`, `Connection: close` when the body was not consumed) and the
 * shared JSON error envelope.
 */
import type { ServerResponse } from "node:http";
import { STATUS_CODES as REASONS } from "node:http";
import type { Duplex } from "node:stream";
import { isDict, normalizeError, PROTOCOL_ERRORS, pyJsonDumps } from "@xueness/contracts";

export const SERVER_HEADER = "XuenessWeb/0.1 (front door)";

export interface SendOptions {
  /** Close the connection after the response (request body left unread). */
  close?: boolean;
  /** Extra response headers (a route's security headers); the standard ones win. */
  headers?: Readonly<Record<string, string>>;
}

export function sendBody(res: ServerResponse, status: number, body: Uint8Array, contentType: string, options: SendOptions = {}): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.statusCode = status;
  for (const [name, value] of Object.entries(options.headers ?? {})) res.setHeader(name, value);
  res.setHeader("Server", SERVER_HEADER);
  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Length", body.byteLength);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (options.close) {
    res.setHeader("Connection", "close");
    res.shouldKeepAlive = false;
  } else {
    // Like Python: no `Connection: keep-alive`/`Keep-Alive` lines; HTTP/1.0
    // and HTTP/0.9 clients still get the connection closed after the answer.
    res.removeHeader("connection");
  }
  res.end(body);
}

export function jsonBytes(status: number, payload: unknown): Buffer {
  const value = status >= 400 && isDict(payload) ? normalizeError(status, payload) : payload;
  return Buffer.from(pyJsonDumps(value), "utf8");
}

export function sendJson(res: ServerResponse, status: number, payload: unknown, options: SendOptions = {}): void {
  sendBody(res, status, jsonBytes(status, payload), "application/json", options);
}

export interface ProtocolReply {
  status: number;
  code: string;
  message: string;
}

/** Python's framing refusals (`_prepare_read`, `_declared_length`). */
export const FRAMING_ERRORS = Object.freeze({
  lengthRequired: { status: 411, code: "length_required", message: "Content-Length is required" },
  invalidLength: { status: 400, code: "invalid_content_length", message: "invalid Content-Length" },
  tooLarge: { status: 413, code: "payload_too_large", message: "request body is too large" },
} satisfies Record<string, ProtocolReply>);

const PARSER_STATUS: Readonly<Record<string, number>> = Object.freeze({
  HPE_HEADER_OVERFLOW: 431,
  HPE_INVALID_METHOD: 501,
  HPE_INVALID_VERSION: 505,
  ERR_HTTP_REQUEST_TIMEOUT: 408,
  ERR_HTTP_HEADERS_TIMEOUT: 408,
});

/** Map a Node HTTP parser error to the answer Python's handler would give. */
export function protocolReply(error: NodeJS.ErrnoException & { reason?: string }): ProtocolReply {
  switch (error.code) {
    case "HPE_INVALID_TRANSFER_ENCODING":
      // Python answers 411 to any Transfer-Encoding at all.
      return FRAMING_ERRORS.lengthRequired;
    case "HPE_INVALID_CONTENT_LENGTH":
    case "HPE_UNEXPECTED_CONTENT_LENGTH":
      // Bad digits, overflow, empty or duplicate lengths; next to Transfer-Encoding it is 411 again.
      return /transfer-encoding/i.test(error.reason ?? error.message) ? FRAMING_ERRORS.lengthRequired : FRAMING_ERRORS.invalidLength;
    default: {
      const status = PARSER_STATUS[error.code ?? ""] ?? 400;
      const [code, message] = PROTOCOL_ERRORS[status] ?? ["bad_request", "bad request"];
      return { status, code, message };
    }
  }
}

export function protocolStatus(error: NodeJS.ErrnoException & { reason?: string }): number {
  return protocolReply(error).status;
}

export interface ProtocolErrorOptions {
  code?: string;
  message?: string;
  /** Send `Connection: close` (Python's `send_error` does; its timeout answer does not). */
  connectionHeader?: boolean;
}

/** Fixed-phrase protocol error written straight to the socket, then close. */
export function writeProtocolError(socket: Duplex, status: number, options: ProtocolErrorOptions = {}): void {
  if (!socket.writable) {
    socket.destroy();
    return;
  }
  const [code, message] = PROTOCOL_ERRORS[status] ?? ["error", "request failed"];
  const body = jsonBytes(status, { error: options.message ?? message, code: options.code ?? code });
  const head = [
    `HTTP/1.1 ${status} ${REASONS[status] ?? "Error"}`,
    `Server: ${SERVER_HEADER}`,
    `Date: ${new Date().toUTCString()}`,
    "Content-Type: application/json",
    `Content-Length: ${body.length}`,
    "Cache-Control: no-store",
    "X-Content-Type-Options: nosniff",
    ...(options.connectionHeader === false ? [] : ["Connection: close"]),
    "",
    "",
  ].join("\r\n");
  socket.end(Buffer.concat([Buffer.from(head, "latin1"), body]));
}
