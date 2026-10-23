/** FIFO dispatch with per-actor serialization and live concurrency retuning. */
export interface ScheduledOperation<T> {
  actorId?: string;
  run(signal: AbortSignal): Promise<T> | T;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  const error = new Error("dynamic workflow operation cancelled");
  error.name = "AbortError";
  return error;
}

export class DynamicOperationScheduler {
  readonly signal: AbortSignal;
  readonly operations: Promise<unknown>[] = [];
  readonly failures: unknown[] = [];
  #queue: ScheduledOperation<unknown>[] = [];
  #busyActors = new Set<string>();
  #active = 0;
  #limit: number;

  constructor(limit: number, signal: AbortSignal) {
    this.#limit = limit;
    this.signal = signal;
    signal.addEventListener("abort", () => this.cancelQueued(), { once: true });
  }

  setConcurrency(limit: number): void {
    this.#limit = limit;
    this.#pump();
  }

  schedule<T>(actorId: string | undefined, run: (signal: AbortSignal) => Promise<T> | T): Promise<T> {
    if (this.signal.aborted) return Promise.reject(abortError(this.signal));
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    // An evaluator may intentionally leave an operation un-awaited. Keep its
    // rejection observed while retaining the original promise for its caller.
    void promise.catch(() => undefined);
    this.operations.push(promise);
    const task: ScheduledOperation<T> = {
      ...(actorId === undefined ? {} : { actorId }), run, resolve, reject,
    };
    this.#queue.push(task as ScheduledOperation<unknown>);
    this.#pump();
    return promise;
  }

  cancelQueued(reason: unknown = abortError(this.signal)): void {
    for (const task of this.#queue.splice(0)) task.reject(reason);
  }

  async drain(): Promise<void> {
    await Promise.allSettled(this.operations);
  }

  #pump(): void {
    if (this.signal.aborted) { this.cancelQueued(); return; }
    while (this.#active < this.#limit) {
      // Skip a blocked actor's later tasks so other actors can use free slots.
      const index = this.#queue.findIndex((task) => task.actorId === undefined || !this.#busyActors.has(task.actorId));
      if (index < 0) return;
      const [task] = this.#queue.splice(index, 1);
      if (!task) return;
      this.#active += 1;
      if (task.actorId !== undefined) this.#busyActors.add(task.actorId);
      void Promise.resolve().then(() => task.run(this.signal)).then(task.resolve, (error) => {
        this.failures.push(error);
        task.reject(error);
      }).finally(() => {
        this.#active -= 1;
        if (task.actorId !== undefined) this.#busyActors.delete(task.actorId);
        this.#pump();
      });
    }
  }
}
