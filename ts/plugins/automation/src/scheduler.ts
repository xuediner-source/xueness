/**
 * The local cron daemon (Python `automation/scheduler.py` `Scheduler`).
 *
 * One timer ticks every 15 seconds: while the automation plugin is enabled it
 * claims every due schedule through `Automations.run(due=true)` and runs one
 * off-peak queue pass, exactly as Python's daemon thread does. A schedule or
 * queue that is corrupt, disabled or mid-flight is swallowed the same way the
 * Python loop swallows `(ValueError, OSError, KeyError)`.
 */
import { numericValue, pyTruthy } from "@xueness/contracts";
import { isPyKeyError, isPyOSError, isPyValueError } from "@xueness/sessions";
import { OffPeakQueue } from "./off-peak-queue.ts";
import { pick, requireEnabled, type WorkflowBridge } from "./off-peak.ts";
import { Automations } from "./store.ts";

const TICK_SECONDS = 15;

export interface SchedulerOptions {
  allowReal?: boolean;
  clock?: () => number;
  idleCheck?: (state: string) => boolean;
  bridge?: WorkflowBridge;
}

export class Scheduler {
  readonly #state: string;
  readonly #allowReal: boolean;
  readonly #clock: () => number;
  readonly #bridge: WorkflowBridge | null;
  readonly #queue: OffPeakQueue;
  #timer: NodeJS.Timeout | null = null;

  constructor(state: string, options: SchedulerOptions = {}) {
    this.#state = state;
    this.#allowReal = options.allowReal === true;
    this.#clock = options.clock ?? (() => Date.now() / 1000);
    this.#bridge = options.bridge ?? null;
    this.#queue = new OffPeakQueue(state, {
      clock: this.#clock,
      allowRealHost: this.#allowReal,
      ...(options.idleCheck ? { idleCheck: options.idleCheck } : {}),
      bridge: options.bridge,
    });
    // Python's daemon thread makes its first pass at once, then waits 15 seconds.
    this.#timer = setInterval(() => this.#guarded(), TICK_SECONDS * 1000);
    this.#timer.unref();
    setImmediate(() => { if (this.#timer !== null) this.#guarded(); }).unref();
  }

  /** An unexpected error ends Python's daemon thread, not the process: stop ticking instead. */
  #guarded(): void {
    try { this.#tick(); } catch { this.close(); }
  }

  /** One scheduler pass; `requireEnabled` throws `PluginDisabled` when off, which is swallowed. */
  #tick(): void {
    try {
      requireEnabled(this.#state);
      const store = new Automations(this.#state, { enabled: () => true, bridge: this.#bridge ?? undefined });
      for (const row of store.list()) {
        if (!pyTruthy(pick(row, "enabled"))) continue;
        // `nextRunAt` is stored as a float, which the lossless reader keeps boxed.
        const next = numericValue(pick(row, "nextRunAt"));
        if (next !== null && next <= this.#clock()) {
          store.run(String(pick(row, "id")), { due: true, now: this.#clock(), allowRealHost: this.#allowReal, bridge: this.#bridge ?? undefined });
        }
      }
      this.#queue.tick(this.#clock());
    } catch (error) {
      if (!isPyValueError(error) && !isPyOSError(error) && !isPyKeyError(error)) throw error;
    }
  }

  close(): void {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }
}
