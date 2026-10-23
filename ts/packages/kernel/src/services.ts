/**
 * Service registry. A service is provided by one scope at a time and is
 * withdrawn when that scope is disposed. Every change is announced on the
 * bus as `internal/service` so dependants can activate or deactivate.
 */
import type { EventBus } from "./events.ts";
import type { Scope } from "./scope.ts";

export const SERVICE_EVENT = "internal/service";

interface Entry {
  value: unknown;
  scope: Scope;
}

export class ServiceConflictError extends Error {
  override name = "ServiceConflictError";
}

export class ServiceUnavailableError extends Error {
  override name = "ServiceUnavailableError";
}

export class ServiceRegistry {
  readonly #entries = new Map<string, Entry>();
  readonly #bus: EventBus;

  constructor(bus: EventBus) {
    this.#bus = bus;
  }

  provide(name: string, value: unknown, scope: Scope): () => Promise<void> {
    const existing = this.#entries.get(name);
    if (existing) throw new ServiceConflictError(`service ${name} is already provided by ${existing.scope.name}`);
    const entry: Entry = { value, scope };
    // Register the withdrawal first, so an ended scope throws before anything is announced.
    const release = scope.add(() => {
      if (this.#entries.get(name) !== entry) return;
      this.#entries.delete(name);
      this.#bus.emit(SERVICE_EVENT, name, false);
    });
    this.#entries.set(name, entry);
    this.#bus.emit(SERVICE_EVENT, name, true);
    return release;
  }

  has(name: string): boolean {
    return this.#entries.has(name);
  }

  get(name: string): unknown {
    const entry = this.#entries.get(name);
    if (!entry) throw new ServiceUnavailableError(`service ${name} is not available`);
    return entry.value;
  }

  names(): string[] {
    return [...this.#entries.keys()];
  }

  providerOf(name: string): string | null {
    return this.#entries.get(name)?.scope.name ?? null;
  }
}
