/**
 * Queue-aware per-tool deadline (C-TOOL-06): the wall-clock budget covers only
 * active tool execution. A nested model request waiting in an admission queue
 * pauses the countdown (model_request_queued) and admission resumes it
 * (model_request_admitted), so queueing never false-times-out a call. An
 * external AbortSignal always wins immediately, even while paused; a timeout
 * settlement separates queued time from active time in its report.
 */
import { failure, type ToolResult } from "@xueness/engine-tools";

export interface ToolDeadlineOptions {
  /** Total budget for ACTIVE tool execution in ms; queued time does not count. Must be a finite number > 0. */
  timeoutMs: number;
  /** External cancellation (call cancelled, plugin unloaded). Takes effect immediately, even while paused. */
  signal?: AbortSignal;
  /** Clock for duration accounting; defaults to Date.now. */
  now?: () => number;
}

/** The active budget ran out; `queuedMs` is the queue time that was not charged. */
export class ToolDeadlineExceededError extends Error {
  override name = "ToolDeadlineExceededError";
  readonly code = "tool_timeout";
  readonly queuedMs: number;
  readonly activeMs: number;
  readonly timeoutMs: number;
  constructor(detail: { queuedMs: number; activeMs: number; timeoutMs: number }) {
    super(`tool execution timed out after ${detail.timeoutMs}ms (queued ${detail.queuedMs}ms not counted)`);
    this.queuedMs = detail.queuedMs;
    this.activeMs = detail.activeMs;
    this.timeoutMs = detail.timeoutMs;
  }
}

/** The call was cancelled from outside before the budget ran out. */
export class ToolDeadlineCancelledError extends Error {
  override name = "ToolDeadlineCancelledError";
  readonly code = "cancelled";
  constructor() {
    super("tool execution cancelled before its deadline");
  }
}

export class ToolDeadline {
  readonly #timeoutMs: number;
  readonly #now: () => number;
  readonly #controller = new AbortController();
  #timer: NodeJS.Timeout | null = null;
  #segmentStart = 0;
  #pausedAt: number | null = null;
  #activeMs = 0;
  #queuedMs = 0;
  #expired = false;
  #cancelled = false;
  #finished = false;
  #settled: Promise<never> | null = null;
  #settleRejecter: ((error: Error) => void) | null = null;
  #settleError: Error | null = null;
  #externalSignal: AbortSignal | null = null;
  #onExternalAbort: (() => void) | null = null;

  constructor(options: ToolDeadlineOptions) {
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
      throw new TypeError(`timeoutMs must be a finite number > 0 (got ${String(options.timeoutMs)})`);
    }
    this.#timeoutMs = options.timeoutMs;
    this.#now = options.now ?? Date.now;
    if (options.signal) {
      if (options.signal.aborted) this.#cancel();
      else {
        this.#externalSignal = options.signal;
        this.#onExternalAbort = () => this.#cancel();
        options.signal.addEventListener("abort", this.#onExternalAbort, { once: true });
      }
    }
    if (!this.#cancelled) this.#arm();
  }

  /** Combined signal: aborts on expiry or external cancellation; the reason says which. */
  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  get expired(): boolean {
    return this.#expired;
  }

  get cancelled(): boolean {
    return this.#cancelled;
  }

  get paused(): boolean {
    return this.#pausedAt !== null;
  }

  /** Queue time not charged to the budget; live-updates while paused. */
  get queuedMs(): number {
    const waiting = this.#pausedAt !== null && !this.#settledState() ? this.#now() - this.#pausedAt : 0;
    return this.#queuedMs + Math.max(0, waiting);
  }

  /** Active budget consumed so far; frozen at the full budget once expired. */
  get activeMs(): number {
    if (this.#expired) return this.#timeoutMs;
    if (this.#pausedAt !== null || this.#settledState()) return this.#activeMs;
    return this.#activeMs + (this.#now() - this.#segmentStart);
  }

  /** model_request_queued: stop the countdown. */
  pause(): void {
    if (this.#pausedAt !== null || this.#settledState()) return;
    this.#disarm();
    this.#activeMs += this.#now() - this.#segmentStart;
    this.#pausedAt = this.#now();
  }

  /** model_request_admitted: restart the countdown on the remaining budget. */
  resume(): void {
    if (this.#pausedAt === null || this.#settledState()) return;
    this.#queuedMs += this.#now() - this.#pausedAt;
    this.#pausedAt = null;
    if (this.#activeMs >= this.#timeoutMs) this.#expire();
    else {
      this.#segmentStart = this.#now();
      this.#arm();
    }
  }

  /**
   * Settle a tool run against the deadline: the run's own outcome wins when it
   * comes first; expiry rejects with ToolDeadlineExceededError and external
   * cancellation with ToolDeadlineCancelledError. Cleanup after settlement
   * never disturbs a run that already finished.
   */
  race<T>(run: Promise<T>): Promise<T> {
    // Once the run settles the countdown is moot: disarm, detach listener, and freeze transitions.
    return Promise.race([run, this.#settlement()]).finally(() => {
      this.#finished = true;
      this.#disarm();
      this.#detach();
    });
  }

  #settledState(): boolean {
    return this.#expired || this.#cancelled || this.#finished;
  }

  /** Rejects (never resolves) once the deadline settles; paused time simply never fires it. */
  #settlement(): Promise<never> {
    if (!this.#settled) {
      if (this.#settleError) return Promise.reject(this.#settleError);
      this.#settled = new Promise<never>((_, reject) => { this.#settleRejecter = reject; });
    }
    return this.#settled;
  }

  #arm(): void {
    this.#segmentStart = this.#now();
    this.#timer = setTimeout(() => this.#expire(), Math.max(0, this.#timeoutMs - this.#activeMs));
    this.#timer.unref?.();
  }

  #disarm(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  #detach(): void {
    if (this.#externalSignal && this.#onExternalAbort) {
      this.#externalSignal.removeEventListener("abort", this.#onExternalAbort);
    }
    this.#externalSignal = null;
    this.#onExternalAbort = null;
  }

  #expire(): void {
    if (this.#settledState() || this.#pausedAt !== null) return;
    this.#disarm();
    this.#detach();
    this.#activeMs = this.#timeoutMs;
    this.#expired = true;
    const error = new ToolDeadlineExceededError({ queuedMs: this.#queuedMs, activeMs: this.#activeMs, timeoutMs: this.#timeoutMs });
    this.#settleError = error;
    this.#settleRejecter?.(error);
    this.#controller.abort(error);
  }

  #cancel(): void {
    if (this.#settledState()) return;
    this.#disarm();
    this.#detach();
    if (this.#pausedAt !== null) {
      this.#queuedMs += this.#now() - this.#pausedAt;
      this.#pausedAt = null;
    } else this.#activeMs += this.#now() - this.#segmentStart;
    this.#cancelled = true;
    const error = new ToolDeadlineCancelledError();
    this.#settleError = error;
    this.#settleRejecter?.(error);
    this.#controller.abort(error);
  }
}

/** Timeout failure for a run the deadline ended; queuedMs is reported in the message and the data. */
export function deadlineFailure(toolName: string, error: ToolDeadlineExceededError): ToolResult {
  return {
    ...failure("tool_timeout", `${toolName} timed out after ${error.timeoutMs}ms of active execution (queued ${error.queuedMs}ms not counted)`),
    data: { timedOutAfterMs: error.timeoutMs, queuedMs: error.queuedMs, activeMs: error.activeMs },
  };
}
