/**
 * Context: the handle a plugin receives. It binds the shared bus, service
 * registry and tool registry to the plugin's own scope, so every listener,
 * service, tool, timer, process and socket acquired through it is released
 * when the plugin is unloaded.
 *
 * A restricted context (see `restrict`) also carries the plugin's manifest:
 * it may only provide and read the services, and register the tools, that
 * the manifest declares, and every OS power goes through its capability
 * guard. Restrictions nest and only ever narrow.
 */
import type { ChildProcess } from "node:child_process";
import type { AddressInfo, Server } from "node:net";
import { capabilityIssues, type Capabilities, type CapabilityDeclaration, type ToolDeclaration } from "@xueness/contracts";
import { CapabilityDeniedError, CapabilityGuard, type FsRootPaths } from "./capability-guard.ts";
import { EventBus, type Listener } from "./events.ts";
import { KERNEL_EMIT } from "./internal.ts";
import { PluginHandle, type Plugin } from "./plugin.ts";
import { fetchScoped, serveScoped, spawnScoped, subscribeScoped, type ScopedSpawnOptions, type ServeOptions, type Subscribable } from "./resources.ts";
import { Scope, ScopeInactiveError, type Disposer } from "./scope.ts";
import { ServiceRegistry } from "./services.ts";
import { ToolEventRegistry, type ToolEventHandler, type ToolEventName, type ToolEventParticipant } from "./tool-events.ts";
import { ToolRegistry, UndeclaredToolError, type ToolDescriptor, type ToolView } from "./tool-registry.ts";

/** Service types, extended by plugins through declaration merging. */
export interface Services {}

/** Where `ctx.secret` reads from; the guard is checked before it is asked. */
export interface SecretStore {
  get(name: string): string | null | Promise<string | null>;
}

export interface KernelOptions {
  name?: string;
  /** Receives errors thrown by `emit` listeners and timer callbacks. */
  onError?: (error: unknown, where: string) => void;
  /** File roots behind the fs capabilities (default: the current directory is the workspace). */
  roots?: FsRootPaths | (() => FsRootPaths);
  secrets?: SecretStore;
}

/** Narrowing applied by `restrict`; omitted lists leave the parent's limit in place. */
export interface Restriction {
  /** Name used for tool ownership and in capability errors (the plugin id). */
  owner: string;
  capabilities?: CapabilityDeclaration | Capabilities;
  /** Services this context may provide. */
  provides?: readonly string[];
  /** Services this context may read with `get`. */
  uses?: readonly string[];
  /** Tools this context may register. */
  tools?: readonly ToolDeclaration[];
  /** Tool events the manifest declares; null declares none (omitted inherits). */
  toolEvents?: { readonly events: readonly string[]; readonly priority?: number } | null;
  /** Plugins this one depends on, transitively: their tool event handlers run first. */
  dependencies?: readonly string[];
}

export class UndeclaredServiceError extends Error {
  override name = "UndeclaredServiceError";
  readonly code = "undeclared_service";
}

interface Root {
  bus: EventBus;
  services: ServiceRegistry;
  tools: ToolRegistry;
  fullTools: ToolView;
  declaredTools: ToolView;
  toolEvents: ToolEventRegistry;
  secrets: SecretStore | null;
  onError: (error: unknown, where: string) => void;
}

interface Limits {
  readonly owner: string;
  readonly guard: CapabilityGuard;
  readonly provides: ReadonlySet<string> | null;
  readonly uses: ReadonlySet<string> | null;
  readonly tools: readonly ToolDeclaration[] | null;
  readonly toolEvents: { readonly events: ReadonlySet<string>; readonly priority: number } | null;
  readonly dependencies: readonly string[] | null;
  readonly parent: Limits | null;
}

type ServiceName = keyof Services & string;

function declaredTool(declared: readonly ToolDeclaration[], name: string): ToolDeclaration | undefined {
  return declared.find((tool) => tool.name === name || (tool.name.endsWith("*") && name.startsWith(tool.name.slice(0, -1))));
}

export class Context {
  readonly scope: Scope;
  readonly #root: Root;
  readonly #limits: Limits;
  #abort: AbortController | null = null;

  private constructor(root: Root, scope: Scope, limits: Limits) {
    this.#root = root;
    this.scope = scope;
    this.#limits = limits;
  }

  /** Create a root context (one per process or per test). */
  static create(options: KernelOptions = {}): Context {
    const onError = options.onError ?? ((error: unknown) => queueMicrotask(() => { throw error; }));
    const bus = new EventBus((error, event) => onError(error, `event ${event}`));
    const tools = new ToolRegistry(bus);
    const root: Root = {
      bus, services: new ServiceRegistry(bus), tools, fullTools: tools.view(true), declaredTools: tools.view(false),
      toolEvents: new ToolEventRegistry(), secrets: options.secrets ?? null, onError,
    };
    const limits: Limits = {
      owner: "kernel", guard: CapabilityGuard.root(options.roots), provides: null, uses: null, tools: null, toolEvents: null, dependencies: null, parent: null,
    };
    return new Context(root, new Scope(options.name ?? "root"), limits);
  }

  get name(): string {
    return this.scope.name;
  }

  /** Who acts through this context: "kernel" or the plugin id given to `restrict`. */
  get owner(): string {
    return this.#limits.owner;
  }

  get restricted(): boolean {
    return this.#limits.parent !== null;
  }

  get guard(): CapabilityGuard {
    return this.#limits.guard;
  }

  /** The kernel sees whole tools and can lease them; a plugin sees declarations only. */
  get tools(): ToolView {
    return this.restricted ? this.#root.declaredTools : this.#root.fullTools;
  }

  /** Aborted when this context's scope ends; pass it to anything cancellable. */
  get signal(): AbortSignal {
    if (!this.#abort) {
      const controller = new AbortController();
      this.#abort = controller;
      const reason = (): Error => new ScopeInactiveError(`scope ${this.name} ended`);
      if (this.scope.active) this.scope.add(() => controller.abort(reason()));
      else controller.abort(reason());
    }
    return this.#abort.signal;
  }

  /** A child context whose scope is disposed with this one. */
  fork(name: string): Context {
    return new Context(this.#root, this.scope.child(name), this.#limits);
  }

  /** A child context limited to a manifest's declarations and granted powers. */
  restrict(name: string, restriction: Restriction): Context {
    const caps = restriction.capabilities;
    const issues = caps === undefined ? [] : capabilityIssues(caps);
    if (issues.length) throw new TypeError(`invalid capabilities for ${restriction.owner}: ${issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`);
    const limits: Limits = {
      owner: restriction.owner,
      guard: caps === undefined ? this.#limits.guard : this.#limits.guard.narrow(restriction.owner, caps),
      provides: restriction.provides ? new Set(restriction.provides) : null,
      uses: restriction.uses ? new Set(restriction.uses) : null,
      tools: restriction.tools ? restriction.tools.map((tool) => ({ ...tool })) : null,
      toolEvents: restriction.toolEvents === undefined
        ? null
        : { events: new Set(restriction.toolEvents?.events ?? []), priority: restriction.toolEvents?.priority ?? 0 },
      dependencies: restriction.dependencies ? [...restriction.dependencies] : null,
      parent: this.#limits,
    };
    return new Context(this.#root, this.scope.child(name), limits);
  }

  provide<K extends ServiceName>(name: K, value: Services[K]): () => Promise<void>;
  provide(name: string, value: unknown): () => Promise<void>;
  provide(name: string, value: unknown): () => Promise<void> {
    this.#allowed("provides", name, "provide");
    return this.#root.services.provide(name, value, this.scope);
  }

  get<K extends ServiceName>(name: K): Services[K];
  get<T = unknown>(name: string): T;
  get(name: string): unknown {
    this.#allowed("uses", name, "use");
    return this.#root.services.get(name);
  }

  has(name: string): boolean {
    return this.#root.services.has(name);
  }

  serviceNames(): string[] {
    return this.#root.services.names();
  }

  /**
   * Register a tool for the rest of this scope. A restricted context only
   * accepts tools its manifest declares, with the same gate and flags, and
   * whose `requires` its grant covers.
   */
  tool(tool: ToolDescriptor): () => Promise<void> {
    for (let limits: Limits | null = this.#limits; limits; limits = limits.parent) {
      if (!limits.tools) continue;
      const declared = declaredTool(limits.tools, tool.name);
      if (!declared) throw new UndeclaredToolError(`${limits.owner} does not declare tool ${tool.name}`);
      for (const key of ["gate", "mutating", "concurrencySafe"] as const) {
        if (declared[key] !== tool[key]) {
          throw new UndeclaredToolError(`${limits.owner} declares tool ${tool.name} with ${key} ${JSON.stringify(declared[key])}, the code has ${JSON.stringify(tool[key])}`);
        }
      }
    }
    const requires = tool.requires ?? {};
    const issues = capabilityIssues(requires, `/tools/${tool.name}/requires`);
    if (issues.length) throw new TypeError(`invalid requirements for tool ${tool.name}: ${issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`);
    const missing = this.#limits.guard.missing(requires);
    if (missing.length) throw new CapabilityDeniedError(this.#limits.owner, missing.join(", "), `tool ${tool.name}`);
    return this.#root.tools.register(tool, this.#limits.owner, this.scope);
  }

  /**
   * Handle a tool event for the rest of this scope. Every plugin may observe
   * before_tool_execution and after_tool_execution; only a declared one may
   * deny or rewrite there, and only declared ones receive the other two.
   */
  toolEvent(event: string, handler: ToolEventHandler): () => Promise<void> {
    let declared = true;
    let priority: number | null = null;
    let dependencies: readonly string[] | null = null;
    for (let limits: Limits | null = this.#limits; limits; limits = limits.parent) {
      if (limits.toolEvents) {
        declared &&= limits.toolEvents.events.has(event);
        priority ??= limits.toolEvents.priority;
      }
      dependencies ??= limits.dependencies;
    }
    const owner = Object.freeze({ plugin: this.#limits.owner, declared, priority: priority ?? 0, dependencies: dependencies ?? [] });
    return this.#root.toolEvents.add(event, handler, owner, this.scope);
  }

  /** Handlers of one tool event in dispatch order; the kernel's tool bridge dispatches, plugins cannot. */
  toolEventParticipants(event: ToolEventName): ToolEventParticipant[] {
    if (this.restricted) throw new CapabilityDeniedError(this.#limits.owner, "tool event dispatch", event);
    return this.#root.toolEvents.participants(event);
  }

  on(event: string, listener: Listener): () => void {
    return this.#root.bus.on(event, listener, this.scope);
  }

  once(event: string, listener: Listener): () => void {
    return this.#root.bus.once(event, listener, this.scope);
  }

  emit(event: string, ...args: unknown[]): void {
    this.#emitting(event);
    this.#root.bus.emit(event, ...args);
  }

  parallel(event: string, ...args: unknown[]): Promise<void> {
    this.#emitting(event);
    return this.#root.bus.parallel(event, ...args);
  }

  serial(event: string, ...args: unknown[]): Promise<void> {
    this.#emitting(event);
    return this.#root.bus.serial(event, ...args);
  }

  bail<T = unknown>(event: string, ...args: unknown[]): Promise<T | undefined> {
    this.#emitting(event);
    return this.#root.bus.bail<T>(event, ...args);
  }

  listenerCount(event?: string): number {
    return this.#root.bus.listenerCount(event);
  }

  /** Kernel code (plugin lifecycle) announcing on `internal/*` through any context. */
  [KERNEL_EMIT](event: string, ...args: unknown[]): void {
    this.#root.bus.emit(event, ...args);
  }

  /** Run a reversible side effect now; its disposer runs when the scope ends. */
  effect(setup: () => Disposer | void): () => Promise<void> {
    if (!this.scope.active) throw new ScopeInactiveError(`cannot run an effect: scope ${this.name} is ${this.scope.state}`);
    const disposer = setup();
    return this.scope.add(disposer ?? (() => {}));
  }

  /** Async variant of `effect` for resources that take time to open. */
  async acquire<T>(open: () => Promise<T>, close: (resource: T) => void | Promise<void>): Promise<T> {
    const resource = await open();
    if (!this.scope.active) {
      await close(resource);
      throw new Error(`scope ${this.name} ended while acquiring a resource`);
    }
    this.scope.add(() => close(resource));
    return resource;
  }

  setTimeout(callback: () => void, ms: number): () => void {
    let timer: NodeJS.Timeout | undefined;
    // The disposer goes first: an ended scope throws before a timer exists.
    const release = this.scope.add(() => clearTimeout(timer));
    timer = setTimeout(() => {
      void release();
      this.#run(callback, "timeout");
    }, ms);
    return () => void release();
  }

  setInterval(callback: () => void, ms: number): () => void {
    let timer: NodeJS.Timeout | undefined;
    const release = this.scope.add(() => clearInterval(timer));
    timer = setInterval(() => this.#run(callback, "interval"), ms);
    return () => void release();
  }

  /** Spawn a program allowed by `exec`; its whole process tree ends with the scope. */
  spawn(file: string, args: readonly string[] = [], options: ScopedSpawnOptions = {}): ChildProcess {
    return spawnScoped(this, file, args, options);
  }

  /** Listen on a host allowed by `net.listen`; the server and its connections close with the scope. */
  serve(server: Server, options: ServeOptions): Promise<AddressInfo> {
    return serveScoped(this, server, options);
  }

  /** `fetch` to a host allowed by `net.connect`, aborted when the scope ends. */
  fetch(input: string | URL, init?: RequestInit): Promise<Response> {
    return fetchScoped(this, input, init);
  }

  /** Listen on any emitter until the scope ends. */
  subscribe(emitter: Subscribable, event: string, listener: (...args: any[]) => void): () => void {
    return subscribeScoped(this, emitter, event, listener);
  }

  /** Read a secret allowed by `secrets`; null when the store has no such secret. */
  async secret(name: string): Promise<string | null> {
    this.#limits.guard.secret(name);
    return (await this.#root.secrets?.get(name)) ?? null;
  }

  /** Load a plugin in a child scope. Config is validated synchronously. */
  plugin<C>(plugin: Plugin<C>, config?: C): PluginHandle<C> {
    return new PluginHandle(this, plugin, config as C);
  }

  dispose(): Promise<void> {
    return this.scope.dispose();
  }

  #allowed(list: "provides" | "uses", name: string, verb: string): void {
    for (let limits: Limits | null = this.#limits; limits; limits = limits.parent) {
      const allowed = limits[list];
      if (allowed && !allowed.has(name)) throw new UndeclaredServiceError(`${limits.owner} does not declare that it may ${verb} service ${name}`);
    }
  }

  /** `internal/*` events are the kernel's own; a restricted context cannot fake them. */
  #emitting(event: string): void {
    if (this.restricted && event.startsWith("internal/")) throw new CapabilityDeniedError(this.#limits.owner, "emit", event);
  }

  #run(callback: () => void, where: string): void {
    try {
      callback();
    } catch (error) {
      this.#root.onError(error, `${where} in ${this.name}`);
    }
  }
}
