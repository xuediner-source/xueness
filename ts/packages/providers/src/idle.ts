/**
 * Python's socket timeout for Node sockets.
 *
 * `socket.settimeout(t)` bounds each blocking call: a connect, the TLS
 * handshake, a `sendall` (in total: progress does not extend it, so the
 * request goes out within one timeout), a `recv` that gets nothing. Node's
 * idle timer differs: it counts whole milliseconds and can fire a little
 * early, it skips a period after any asynchronous write, so a stalled TLS
 * handshake or upload took twice the timeout, and it also ran while the
 * consumer was busy with buffered data, when Python is not blocked in
 * `recv`. This timer measures on `performance.now()`, only while a call is
 * blocked, and restarts only where Python starts a new blocking call.
 */
import type { Socket } from "node:net";
import { performance } from "node:perf_hooks";

export class IdleTimer {
  #ms: number;
  #activity = performance.now();
  #timer: NodeJS.Timeout | null = null;
  #stopped = false;
  #blocked = true;
  #sending = true;
  readonly #expire: () => void;

  constructor(ms: number, expire: () => void) {
    this.#ms = ms;
    this.#expire = expire;
    this.#arm();
  }

  /** A new blocking call starts (connected, handshake done, data arrived): a new period. */
  touch(): void {
    this.#activity = performance.now();
  }

  /** A request starts or finishes going out; while it does, arriving data is no progress. */
  sending(on: boolean): void {
    if (!on && this.#sending) this.touch();
    this.#sending = on;
  }

  /** A read starts or stops waiting for data; each wait gets the full timeout. */
  block(on: boolean): void {
    if (on && !this.#blocked) this.touch();
    this.#blocked = on;
  }

  /** `settimeout(ms)`: the next wait gets the new timeout in full. */
  set(ms: number): void {
    this.#ms = ms;
    this.touch();
    this.#arm();
  }

  /** Count data arriving on `socket` as activity; returns the unwatch hook. */
  watch(socket: Socket): () => void {
    const data = (): void => {
      if (!this.#sending) this.touch();
    };
    const closed = (): void => this.stop();
    socket.on("data", data);
    socket.once("close", closed);
    return () => {
      socket.off("data", data);
      socket.off("close", closed);
    };
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  #arm(): void {
    if (this.#stopped) return;
    if (this.#timer) clearTimeout(this.#timer);
    const left = this.#activity + this.#ms - performance.now();
    this.#timer = setTimeout(() => this.#check(), Math.max(1, Math.ceil(left)));
    this.#timer.unref();
  }

  #check(): void {
    this.#timer = null;
    if (this.#stopped) return;
    if (!this.#blocked) this.touch();
    // Timers may fire early: expire only once the period has really passed.
    if (this.#activity + this.#ms - performance.now() > 0) {
      this.#arm();
      return;
    }
    this.stop();
    this.#expire();
  }
}
