/**
 * Event bus with scope-bound listeners.
 *
 * `emit` is synchronous fire-and-forget; `parallel` awaits all listeners;
 * `serial` awaits them in registration order; `bail` returns the first
 * result that is not undefined (a hook a plugin can use to take over).
 * A throwing listener never breaks delivery to the others: the error goes
 * to the `onError` callback.
 */
import type { Scope } from "./scope.ts";

// Listener signatures are open by design: plugins declare their own events.
export type Listener = (...args: any[]) => unknown;

export class EventBus {
  readonly #listeners = new Map<string, Listener[]>();
  readonly #onError: (error: unknown, event: string) => void;

  constructor(onError: (error: unknown, event: string) => void = (error) => queueMicrotask(() => { throw error; })) {
    this.#onError = onError;
  }

  /** Subscribe; the listener is removed when `scope` is disposed. */
  on(event: string, listener: Listener, scope?: Scope): () => void {
    let removed = false;
    const off = (): void => {
      if (removed) return;
      removed = true;
      const current = this.#listeners.get(event);
      if (!current) return;
      const index = current.indexOf(listener);
      if (index >= 0) current.splice(index, 1);
      if (!current.length) this.#listeners.delete(event);
    };
    // Register the removal first, so an ended scope throws before anything is added.
    const release = scope ? scope.add(off) : null;
    const list = this.#listeners.get(event) ?? [];
    list.push(listener);
    this.#listeners.set(event, list);
    return release ? () => void release() : off;
  }

  once(event: string, listener: Listener, scope?: Scope): () => void {
    const off = this.on(event, (...args: unknown[]) => {
      off();
      return listener(...args);
    }, scope);
    return off;
  }

  listenerCount(event?: string): number {
    if (event !== undefined) return this.#listeners.get(event)?.length ?? 0;
    let total = 0;
    for (const list of this.#listeners.values()) total += list.length;
    return total;
  }

  #snapshot(event: string): Listener[] {
    return [...(this.#listeners.get(event) ?? [])];
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.#snapshot(event)) {
      try {
        const result = listener(...args);
        if (result instanceof Promise) result.catch((error: unknown) => this.#onError(error, event));
      } catch (error) {
        this.#onError(error, event);
      }
    }
  }

  async parallel(event: string, ...args: unknown[]): Promise<void> {
    await Promise.all(this.#snapshot(event).map(async (listener) => {
      try {
        await listener(...args);
      } catch (error) {
        this.#onError(error, event);
      }
    }));
  }

  /** Run listeners one after another. Errors propagate to the caller. */
  async serial(event: string, ...args: unknown[]): Promise<void> {
    for (const listener of this.#snapshot(event)) await listener(...args);
  }

  /** First listener result that is not undefined, or undefined. */
  async bail<T = unknown>(event: string, ...args: unknown[]): Promise<T | undefined> {
    for (const listener of this.#snapshot(event)) {
      const result = await listener(...args);
      if (result !== undefined) return result as T;
    }
    return undefined;
  }
}
