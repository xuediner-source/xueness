/**
 * Request-head time limits with the outcomes of `xueness/web.py`.
 *
 * Python gives a request head `_HEADER_IDLE_SECONDS` (15 s) between bytes and
 * `_HEADER_DEADLINE_SECONDS` (20 s) in total. A connection that sent nothing
 * is closed without an answer; a head that had started gets 408
 * `request_timeout`. Bodies are not timed here: a proxied body is read (and
 * timed) by Python itself, and the TypeScript routes take no body.
 *
 * Known difference: Python closes silently when the request line itself is
 * unfinished; the front door cannot see the line boundary and answers 408.
 */
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { writeProtocolError } from "./respond.ts";

export const HEADER_IDLE_MS = 15_000;
export const HEADER_DEADLINE_MS = 20_000;

export interface HeadLimits {
  idleMs: number;
  deadlineMs: number;
}

export interface HeadOutcomes {
  /** A started head ran out of time: 408 was sent. */
  timedOut(): void;
  /** Nothing was sent before a limit ran out: closed without an answer. */
  closedSilently(): void;
}

/** Bytes read on each connection up to the end of its latest answer. */
const answeredUpTo = new WeakMap<Duplex, number>();
const expired = new WeakSet<Duplex>();

function bytesRead(socket: Duplex): number {
  return (socket as Duplex & { bytesRead?: number }).bytesRead ?? 0;
}

/** Node's keep-alive wait doubles as Python's wait for the next head. */
export function applyHeadLimits(server: Server, limits: HeadLimits): void {
  server.headersTimeout = limits.deadlineMs;
  server.keepAliveTimeout = Math.min(limits.idleMs, limits.deadlineMs);
}

/**
 * Time every head. Node's `headersTimeout` is the deadline (counted from
 * the connection, then from the first byte of each later head); a socket
 * timeout is the idle limit until the first head is complete.
 */
export function trackHeadLimits(server: Server, limits: () => HeadLimits, outcomes: HeadOutcomes): void {
  server.on("connection", (socket: Duplex & { setTimeout(ms: number): unknown }) => {
    answeredUpTo.set(socket, 0);
    const { idleMs, deadlineMs } = limits();
    socket.setTimeout(Math.min(idleMs, deadlineMs));
  });
  // With a listener here Node no longer destroys timed-out sockets itself.
  server.on("timeout", (socket: Duplex) => expireHead(socket, outcomes));
}

/** The head is complete: from here on Python's own timers apply. */
export function headReceived(req: IncomingMessage, res: ServerResponse): void {
  const socket = req.socket;
  socket.setTimeout(0);
  res.once("finish", () => answeredUpTo.set(socket, socket.bytesRead));
}

/** A head limit ran out (Node's headers timeout or the idle timer). */
export function expireHead(socket: Duplex, outcomes: HeadOutcomes): void {
  if (expired.has(socket)) return;
  expired.add(socket);
  if (bytesRead(socket) > (answeredUpTo.get(socket) ?? 0)) {
    outcomes.timedOut();
    // Python's timeout answer goes through `_reject`, not `send_error`, so it
    // carries no `Connection: close` line; the connection closes all the same.
    writeProtocolError(socket, 408, { connectionHeader: false });
  } else {
    outcomes.closedSilently();
    socket.destroy();
  }
}

export function isHeadTimeout(error: NodeJS.ErrnoException): boolean {
  return error.code === "ERR_HTTP_REQUEST_TIMEOUT" || error.code === "ERR_HTTP_HEADERS_TIMEOUT";
}
