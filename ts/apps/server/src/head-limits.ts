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
 *
 * Bun's HTTP parser never surfaces head bytes to JavaScript (`bytesRead`
 * stays 0 and `data` never fires), so heads are timed by the TCP front that
 * owns the socket before the parser attaches (`frontSocketHead`); Node's own
 * `headersTimeout`/`keepAliveTimeout` keep working in parallel and funnel
 * into the same `expireHead`.
 */
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

type TimedSocket = Duplex & {
  readonly bytesRead?: number;
  setTimeout(ms: number, callback?: () => void): TimedSocket;
};
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
/** Bytes each connection has received; Bun's `socket.bytesRead` stays stale. */
const received = new WeakMap<Duplex, number>();
const expired = new WeakSet<Duplex>();
// Node's native HTTP parser can consume bytes without emitting a JS data event.
const bytesReceived = (socket: Duplex): number => Math.max(received.get(socket) ?? 0, (socket as TimedSocket).bytesRead ?? 0);

/** The front's own timing for one socket's current head. */
interface FrontedHead {
  limits: () => HeadLimits;
  outcomes: HeadOutcomes;
  /** The head deadline; the idle limit is the socket timeout itself. */
  deadline: NodeJS.Timeout | null;
  /** True while the socket waits for the first byte of its next head. */
  awaitingHead: boolean;
}
const fronted = new WeakMap<Duplex, FrontedHead>();

function expireWith(socket: Duplex, state: FrontedHead): void {
  if (process.env.XUENESS_HEAD_DEBUG) process.stderr.write(`[head-debug] expire t=${Date.now() % 100000} rx=${received.get(socket)} ans=${answeredUpTo.get(socket)} destroyed=${socket.destroyed}\n`);
  // Disarm first: Bun keeps a timed socket open across `destroy` otherwise.
  (socket as TimedSocket).setTimeout(0);
  if (state.deadline) clearTimeout(state.deadline);
  state.deadline = null;
  expireHead(socket, state.outcomes);
}

/** Time a head the TCP front itself owns (see `frontSocketHead`). */
function armDeadline(socket: Duplex, state: FrontedHead): void {
  if (state.deadline) clearTimeout(state.deadline);
  state.deadline = setTimeout(() => expireWith(socket, state), state.limits().deadlineMs);
}

/** Count head bytes and time the wait for each head on the fronted socket. */
export function frontSocketHead(socket: Duplex, limits: () => HeadLimits, outcomes: HeadOutcomes): void {
  const state: FrontedHead = { limits, outcomes, deadline: null, awaitingHead: true };
  fronted.set(socket, state);
  received.set(socket, 0);
  socket.on("data", (chunk: Buffer | string) => {
    received.set(socket, (received.get(socket) ?? 0) + chunk.length);
    if (!state.awaitingHead) return;
    // The next head has started: its deadline runs from its first byte.
    state.awaitingHead = false;
    armDeadline(socket, state);
  });
  socket.once("close", () => {
    (socket as TimedSocket).setTimeout(0);
    if (state.deadline) clearTimeout(state.deadline);
    state.deadline = null;
  });
  // Python's idle limit between bytes; the socket timeout re-arms on activity.
  (socket as TimedSocket).setTimeout(limits().idleMs, () => expireWith(socket, state));
  // Like Node's `headersTimeout`, the first head's deadline starts at accept.
  armDeadline(socket, state);
}

/** Node's keep-alive wait doubles as Python's wait for the next head. */
export function applyHeadLimits(server: Server, limits: HeadLimits): void {
  server.headersTimeout = limits.deadlineMs;
  server.keepAliveTimeout = Math.min(limits.idleMs, limits.deadlineMs);
}

/**
 * Heads also flow through Node's own limits: `headersTimeout` for the head
 * and the idle `keepAliveTimeout` between heads raise `timeout` here.
 */
export function trackHeadLimits(server: Server, limits: () => HeadLimits, outcomes: HeadOutcomes): void {
  server.on("connection", (socket: Duplex & { setTimeout(ms: number): unknown }) => {
    answeredUpTo.set(socket, 0);
    const { idleMs, deadlineMs } = limits();
    socket.setTimeout(Math.min(idleMs, deadlineMs));
  });
  // With a listener here Node no longer destroys timed-out sockets itself.
  server.on("timeout", (socket: Duplex) => {
    const state = fronted.get(socket);
    if (state) expireWith(socket, state);
    else expireHead(socket, outcomes);
  });
}

/** The head is complete: from here on Python's own timers apply. */
export function headReceived(req: IncomingMessage, res: ServerResponse): void {
  const socket = req.socket;
  (socket as TimedSocket).setTimeout(0);
  const state = fronted.get(socket);
  if (state) {
    if (state.deadline) clearTimeout(state.deadline);
    state.deadline = null;
  }
  res.once("finish", () => {
    answeredUpTo.set(socket, bytesReceived(socket));
    if (!state) return;
    // Python waits for the next head with the idle limit armed again.
    state.awaitingHead = true;
    (socket as TimedSocket).setTimeout(state.limits().idleMs, () => expireWith(socket, state));
  });
}

/** A head limit ran out (Node's headers timeout or the idle timer). */
export function expireHead(socket: Duplex, outcomes: HeadOutcomes): void {
  if (expired.has(socket)) return;
  expired.add(socket);
  if (bytesReceived(socket) > (answeredUpTo.get(socket) ?? 0)) {
    outcomes.timedOut();
    // Python's timeout answer goes through `_reject`, not `send_error`, so it
    // carries no `Connection: close` line; the connection closes all the same.
    writeProtocolError(socket, 408, { connectionHeader: false });
  } else {
    outcomes.closedSilently();
    // A graceful FIN (not destroy's RST): pooled clients then reopen instead of
    // surfacing ECONNRESET on their next request over the dead socket.
    socket.end();
  }
}

export function isHeadTimeout(error: NodeJS.ErrnoException): boolean {
  return error.code === "ERR_HTTP_REQUEST_TIMEOUT" || error.code === "ERR_HTTP_HEADERS_TIMEOUT";
}
