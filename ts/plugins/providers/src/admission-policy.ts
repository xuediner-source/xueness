import { ProviderCancelled } from "@xueness/providers";
import type {
  ModelRequestAdmission,
  ModelRequestAdmissionTicket,
  ModelRequestTarget,
} from "../../../packages/providers/src/request-admission.ts";
import { resolve } from "node:path";

interface Waiter {
  state: "queued" | "granted" | "cancelled";
  signal?: AbortSignal;
  abortListener?: () => void;
  resolve(ticket: ModelRequestAdmissionTicket): void;
  reject(error: ProviderCancelled): void;
}

interface Bucket {
  active: number;
  queue: Waiter[];
}

/** Fixed per-provider/model FIFO admission; each ticket spans one in-flight attempt. */
export class ProviderAdmissionController implements ModelRequestAdmission {
  readonly limit: number;
  readonly #buckets = new Map<string, Bucket>();

  constructor(limit: number) {
    this.limit = limit;
  }

  tryAcquire(input: { model: ModelRequestTarget }): ModelRequestAdmissionTicket | undefined {
    const key = modelKey(input.model);
    const bucket = this.#buckets.get(key);
    if (bucket && (bucket.queue.length > 0 || bucket.active >= this.limit)) return undefined;
    const available = bucket ?? this.#createBucket(key);
    available.active += 1;
    return this.#ticket(key, available);
  }

  acquire(input: { model: ModelRequestTarget; signal?: AbortSignal }): Promise<ModelRequestAdmissionTicket> {
    const { signal } = input;
    if (signal?.aborted) return Promise.reject(new ProviderCancelled());

    const key = modelKey(input.model);
    let bucket = this.#buckets.get(key);
    if (!bucket) bucket = this.#createBucket(key);
    if (bucket.queue.length === 0 && bucket.active < this.limit) {
      bucket.active += 1;
      return Promise.resolve(this.#ticket(key, bucket));
    }

    return new Promise<ModelRequestAdmissionTicket>((resolveTicket, rejectTicket) => {
      const waiter: Waiter = {
        state: "queued",
        signal,
        resolve: resolveTicket,
        reject: rejectTicket,
      };
      waiter.abortListener = () => this.#cancelWaiter(key, bucket!, waiter);
      bucket!.queue.push(waiter);
      signal?.addEventListener("abort", waiter.abortListener, { once: true });
      if (signal?.aborted) this.#cancelWaiter(key, bucket!, waiter);
    });
  }

  snapshot(): { limit: number; active: number; queued: number; buckets: number } {
    let active = 0;
    let queued = 0;
    for (const bucket of this.#buckets.values()) {
      active += bucket.active;
      queued += bucket.queue.length;
    }
    return { limit: this.limit, active, queued, buckets: this.#buckets.size };
  }

  #createBucket(key: string): Bucket {
    const bucket = { active: 0, queue: [] };
    this.#buckets.set(key, bucket);
    return bucket;
  }

  #ticket(key: string, bucket: Bucket): ModelRequestAdmissionTicket {
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.#release(key, bucket);
      },
    };
  }

  #release(key: string, bucket: Bucket): void {
    if (bucket.active > 0) bucket.active -= 1;
    this.#drain(key, bucket);
    this.#deleteIfEmpty(key, bucket);
  }

  #drain(key: string, bucket: Bucket): void {
    while (bucket.active < this.limit && bucket.queue.length > 0) {
      const waiter = bucket.queue.shift()!;
      if (waiter.state !== "queued") continue;
      waiter.state = "granted";
      this.#removeAbortListener(waiter);
      bucket.active += 1;
      waiter.resolve(this.#ticket(key, bucket));
    }
  }

  #cancelWaiter(key: string, bucket: Bucket, waiter: Waiter): void {
    if (waiter.state !== "queued") return;
    waiter.state = "cancelled";
    const index = bucket.queue.indexOf(waiter);
    if (index >= 0) bucket.queue.splice(index, 1);
    this.#removeAbortListener(waiter);
    waiter.reject(new ProviderCancelled());
    this.#deleteIfEmpty(key, bucket);
  }

  #removeAbortListener(waiter: Waiter): void {
    if (!waiter.abortListener) return;
    waiter.signal?.removeEventListener("abort", waiter.abortListener);
    waiter.abortListener = undefined;
  }

  #deleteIfEmpty(key: string, bucket: Bucket): void {
    if (bucket.active === 0 && bucket.queue.length === 0 && this.#buckets.get(key) === bucket) {
      this.#buckets.delete(key);
    }
  }
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
