/**
 * Plugin lifecycle with service dependencies.
 *
 * A plugin declares the services it needs. It activates once all required
 * services exist, deactivates (releasing everything it acquired) when one
 * disappears, and activates again when it returns. A change to an optional
 * service restarts it. A failing `apply` rolls back whatever it had done.
 * Transitions are serialised, so a burst of service changes cannot race.
 */
import type { Context } from "./context.ts";
import { KERNEL_EMIT } from "./internal.ts";
import { SERVICE_EVENT } from "./services.ts";

export interface PluginDependencies {
  required?: readonly string[];
  optional?: readonly string[];
}

export interface Plugin<C = unknown> {
  readonly name: string;
  /** Required service names, or required and optional ones. */
  readonly inject?: readonly string[] | PluginDependencies;
  /** Validate and normalise config; throw to refuse it. */
  readonly validate?: (config: unknown) => C;
  apply(ctx: Context, config: C): void | Promise<void>;
}

export function definePlugin<C = unknown>(plugin: Plugin<C>): Plugin<C> {
  return plugin;
}

export type PluginState = "pending" | "activating" | "active" | "failed" | "disposed";

export const PLUGIN_EVENT = "internal/plugin";

function dependencies(plugin: Plugin<unknown>): { required: readonly string[]; optional: readonly string[] } {
  const inject = plugin.inject;
  if (inject === undefined) return { required: [], optional: [] };
  if (Array.isArray(inject)) return { required: inject as readonly string[], optional: [] };
  const deps = inject as PluginDependencies;
  return { required: deps.required ?? [], optional: deps.optional ?? [] };
}

export class PluginHandle<C = unknown> {
  readonly name: string;
  readonly #plugin: Plugin<C>;
  readonly #holder: Context;
  readonly #required: readonly string[];
  readonly #optional: readonly string[];
  #config: C;
  #runtime: Context | null = null;
  #state: PluginState = "pending";
  #error: unknown = null;
  #queue: Promise<void> = Promise.resolve();
  #activations = 0;

  constructor(parent: Context, plugin: Plugin<C>, config: C) {
    this.name = plugin.name;
    this.#plugin = plugin;
    this.#config = plugin.validate ? plugin.validate(config) : config;
    ({ required: this.#required, optional: this.#optional } = dependencies(plugin as Plugin<unknown>));
    this.#holder = parent.fork(`plugin:${plugin.name}`);
    this.#holder.scope.add(() => {
      this.#state = "disposed";
    });
    this.#holder.on(SERVICE_EVENT, (service: string) => {
      if (this.#required.includes(service)) this.#enqueue(() => this.#sync());
      else if (this.#optional.includes(service) && this.#runtime) this.#enqueue(() => this.#restart());
    });
    this.#enqueue(() => this.#sync());
  }

  get state(): PluginState {
    return this.#state;
  }

  get error(): unknown {
    return this.#error;
  }

  get config(): C {
    return this.#config;
  }

  /** How many times `apply` has run; useful to observe restarts. */
  get activations(): number {
    return this.#activations;
  }

  /** Context of the current activation, or null while inactive. */
  get context(): Context | null {
    return this.#runtime;
  }

  missing(): string[] {
    return this.#required.filter((name) => !this.#holder.has(name));
  }

  /** Resolves once all queued transitions have settled. */
  ready(): Promise<void> {
    return this.#queue;
  }

  /** Re-run the plugin, optionally with new (validated) config. */
  reload(config?: C): Promise<void> {
    if (config !== undefined) this.#config = this.#plugin.validate ? this.#plugin.validate(config) : config;
    return this.#enqueue(() => this.#restart());
  }

  async dispose(): Promise<void> {
    await this.#holder.dispose();
  }

  #enqueue(step: () => Promise<void>): Promise<void> {
    this.#queue = this.#queue.then(step, step);
    return this.#queue;
  }

  async #sync(): Promise<void> {
    if (this.#state === "disposed") return;
    const ready = this.missing().length === 0;
    if (!ready && this.#runtime) await this.#deactivate("pending");
    else if (ready && !this.#runtime && this.#state !== "failed") await this.#activate();
    else if (!ready && this.#state === "failed") this.#state = "pending";
  }

  async #restart(): Promise<void> {
    if (this.#state === "disposed") return;
    if (this.#runtime) await this.#deactivate("pending");
    if (this.#state === "failed") this.#state = "pending";
    await this.#sync();
  }

  async #activate(): Promise<void> {
    this.#state = "activating";
    this.#error = null;
    const runtime = this.#holder.fork(`${this.name}#${this.#activations + 1}`);
    this.#runtime = runtime;
    this.#activations += 1;
    try {
      await this.#plugin.apply(runtime, this.#config);
      // State may have moved on while apply awaited (for example disposal).
      if ((this.#state as PluginState) !== "activating") return;
      this.#state = "active";
      this.#holder[KERNEL_EMIT](PLUGIN_EVENT, this.name, "active");
    } catch (error) {
      if ((this.#state as PluginState) === "disposed") return;
      this.#error = error;
      this.#runtime = null;
      await runtime.dispose().catch(() => {});
      this.#state = "failed";
      this.#holder[KERNEL_EMIT](PLUGIN_EVENT, this.name, "failed", error);
    }
  }

  async #deactivate(next: PluginState): Promise<void> {
    const runtime = this.#runtime;
    this.#runtime = null;
    this.#state = next;
    if (runtime) await runtime.dispose();
    this.#holder[KERNEL_EMIT](PLUGIN_EVENT, this.name, next);
  }
}
