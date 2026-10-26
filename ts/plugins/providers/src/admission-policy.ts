/**
 * Process-shared adaptive model admission: one AIMD bucket per
 * `${providerId}/${modelId}` key (upstream `workflow-concurrency-governor`),
 * per-run round-robin queues, Retry-After cooldowns with a wake timer, and
 * foreground (main-task) requests that never queue behind background runs.
 *
 * Each ticket spans one in-flight attempt and doubles as that attempt's status
 * sink: the agent's retry loop publishes `model_request_*` /
 * `model_retry_scheduled` events on it, and the bucket's controller reads the
 * outcome from them — success grows the streak, a 429 cuts the cap and arms
 * the cooldown, cancellation merely ends the attempt.
 */
import { ModelFailureReason, ModelRetryReason, ProviderCancelled } from "@xueness/providers";
import type {
  ModelRequestAdmission,
  ModelRequestAdmissionScope,
  ModelRequestAdmissionTicket,
  ModelRequestTarget,
} from "@xueness/providers";
import { ModelConcurrencyController, type ModelConcurrencyChange, type ModelConcurrencySnapshot, type ConcurrencyThrottleReason } from "./admission-controller.ts";
import { resolve } from "node:path";

/** Throttle-class retry reasons: cut the cap and arm the cooldown. */
const THROTTLE_REASONS: ReadonlySet<ConcurrencyThrottleReason> = new Set<ConcurrencyThrottleReason>([
  ModelRetryReason.RateLimited,
  ModelRetryReason.ProviderOverloaded,
  ModelRetryReason.OffpeakQueued,
]);
/** Not provider failures: the attempt ends without a verdict; the streak survives. */
const NON_FAILURE_REASONS: ReadonlySet<string> = new Set<string>([
  ModelRetryReason.ReasoningSignatureRepair,
  ModelRetryReason.AuthRefresh,
]);
/** Foreground traffic shares one pseudo-run identity: it never queues, so it never rotates. */
const FOREGROUND_RUN = "\0foreground";
/** Scope-less callers (tests, future integrations) share one FIFO queue. */
const DEFAULT_RUN = "default";

interface Waiter {
  state: "queued" | "granted" | "cancelled";
  signal?: AbortSignal;
  abortListener?: () => void;
  resolve(ticket: ModelRequestAdmissionTicket): void;
  reject(error: ProviderCancelled): void;
}

interface Bucket {
  key: string;
  controller: ModelConcurrencyController;
  /** Waiters per run: runs rotate, a dense run cannot starve a later one. */
  queues: Map<string, Waiter[]>;
  lastGrantedRun?: string;
  cancelCooldownWake?: () => void;
}

export interface ProviderAdmissionOptions {
  now?: () => number;
  /** Cooldown-expiry wake (injectable); the default is an unref'd setTimeout. */
  schedule?: (callback: () => void, delayMs: number) => () => void;
}

/** A projected cap change: the controller's facts stamped with the policy clock. */
export type ProviderAdmissionChange = ModelConcurrencyChange & { at: number };
/** How many recent cap changes the execution snapshot exposes. */
const CHANGE_RING_LIMIT = 64;

export class ProviderAdmissionController implements ModelRequestAdmission {
  readonly limit: number;
  readonly #now: () => number;
  readonly #schedule: (callback: () => void, delayMs: number) => () => void;
  readonly #buckets = new Map<string, Bucket>();
  readonly #changes: ProviderAdmissionChange[] = [];

  constructor(limit: number, options: ProviderAdmissionOptions = {}) {
    this.limit = limit;
    this.#now = options.now ?? Date.now;
    this.#schedule = options.schedule ?? defaultSchedule;
  }

  tryAcquire(input: { model: ModelRequestTarget; scope?: ModelRequestAdmissionScope }): ModelRequestAdmissionTicket | undefined {
    const bucket = this.#bucketFor(modelKey(input.model));
    // Foreground never queues (observer semantics): counted and feeding
    // feedback, but its turn is never blocked by background traffic.
    if (input.scope?.foreground) return this.#grant(bucket, FOREGROUND_RUN);
    this.#record(bucket.controller.observe(this.#now()));
    // No fast path past a queue: fairness beats latency for governed runs.
    if (this.#waiterCount(bucket) > 0 || !bucket.controller.canAdmit(this.#now())) return undefined;
    return this.#grant(bucket, runOf(input.scope));
  }

  acquire(input: { model: ModelRequestTarget; signal?: AbortSignal; scope?: ModelRequestAdmissionScope }): Promise<ModelRequestAdmissionTicket> {
    const { signal, scope } = input;
    if (signal?.aborted) return Promise.reject(new ProviderCancelled());
    const bucket = this.#bucketFor(modelKey(input.model));
    if (scope?.foreground) return Promise.resolve(this.#grant(bucket, FOREGROUND_RUN));
    const run = runOf(scope);
    this.#record(bucket.controller.observe(this.#now()));
    if (this.#waiterCount(bucket) === 0 && bucket.controller.canAdmit(this.#now())) {
      return Promise.resolve(this.#grant(bucket, run));
    }
    return new Promise<ModelRequestAdmissionTicket>((resolveTicket, rejectTicket) => {
      const waiter: Waiter = { state: "queued", signal, resolve: resolveTicket, reject: rejectTicket };
      waiter.abortListener = () => this.#cancelWaiter(bucket, run, waiter);
      const queue = bucket.queues.get(run) ?? [];
      queue.push(waiter);
      bucket.queues.set(run, queue);
      signal?.addEventListener("abort", waiter.abortListener, { once: true });
      if (signal?.aborted) this.#cancelWaiter(bucket, run, waiter);
      else this.#drain(bucket);
    });
  }

  snapshot(): { limit: number; active: number; queued: number; buckets: number; models: ModelConcurrencySnapshot[]; changes: ProviderAdmissionChange[] } {
    let active = 0;
    let queued = 0;
    const models: ModelConcurrencySnapshot[] = [];
    for (const bucket of this.#buckets.values()) {
      const state = bucket.controller.snapshot();
      active += state.inFlight;
      queued += this.#waiterCount(bucket);
      models.push(state);
    }
    return { limit: this.limit, active, queued, buckets: this.#buckets.size, models, changes: [...this.#changes] };
  }

  /**
   * Projects cap changes (upstream `concurrency-changed`) into a bounded ring
   * on the execution snapshot. Per-run journal fan-out stays out until a run
   * subscriber surface exists; the ring explains queued waiters the same way.
   */
  #record(changes: readonly ModelConcurrencyChange[]): void {
    if (!changes.length) return;
    const at = this.#now();
    this.#changes.push(...changes.map((change) => ({ ...change, at })));
    if (this.#changes.length > CHANGE_RING_LIMIT) this.#changes.splice(0, this.#changes.length - CHANGE_RING_LIMIT);
  }

  /** Admit one request: idle-check first, then count it in flight under its epoch. */
  #grant(bucket: Bucket, run: string): ModelRequestAdmissionTicket {
    this.#record(bucket.controller.observe(this.#now()));
    const epoch = bucket.controller.admitted(this.#now());
    bucket.lastGrantedRun = run;
    return this.#ticket(bucket, epoch);
  }

  /** One attempt's ticket: status events settle it once, `release()` is the fallback. */
  #ticket(bucket: Bucket, epoch: number): ModelRequestAdmissionTicket {
    let settled = false;
    const settle = (signal: (at: number) => readonly ModelConcurrencyChange[]): void => {
      if (settled) return;
      settled = true;
      this.#record(signal(this.#now()));
      // A freed slot (or a changed cap) may admit queued waiters.
      this.#drain(bucket);
      this.#deleteIfIdle(bucket);
    };
    return {
      publish(info: Record<string, unknown>): void | Promise<void> {
        if (settled) return;
        const type = info.type;
        if (type === "model_request_completed") {
          settle((at) => bucket.controller.succeeded(at, epoch));
          return;
        }
        if (type === "model_retry_scheduled") {
          const reason = typeof info.reason === "string" ? info.reason : "";
          if (NON_FAILURE_REASONS.has(reason)) {
            settle((at) => bucket.controller.ended(at));
            return;
          }
          if (THROTTLE_REASONS.has(reason as ConcurrencyThrottleReason)) {
            settle((at) => bucket.controller.throttled(at, epoch, retryAfterMsOf(info), reason as ConcurrencyThrottleReason));
            return;
          }
          settle((at) => bucket.controller.failedTransient(at));
          return;
        }
        if (type === "model_request_failed") {
          // A retryable failure's verdict arrives with the retry_scheduled event.
          const verdictFollows = info.retryable === true && info.terminal !== true;
          if (verdictFollows) return;
          const reason = typeof info.reason === "string" ? info.reason : "";
          // A terminal rate limit or overload is still a concurrency signal for the cap.
          if (THROTTLE_REASONS.has(reason as ConcurrencyThrottleReason) || reason === ModelFailureReason.RateLimited) {
            const throttleReason = THROTTLE_REASONS.has(reason as ConcurrencyThrottleReason) ? reason as ConcurrencyThrottleReason : "rate_limited";
            settle((at) => bucket.controller.throttled(at, epoch, retryAfterMsOf(info), throttleReason));
            return;
          }
          if (info.retryable === true && !NON_FAILURE_REASONS.has(reason)) {
            settle((at) => bucket.controller.failedTransient(at));
            return;
          }
          settle((at) => bucket.controller.ended(at));
          return;
        }
        // started / queued / admitted carry no outcome.
      },
      release(): void {
        settle((at) => bucket.controller.ended(at));
      },
    };
  }

  /** Grant to as many waiters as the gate allows, then arm the cooldown wake. */
  #drain(bucket: Bucket): void {
    this.#record(bucket.controller.observe(this.#now()));
    for (;;) {
      bucket.controller.waiters(this.#waiterCount(bucket));
      if (!bucket.controller.canAdmit(this.#now())) break;
      const run = this.#nextRunWithWaiters(bucket);
      if (run === undefined) break;
      const queue = bucket.queues.get(run)!;
      const waiter = queue.shift()!;
      if (queue.length === 0) bucket.queues.delete(run);
      if (waiter.state !== "queued") continue;
      waiter.state = "granted";
      this.#removeAbortListener(waiter);
      waiter.resolve(this.#grant(bucket, run));
    }
    bucket.controller.waiters(this.#waiterCount(bucket));
    this.#armCooldownWake(bucket);
  }

  /** The next run with waiters, rotating past the one granted last. */
  #nextRunWithWaiters(bucket: Bucket): string | undefined {
    const runs = [...bucket.queues.keys()].filter((run) => (bucket.queues.get(run)?.length ?? 0) > 0);
    if (runs.length === 0) return undefined;
    const last = bucket.lastGrantedRun;
    const lastIndex = last === undefined ? -1 : runs.indexOf(last);
    return runs[(lastIndex + 1) % runs.length];
  }

  /** A queued waiter's cooldown must end in a drain, not in silence. */
  #armCooldownWake(bucket: Bucket): void {
    bucket.cancelCooldownWake?.();
    bucket.cancelCooldownWake = undefined;
    if (this.#waiterCount(bucket) === 0) return;
    const until = bucket.controller.snapshot().cooldownUntil;
    if (until === undefined) return;
    bucket.cancelCooldownWake = this.#schedule(() => {
      bucket.cancelCooldownWake = undefined;
      this.#drain(bucket);
    }, Math.max(0, until - this.#now()));
  }

  #cancelWaiter(bucket: Bucket, run: string, waiter: Waiter): void {
    if (waiter.state !== "queued") return;
    waiter.state = "cancelled";
    const queue = bucket.queues.get(run);
    if (queue !== undefined) {
      const index = queue.indexOf(waiter);
      if (index >= 0) queue.splice(index, 1);
      if (queue.length === 0) bucket.queues.delete(run);
    }
    this.#removeAbortListener(waiter);
    waiter.reject(new ProviderCancelled());
    bucket.controller.waiters(this.#waiterCount(bucket));
    this.#deleteIfIdle(bucket);
  }

  #bucketFor(key: string): Bucket {
    let bucket = this.#buckets.get(key);
    if (bucket === undefined) {
      bucket = { key, controller: new ModelConcurrencyController(key, this.limit), queues: new Map() };
      this.#buckets.set(key, bucket);
    }
    return bucket;
  }

  #waiterCount(bucket: Bucket): number {
    let total = 0;
    for (const queue of bucket.queues.values()) total += queue.length;
    return total;
  }

  #removeAbortListener(waiter: Waiter): void {
    if (!waiter.abortListener) return;
    waiter.signal?.removeEventListener("abort", waiter.abortListener);
    waiter.abortListener = undefined;
  }

  /**
   * Drop a bucket only while it is pristine: learned AIMD state (a cut cap, a
   * cooldown, a proven level) must survive a momentarily drained bucket — a
   * retry's backoff sleep holds no ticket, and forgetting the cap there would
   * undo the very limit the provider just taught us. The five-minute idle
   * reset is what forgets learned state, lazily; a partial success streak is
   * not learned state and dies with the bucket.
   */
  #deleteIfIdle(bucket: Bucket): void {
    if (this.#buckets.get(bucket.key) !== bucket) return;
    const state = bucket.controller.snapshot();
    const learned = state.epoch !== 0 || state.cap !== state.initial || state.cooldownUntil !== undefined
      || state.lastGood !== undefined || state.lastBad !== undefined;
    if (learned || state.inFlight !== 0 || this.#waiterCount(bucket) !== 0) return;
    bucket.cancelCooldownWake?.();
    bucket.cancelCooldownWake = undefined;
    this.#buckets.delete(bucket.key);
  }
}

function defaultSchedule(callback: () => void, delayMs: number): () => void {
  const timer = setTimeout(callback, delayMs);
  // A cooldown wake must never keep the process alive on its own.
  if (typeof timer === "object" && timer !== null && "unref" in timer) timer.unref();
  return () => clearTimeout(timer);
}

function runOf(scope: ModelRequestAdmissionScope | undefined): string {
  return scope?.run ?? DEFAULT_RUN;
}

function retryAfterMsOf(info: Record<string, unknown>): number | undefined {
  const value = info.retryAfterMs;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Binds a scope into every admission call; unscoped admissions pass through unchanged. */
export function admissionWithScope(
  admission: ModelRequestAdmission,
  scope: ModelRequestAdmissionScope | undefined,
): ModelRequestAdmission {
  if (!scope) return admission;
  const inner = admission;
  return {
    ...(inner.tryAcquire ? { tryAcquire: (input: { model: ModelRequestTarget }) => inner.tryAcquire?.({ ...input, scope }) } : {}),
    acquire: (input: { model: ModelRequestTarget; signal?: AbortSignal }) => inner.acquire({ ...input, scope }),
  };
}

const stateControllers = new Map<string, ProviderAdmissionController | null>();

/** Gets the process-shared admission policy for one resolved state directory. */
export function providerAdmissionForState(stateDir: string): ProviderAdmissionController | undefined {
  const resolved = resolve(stateDir);
  const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  if (stateControllers.has(key)) return stateControllers.get(key) ?? undefined;

  const limit = configuredLimit();
  if (limit === 0) {
    stateControllers.set(key, null);
    return undefined;
  }
  const controller = new ProviderAdmissionController(limit);
  stateControllers.set(key, controller);
  return controller;
}

function configuredLimit(): number {
  const raw = process.env.XUENESS_MODEL_MAX_CONCURRENT;
  if (raw === undefined) return 4;
  const trimmed = raw.trim();
  if (!trimmed) return 4;
  const value = Number(trimmed);
  if (value === 0) return 0;
  return Number.isInteger(value) && value >= 1 && value <= 64 ? value : 4;
}

function modelKey(model: ModelRequestTarget): string {
  return JSON.stringify([model.providerId, model.modelId]);
}
