/**
 * Scopes own side effects. Everything a plugin acquires (listeners, services,
 * timers, child processes, sockets) is registered as a disposer on its scope,
 * and disposing the scope releases all of it: children first, then the
 * scope's own disposers in reverse order of registration.
 */

export type Disposer = () => void | Promise<void>;
export type ScopeState = "active" | "disposing" | "disposed";

export class Scope {
  readonly name: string;
  readonly parent: Scope | null;
  #state: ScopeState = "active";
  #disposers: Disposer[] = [];
  #children = new Set<Scope>();
  #disposing: Promise<void> | null = null;

  constructor(name: string, parent: Scope | null = null) {
    this.name = name;
    this.parent = parent;
  }

  get state(): ScopeState {
    return this.#state;
  }

  get active(): boolean {
    return this.#state === "active";
  }

  /** Number of live disposers and children; a released scope reports 0. */
  get size(): number {
    return this.#disposers.length + this.#children.size;
  }

  /** Create a child scope that is disposed with (and before) this one. */
  child(name: string): Scope {
    this.#assertActive(`create child scope ${name}`);
    const child = new Scope(name, this);
    this.#children.add(child);
    return child;
  }

  /**
   * Register a disposer. The returned function runs it early and removes it,
   * so a resource released on its own does not get released twice.
   */
  add(disposer: Disposer): () => Promise<void> {
    this.#assertActive("register a disposer");
    // Runs at most once, whether released early or by disposal, so a stale release is harmless.
    let done = false;
    const once: Disposer = () => {
      if (done) return;
      done = true;
      return disposer();
    };
    this.#disposers.push(once);
    return async () => {
      const index = this.#disposers.lastIndexOf(once);
      if (index >= 0) this.#disposers.splice(index, 1);
      await once();
    };
  }

  /** Release everything. Errors are collected; disposal never stops halfway. */
  dispose(): Promise<void> {
    if (this.#disposing) return this.#disposing;
    this.#state = "disposing";
    this.#disposing = this.#run();
    return this.#disposing;
  }

  async #run(): Promise<void> {
    const errors: unknown[] = [];
    for (const child of [...this.#children].reverse()) {
      try {
        await child.dispose();
      } catch (error) {
        errors.push(error);
      }
    }
    while (this.#disposers.length) {
      const disposer = this.#disposers.pop() as Disposer;
      try {
        await disposer();
      } catch (error) {
        errors.push(error);
      }
    }
    this.#state = "disposed";
    if (this.parent) this.parent.#children.delete(this);
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, `scope ${this.name}: ${errors.length} disposers failed`);
  }

  #assertActive(action: string): void {
    if (this.#state !== "active") throw new ScopeInactiveError(`cannot ${action}: scope ${this.name} is ${this.#state}`);
  }
}

export class ScopeInactiveError extends Error {
  override name = "ScopeInactiveError";
}
