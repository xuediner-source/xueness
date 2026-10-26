/**
 * Adaptive concurrency controller: a pure AIMD state machine for one
 * `${providerId}/${modelId}` key (upstream `ConcurrencyController`,
 * `@zcode/dynamic-workflow` `engine/concurrency.ts`).
 *
 * Pure discipline: no clock, no I/O — `now` (ms since epoch) is always passed
 * in; this class only answers "what is the cap now, may a request be admitted,
 * did this signal change anything". Who feeds signals and who queues (the
 * process admission policy in `admission-policy.ts`) live outside.
 *
 * The unit is one model request attempt: `inFlight` = admitted, not yet
 * released. Batch damping works through the epoch: every admitted request
 * carries the epoch it was admitted under, and a throttle verdict turns the
 * epoch, so one burst of 429s cuts the cap once, not once per refusal.
 *
 * Trimmed from upstream on purpose: the growth limit is fixed at
 * `AUTO_GROWTH_FACTOR × initial` (Xueness has no run-bound retuning or seat
 * gates yet), and there is no per-run event fan-out (no run subscriber surface
 * yet). Instead every signal method returns the cap changes it caused — the
 * same facts upstream fans out as `concurrency-changed` — and the process
 * admission policy projects them into its snapshot.
 */

/** A throttle cuts `cap = max(FLOOR, floor(cap × 0.75))`. */
export const ADMISSION_DECREASE_FACTOR = 0.75;
/** Additive increase step. */
export const ADMISSION_INCREASE_STEP = 1;
/** Consecutive current-epoch successes needed for one +1 probe. */
export const ADMISSION_INCREASE_AFTER_SUCCESSES = 4;
/** Always keep at least one probe running. */
export const ADMISSION_FLOOR = 1;
/** A key idle this long (and drained) forgets its learned cap. */
export const ADMISSION_IDLE_RESET_MS = 300_000;
/** Auto-growth ceiling relative to the initial concurrency. */
export const ADMISSION_AUTO_GROWTH_FACTOR = 2;

/** Upstream `ConcurrencyChangeReason`, minus the run-bound retune reasons Xueness trims. */
export type ConcurrencyChangeReason = "rate_limited" | "provider_overloaded" | "offpeak_queued" | "recovered" | "idle_reset";
/** Throttle-class reasons: cut the cap and arm the cooldown. */
export type ConcurrencyThrottleReason = Extract<ConcurrencyChangeReason, "rate_limited" | "provider_overloaded" | "offpeak_queued">;

/** One cap adjustment of a key (upstream `ConcurrencyChange`); the policy stamps `at` when projecting. */
export interface ModelConcurrencyChange {
  readonly key: string;
  readonly previous: number;
  readonly next: number;
  readonly reason: ConcurrencyChangeReason;
  readonly lastGood?: number;
  readonly lastBad?: number;
  /** A throttled change with Retry-After: how long new dispatch stays frozen (relative). */
  readonly cooldownMs?: number;
}

/** Read-only controller state (assertions and the execution snapshot). */
export interface ModelConcurrencySnapshot {
  readonly key: string;
  /** The configured default concurrency: start value and idle-reset target. */
  readonly initial: number;
  /** Auto-growth never takes the cap above this. */
  readonly growthLimit: number;
  readonly cap: number;
  /** Throttle verdict count; admitted requests carry it back for comparison. */
  readonly epoch: number;
  readonly inFlight: number;
  readonly waiters: number;
  readonly successStreak: number;
  readonly cooldownUntil?: number;
  readonly lastRequestAt?: number;
  readonly lastGood?: number;
  readonly lastBad?: number;
}

export class ModelConcurrencyController {
  readonly key: string;
  readonly initial: number;
  #growthLimit: number;
  #cap: number;
  #epoch = 0;
  #inFlight = 0;
  #waiters = 0;
  #successStreak = 0;
  #cooldownUntil?: number;
  #lastRequestAt?: number;
  #lastGood?: number;
  #lastBad?: number;

  constructor(key: string, initial: number, growthLimit: number = ADMISSION_AUTO_GROWTH_FACTOR * initial) {
    this.key = key;
    this.initial = initial;
    this.#cap = initial;
    this.#growthLimit = Math.max(initial, growthLimit);
  }

  snapshot(): ModelConcurrencySnapshot {
    return {
      key: this.key,
      initial: this.initial,
      growthLimit: this.#growthLimit,
      cap: this.#cap,
      epoch: this.#epoch,
      inFlight: this.#inFlight,
      waiters: this.#waiters,
      successStreak: this.#successStreak,
      ...(this.#cooldownUntil === undefined ? {} : { cooldownUntil: this.#cooldownUntil }),
      ...(this.#lastRequestAt === undefined ? {} : { lastRequestAt: this.#lastRequestAt }),
      ...(this.#lastGood === undefined ? {} : { lastGood: this.#lastGood }),
      ...(this.#lastBad === undefined ? {} : { lastBad: this.#lastBad }),
    };
  }

  /** Gate: fewer than `cap` in flight and not in a Retry-After cooldown. */
  canAdmit(now: number): boolean {
    return this.#inFlight < this.#cap && (this.#cooldownUntil === undefined || now >= this.#cooldownUntil);
  }

  /** Idle-reset check only; every admission path calls it first. */
  observe(now: number): ModelConcurrencyChange[] {
    return this.#idleReset(now);
  }

  /** A request is admitted: `inFlight++`, returns the epoch to carry back. */
  admitted(now: number): number {
    this.#lastRequestAt = now;
    this.#inFlight += 1;
    return this.#epoch;
  }

  /**
   * A request succeeded: `inFlight--`; only current-epoch successes extend the
   * streak. A full streak proves the current cap usable (`lastGood`), and with
   * waiters present and headroom left the cap rises by one.
   */
  succeeded(now: number, epoch: number): ModelConcurrencyChange[] {
    const changes = this.#idleReset(now);
    this.#inFlight = Math.max(0, this.#inFlight - 1);
    if (epoch !== this.#epoch) return changes;
    this.#successStreak += 1;
    if (this.#successStreak < ADMISSION_INCREASE_AFTER_SUCCESSES) return changes;
    if (this.#lastGood === undefined || this.#cap > this.#lastGood) this.#lastGood = this.#cap;
    if (this.#waiters <= 0 || this.#cap >= this.#growthLimit) return changes;
    const previous = this.#cap;
    this.#cap = Math.min(this.#growthLimit, this.#cap + ADMISSION_INCREASE_STEP);
    this.#successStreak = 0;
    changes.push({ key: this.key, previous, next: this.#cap, reason: "recovered" });
    return changes;
  }

  /**
   * Throttled (429 / overloaded / off-peak). Always `inFlight--` and streak
   * reset; a Retry-After pushes the cooldown to the later deadline. Only a
   * current-epoch verdict moves the cap: probing above `lastGood` falls back
   * to it, otherwise the wall moved and `cap` shrinks by the factor.
   */
  throttled(now: number, epoch: number, retryAfterMs?: number, reason: ConcurrencyThrottleReason = "rate_limited"): ModelConcurrencyChange[] {
    const changes = this.#idleReset(now);
    this.#inFlight = Math.max(0, this.#inFlight - 1);
    this.#successStreak = 0;
    const cooldownMs = retryAfterMs !== undefined && retryAfterMs > 0 ? retryAfterMs : undefined;
    if (cooldownMs !== undefined) {
      this.#cooldownUntil = Math.max(this.#cooldownUntil ?? 0, now + cooldownMs);
    }
    if (epoch !== this.#epoch) return changes;
    const previous = this.#cap;
    if (this.#lastGood !== undefined && this.#cap > this.#lastGood) {
      this.#lastBad = this.#cap;
      this.#cap = this.#lastGood;
    } else {
      this.#cap = Math.max(ADMISSION_FLOOR, Math.floor(this.#cap * ADMISSION_DECREASE_FACTOR));
      this.#lastBad = previous;
      this.#lastGood = undefined;
    }
    this.#epoch += 1;
    changes.push({
      key: this.key, previous, next: this.#cap, reason,
      ...(this.#lastGood !== undefined ? { lastGood: this.#lastGood } : {}),
      lastBad: this.#lastBad,
      ...(cooldownMs !== undefined ? { cooldownMs } : {}),
    });
    return changes;
  }

  /** Transient non-throttle failure (timeout / 5xx / network): streak reset, cap unchanged. */
  failedTransient(now: number): ModelConcurrencyChange[] {
    const changes = this.#idleReset(now);
    this.#inFlight = Math.max(0, this.#inFlight - 1);
    this.#successStreak = 0;
    return changes;
  }

  /** A request ended without a verdict (terminal failure, cancellation, bare release). */
  ended(now: number): ModelConcurrencyChange[] {
    const changes = this.#idleReset(now);
    this.#inFlight = Math.max(0, this.#inFlight - 1);
    return changes;
  }

  /** The policy feeds the queued-waiter count (increase only under demand). */
  waiters(count: number): void {
    this.#waiters = Math.max(0, count);
  }

  /**
   * Idle reset: after `ADMISSION_IDLE_RESET_MS` without an admission and with
   * nothing in flight, the next signal first forgets the learned cap back to
   * `initial`. Lazy and idempotent; rate-limit windows are per-minute, so an
   * hour-old cut is stale evidence.
   */
  #idleReset(now: number): ModelConcurrencyChange[] {
    if (
      this.#lastRequestAt === undefined ||
      this.#inFlight !== 0 ||
      now - this.#lastRequestAt < ADMISSION_IDLE_RESET_MS
    ) {
      return [];
    }
    if (
      this.#cap === this.initial &&
      this.#successStreak === 0 &&
      this.#cooldownUntil === undefined &&
      this.#lastGood === undefined &&
      this.#lastBad === undefined
    ) {
      return [];
    }
    const previous = this.#cap;
    this.#cap = this.initial;
    this.#successStreak = 0;
    this.#cooldownUntil = undefined;
    this.#lastGood = undefined;
    this.#lastBad = undefined;
    this.#epoch += 1;
    // lastRequestAt stays: another still-idle signal must not reset twice.
    return [{ key: this.key, previous, next: this.initial, reason: "idle_reset" }];
  }
}
