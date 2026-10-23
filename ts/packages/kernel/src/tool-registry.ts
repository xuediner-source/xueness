/**
 * Tool registry shared by every plugin of one kernel.
 *
 * A plugin registers a tool through its context; the registration ends with
 * the plugin's scope. One owner per tool name. `internal/tool` announces each
 * change so an agent loop can refresh its tool list.
 *
 * Running a tool takes a lease: while the call runs, unloading the owning
 * plugin aborts the lease's signal and waits (boundedly) for the call to
 * settle before releasing the plugin's other resources, so no command
 * outlives the plugin that started it. Plugins see declarations only: they
 * cannot reach another plugin's `run` and act with its powers.
 */
import type { CapabilityDeclaration } from "@xueness/contracts";
import type { EventBus } from "./events.ts";
import type { Scope } from "./scope.ts";

/** The fields the kernel checks; engine-tools' ToolDefinition is one. */
export interface ToolDescriptor {
  readonly name: string;
  readonly gate: string;
  readonly mutating: boolean;
  readonly concurrencySafe: boolean;
  readonly requires?: CapabilityDeclaration;
}

export interface ToolLease<T extends ToolDescriptor = ToolDescriptor> {
  readonly tool: T;
  readonly owner: string;
  /** Aborted when the owning plugin unloads during the call. */
  readonly signal: AbortSignal;
  /** The call settled: unloading no longer waits for it. Idempotent. */
  release(): void;
}

/** Read-only view of the tool registry. Restricted contexts get declarations and no leases. */
export interface ToolView {
  get<T extends ToolDescriptor = ToolDescriptor>(name: string): T | undefined;
  list<T extends ToolDescriptor = ToolDescriptor>(): T[];
  ownerOf(name: string): string | null;
  lease<T extends ToolDescriptor = ToolDescriptor>(name: string): ToolLease<T> | null;
  readonly size: number;
}

export const TOOL_EVENT = "internal/tool";
/** How long unloading a plugin waits for one of its running calls after aborting it. */
export const TOOL_DRAIN_MS = 10_000;

export class ToolConflictError extends Error {
  override name = "ToolConflictError";
}

export class UndeclaredToolError extends Error {
  override name = "UndeclaredToolError";
  readonly code = "undeclared_tool";
}

export class ToolUnloadedError extends Error {
  override name = "ToolUnloadedError";
  readonly code = "cancelled";
}

interface Entry {
  tool: ToolDescriptor;
  owner: string;
  scope: Scope;
}

const declaration = (tool: ToolDescriptor): ToolDescriptor =>
  Object.freeze({ name: tool.name, gate: tool.gate, mutating: tool.mutating, concurrencySafe: tool.concurrencySafe });

export class ToolRegistry {
  readonly #entries = new Map<string, Entry>();
  readonly #bus: EventBus;
  readonly #drainMs: number;

  constructor(bus: EventBus, drainMs = TOOL_DRAIN_MS) {
    this.#bus = bus;
    this.#drainMs = drainMs;
  }

  register(tool: ToolDescriptor, owner: string, scope: Scope): () => Promise<void> {
    // MCP tools keep their server's spelling (`mcp__<server>__<tool>`, as in the Python plugin).
    if (!/^[a-z][a-z0-9_]*$/.test(tool.name) && !/^mcp__[A-Za-z0-9._-]{1,64}__[A-Za-z0-9._-]{1,64}$/.test(tool.name)) throw new TypeError(`invalid tool name ${JSON.stringify(tool.name)}`);
    const existing = this.#entries.get(tool.name);
    if (existing) throw new ToolConflictError(`tool ${tool.name} is already registered by ${existing.owner}`);
    const entry: Entry = { tool, owner, scope };
    // Register the removal first, so an ended scope throws before anything is announced.
    const release = scope.add(() => {
      if (this.#entries.get(tool.name) !== entry) return;
      this.#entries.delete(tool.name);
      this.#bus.emit(TOOL_EVENT, tool.name, false);
    });
    this.#entries.set(tool.name, entry);
    this.#bus.emit(TOOL_EVENT, tool.name, true);
    return release;
  }

  get<T extends ToolDescriptor = ToolDescriptor>(name: string): T | undefined {
    return this.#entries.get(name)?.tool as T | undefined;
  }

  /** Registered tools in registration order. */
  list<T extends ToolDescriptor = ToolDescriptor>(): T[] {
    return [...this.#entries.values()].map((entry) => entry.tool as T);
  }

  ownerOf(name: string): string | null {
    return this.#entries.get(name)?.owner ?? null;
  }

  /** Lease a tool for one call; null when it is not registered or its plugin is unloading. */
  lease<T extends ToolDescriptor = ToolDescriptor>(name: string): ToolLease<T> | null {
    const entry = this.#entries.get(name);
    if (!entry?.scope.active) return null;
    const controller = new AbortController();
    let settle = (): void => {};
    const settled = new Promise<void>((resolve) => (settle = resolve));
    let done = false;
    const drainMs = this.#drainMs;
    const unregister = entry.scope.add(async () => {
      if (done) return;
      controller.abort(new ToolUnloadedError(`tool ${name} was unloaded with plugin ${entry.owner}`));
      let timer: NodeJS.Timeout | undefined;
      // Never let a tool that ignores its signal hang the unload.
      await Promise.race([settled, new Promise<void>((resolve) => (timer = setTimeout(resolve, drainMs)))]);
      clearTimeout(timer);
    });
    return {
      tool: entry.tool as T,
      owner: entry.owner,
      signal: controller.signal,
      release: () => {
        if (done) return;
        done = true;
        settle();
        void unregister();
      },
    };
  }

  get size(): number {
    return this.#entries.size;
  }

  /** The full view for the kernel, or declarations without leases for plugins. */
  view(full: boolean): ToolView {
    const registry = this;
    return Object.freeze({
      get: <T extends ToolDescriptor>(name: string) => {
        const tool = this.get(name);
        return (tool && !full ? declaration(tool) : tool) as T | undefined;
      },
      list: <T extends ToolDescriptor>() => (full ? this.list<T>() : this.list().map(declaration) as T[]),
      ownerOf: (name: string) => this.ownerOf(name),
      lease: <T extends ToolDescriptor>(name: string) => (full ? this.lease<T>(name) : null),
      get size() {
        return registry.size;
      },
    });
  }
}
