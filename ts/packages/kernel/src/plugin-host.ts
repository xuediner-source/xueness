/**
 * Plugin host: runs bundled plugins under their apiVersion 2 manifests.
 *
 * The manifest is the contract. The host validates every manifest and the
 * catalog as a whole, checks that the code agrees with its manifest (id and
 * injected services), and loads each enabled plugin in a context restricted
 * to what the manifest declares. A plugin loads only when its grant covers
 * every declared power, and activates once its required services and the
 * plugins it depends on are up (each active plugin provides `plugin.<id>`).
 *
 * Plugins can be enabled, disabled, reconfigured and re-granted at run time.
 * Disabling one first withdraws its marker, so its dependants stop while
 * its services still work, then releases everything it acquired.
 */
import {
  capabilityIssues, catalogIssues, dependencyOrder, formatSchemaIssues, missingGrants, normalizeCapabilities, validateManifest, validateSchema,
  type Capabilities, type CapabilityDeclaration, type PluginManifest, type SchemaIssue,
} from "@xueness/contracts";
import type { Context } from "./context.ts";
import type { Plugin, PluginHandle } from "./plugin.ts";

export interface BundledPlugin {
  /** The plugin's manifest.json document; the host validates it. */
  readonly manifest: unknown;
  readonly plugin: Plugin<any>;
}

export interface PluginHostOptions {
  /** User choices by plugin id (settings, flags); they win over `defaultEnabled`. */
  enabled?: Readonly<Record<string, boolean>>;
  /** Powers granted to a plugin; by default exactly what its manifest declares. */
  grant?: (manifest: PluginManifest) => CapabilityDeclaration | Capabilities;
  /** Config by plugin id, merged over the manifest defaults and checked against its schema. */
  config?: Readonly<Record<string, Record<string, unknown>>>;
  /**
   * How long an operation waits for plugins to finish activating (default
   * 10 s). A plugin still activating after that stays "activating", and
   * stopping it disposes its context anyway, which refuses whatever its
   * `apply` tries to acquire afterwards.
   */
  settleTimeoutMs?: number;
}

export type PluginHostState = "invalid" | "disabled" | "blocked" | "pending" | "activating" | "active" | "failed";

export interface PluginStatus {
  id: string;
  enabled: boolean;
  state: PluginHostState;
  /** How many times the plugin's `apply` has run in this host. */
  activations: number;
  /** Dependencies that are disabled, invalid or blocked themselves. */
  blockedBy: string[];
  /** Required services, or `plugin.<id>` of dependencies, not up yet. */
  waitingFor: string[];
  /** Declared powers the grant does not cover, as capability tokens. */
  missingGrants: string[];
  /** Manifest, code and catalog problems; any of them makes the plugin invalid. */
  issues: string[];
  error: string | null;
}

export class PluginConfigError extends Error {
  override name = "PluginConfigError";
  readonly code = "invalid_config";
  readonly plugin: string;

  constructor(plugin: string, message: string) {
    super(`invalid config for plugin ${plugin}: ${message}`);
    this.plugin = plugin;
  }
}

export class UnknownPluginError extends Error {
  override name = "UnknownPluginError";
  readonly code = "unknown_plugin";
}

interface Entry {
  readonly id: string;
  readonly plugin: Plugin<any>;
  readonly manifest: PluginManifest | null;
  readonly issues: SchemaIssue[];
  enabled: boolean;
  grant: Capabilities;
  config: Record<string, unknown>;
  configError: string | null;
  ctx: Context | null;
  handle: PluginHandle<any> | null;
  withdraw: (() => Promise<void>) | null;
  activations: number;
}

export const markerOf = (id: string): string => `plugin.${id}`;

/** Resolves when `promise` settles or after `ms`, whichever is first; leaves no timer behind. */
async function within(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([promise.catch(() => {}), new Promise<void>((done) => { timer = setTimeout(done, ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

const messageOf = (error: unknown): string | null => (error == null ? null : error instanceof Error ? error.message : String(error));
const sameSet = (left: readonly string[], right: readonly string[]): boolean =>
  new Set(left).size === new Set(right).size && left.every((item) => right.includes(item));

function injectOf(plugin: Plugin<any>): { required: readonly string[]; optional: readonly string[] } {
  const inject = plugin.inject;
  if (inject === undefined) return { required: [], optional: [] };
  if (Array.isArray(inject)) return { required: inject as readonly string[], optional: [] };
  const deps = inject as { required?: readonly string[]; optional?: readonly string[] };
  return { required: deps.required ?? [], optional: deps.optional ?? [] };
}

/** Where the code disagrees with its manifest. */
function codeIssues(manifest: PluginManifest, plugin: Plugin<any>): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  if (plugin.name !== manifest.id) issues.push({ path: "/id", message: `does not match the code's name ${JSON.stringify(plugin.name)}` });
  const inject = injectOf(plugin);
  if (!sameSet(inject.required, manifest.inject.required) || !sameSet(inject.optional, manifest.inject.optional)) {
    issues.push({ path: "/inject", message: `does not match the code (required ${JSON.stringify(inject.required)}, optional ${JSON.stringify(inject.optional)})` });
  }
  return issues;
}

export class PluginHost {
  readonly #ctx: Context;
  readonly #entries = new Map<string, Entry>();
  readonly #order: string[];
  readonly #settleMs: number;
  #queue: Promise<unknown> = Promise.resolve();
  #disposed = false;

  constructor(ctx: Context, bundled: readonly BundledPlugin[], options: PluginHostOptions = {}) {
    this.#ctx = ctx.fork("plugin-host");
    this.#settleMs = options.settleTimeoutMs ?? 10_000;
    for (const { manifest: document, plugin } of bundled) {
      const { manifest, issues } = validateManifest(document);
      const id = manifest?.id ?? (typeof (document as { id?: unknown } | null)?.id === "string" ? (document as { id: string }).id : plugin.name);
      if (this.#entries.has(id)) throw new TypeError(`duplicate plugin id ${id}`);
      if (manifest) issues.push(...codeIssues(manifest, plugin));
      const granted = manifest ? (options.grant?.(manifest) ?? manifest.capabilities) : {};
      const entry: Entry = {
        id, plugin, manifest, issues, enabled: options.enabled?.[id] ?? manifest?.defaultEnabled ?? false,
        grant: this.#normalGrant(id, granted), config: {}, configError: null,
        ctx: null, handle: null, withdraw: null, activations: 0,
      };
      this.#entries.set(id, entry);
      if (manifest) {
        try {
          entry.config = this.#checkConfig(entry, options.config?.[id] ?? {});
        } catch (error) {
          entry.configError = messageOf(error);
        }
      }
    }
    const valid = [...this.#entries.values()].filter((entry) => entry.manifest && !entry.issues.length).map((entry) => entry.manifest as PluginManifest);
    for (const issue of catalogIssues(valid)) this.#entries.get(issue.plugin)?.issues.push({ path: issue.path, message: issue.message });
    const { order } = dependencyOrder(valid);
    this.#order = [...order, ...[...this.#entries.keys()].filter((id) => !order.includes(id))];
  }

  /** Load every enabled plugin and wait until activation settles. */
  start(): Promise<PluginStatus[]> {
    return this.#op(async () => {
      await this.#reconcile();
      return this.list();
    });
  }

  enable(id: string): Promise<PluginStatus> {
    return this.#op(async () => {
      const entry = this.#entry(id);
      entry.enabled = true;
      if (entry.handle?.state === "failed") await within(entry.handle.reload(), this.#settleMs);
      await this.#reconcile();
      return this.status(id);
    });
  }

  disable(id: string): Promise<PluginStatus> {
    return this.#op(async () => {
      this.#entry(id).enabled = false;
      await this.#reconcile();
      return this.status(id);
    });
  }

  /** Replace a plugin's config (merged over its defaults) and restart it if it is loaded. */
  configure(id: string, config: Record<string, unknown>): Promise<PluginStatus> {
    return this.#op(async () => {
      const entry = this.#entry(id);
      entry.config = this.#checkConfig(entry, config);
      entry.configError = null;
      if (entry.handle) await within(entry.handle.reload(entry.config), this.#settleMs);
      await this.#reconcile();
      return this.status(id);
    });
  }

  /** Change what a plugin is granted; it loads or unloads accordingly. */
  setGrant(id: string, grant: CapabilityDeclaration | Capabilities): Promise<PluginStatus> {
    return this.#op(async () => {
      const entry = this.#entry(id);
      entry.grant = this.#normalGrant(id, grant);
      await this.#reconcile();
      return this.status(id);
    });
  }

  manifest(id: string): PluginManifest | null {
    return this.#entry(id).manifest;
  }

  status(id: string): PluginStatus {
    const entry = this.#entry(id);
    const missing = entry.manifest ? missingGrants(entry.manifest.capabilities, entry.grant) : [];
    const blockedBy = entry.manifest ? this.#blockers(entry, new Map()) : [];
    let state: PluginHostState;
    if (entry.issues.length) state = "invalid";
    else if (!entry.enabled) state = "disabled";
    else if (missing.length || blockedBy.length) state = "blocked";
    else if (entry.configError) state = "failed";
    else state = !entry.handle || entry.handle.state === "disposed" ? "pending" : entry.handle.state;
    return {
      id, enabled: entry.enabled, state, activations: entry.activations, blockedBy,
      waitingFor: entry.handle ? entry.handle.missing() : [], missingGrants: missing,
      issues: entry.issues.map((issue) => `${issue.path || "/"} ${issue.message}`),
      error: entry.configError ?? messageOf(entry.handle?.error),
    };
  }

  /** Every plugin, dependencies first. */
  list(): PluginStatus[] {
    return this.#order.map((id) => this.status(id));
  }

  /** Resolves once pending host operations and plugin transitions have settled. */
  async settled(): Promise<void> {
    await this.#queue.catch(() => {});
    await this.#quiet();
  }

  /** Unload every plugin, dependants first. */
  dispose(): Promise<void> {
    return this.#op(async () => {
      for (const id of [...this.#order].reverse()) await this.#unload(this.#entry(id));
      this.#disposed = true;
      await this.#ctx.dispose();
    });
  }

  #op<T>(step: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      if (this.#disposed) throw new Error("plugin host is disposed");
      return step();
    };
    const result = this.#queue.then(run, run);
    this.#queue = result.catch(() => {});
    return result;
  }

  #entry(id: string): Entry {
    const entry = this.#entries.get(id);
    if (!entry) throw new UnknownPluginError(`unknown plugin ${id}`);
    return entry;
  }

  #normalGrant(id: string, grant: CapabilityDeclaration | Capabilities): Capabilities {
    const issues = capabilityIssues(grant, "/grant");
    if (issues.length) throw new TypeError(`invalid grant for plugin ${id}: ${formatSchemaIssues(issues)}`);
    return normalizeCapabilities(grant);
  }

  #checkConfig(entry: Entry, config: Record<string, unknown>): Record<string, unknown> {
    const declared = entry.manifest?.config ?? null;
    if (!declared) {
      if (Object.keys(config).length) throw new PluginConfigError(entry.id, "the plugin takes no configuration");
      return {};
    }
    const merged = { ...declared.default, ...config };
    const issues = validateSchema(declared.schema, merged);
    if (issues.length) throw new PluginConfigError(entry.id, formatSchemaIssues(issues));
    try {
      entry.plugin.validate?.(merged);
    } catch (error) {
      throw new PluginConfigError(entry.id, messageOf(error) ?? "refused by the plugin");
    }
    return merged;
  }

  /** Loadable on its own: valid, enabled, configured and fully granted. Dependencies are waited for at run time. */
  #selfLoadable(entry: Entry): boolean {
    return Boolean(entry.manifest) && !entry.issues.length && entry.enabled && !entry.configError
      && missingGrants((entry.manifest as PluginManifest).capabilities, entry.grant).length === 0;
  }

  #blockers(entry: Entry, memo: Map<string, boolean>): string[] {
    return (entry.manifest?.dependencies ?? []).filter((dep) => !this.#loadable(dep, memo));
  }

  #loadable(id: string, memo: Map<string, boolean>): boolean {
    const known = memo.get(id);
    if (known !== undefined) return known;
    memo.set(id, false);
    const entry = this.#entries.get(id);
    const result = entry !== undefined && this.#selfLoadable(entry) && this.#blockers(entry, memo).length === 0;
    memo.set(id, result);
    return result;
  }

  async #reconcile(): Promise<void> {
    for (const id of [...this.#order].reverse()) {
      const entry = this.#entry(id);
      if (entry.ctx && !this.#selfLoadable(entry)) await this.#unload(entry);
    }
    for (const id of this.#order) {
      const entry = this.#entry(id);
      if (!entry.ctx && this.#selfLoadable(entry)) this.#load(entry);
    }
    await this.#quiet();
  }

  #load(entry: Entry): void {
    const manifest = entry.manifest as PluginManifest;
    const { id, plugin } = entry;
    const ctx = this.#ctx.restrict(`plugin:${id}`, {
      owner: id,
      capabilities: manifest.capabilities,
      provides: [...manifest.provides, markerOf(id)],
      uses: [...manifest.inject.required, ...manifest.inject.optional, ...manifest.provides],
      tools: manifest.tools,
      toolEvents: manifest.toolEvents,
      dependencies: this.#ancestors(id),
    });
    const wrapped: Plugin<Record<string, unknown>> = {
      name: id,
      inject: { required: [...manifest.inject.required, ...manifest.dependencies.map(markerOf)], optional: manifest.inject.optional },
      apply: async (runtime, config) => {
        entry.activations += 1;
        await plugin.apply(runtime, plugin.validate ? plugin.validate(config) : config);
        entry.withdraw = runtime.provide(markerOf(id), Object.freeze({ id, version: manifest.version }));
      },
    };
    entry.ctx = ctx;
    entry.handle = ctx.plugin(wrapped, entry.config);
  }

  /** Every plugin `id` depends on, directly or through another dependency. */
  #ancestors(id: string): string[] {
    const found = new Set<string>();
    const queue = [...(this.#entries.get(id)?.manifest?.dependencies ?? [])];
    for (let dep = queue.shift(); dep !== undefined; dep = queue.shift()) {
      if (found.has(dep) || dep === id) continue;
      found.add(dep);
      queue.push(...(this.#entries.get(dep)?.manifest?.dependencies ?? []));
    }
    return [...found];
  }

  async #unload(entry: Entry): Promise<void> {
    const { ctx, handle } = entry;
    if (!ctx) return;
    entry.ctx = null;
    entry.handle = null;
    if (handle) await within(handle.ready(), this.#settleMs);
    // Dependants stop first, while this plugin's services still work.
    await entry.withdraw?.();
    entry.withdraw = null;
    await this.#quiet();
    await ctx.dispose();
  }

  /** Wait until no plugin has a transition queued (an activation can wake dependants), within the settle timeout. */
  async #quiet(): Promise<void> {
    const deadline = Date.now() + this.#settleMs;
    for (let round = 0; round < 100 && Date.now() < deadline; round += 1) {
      const handles = [...this.#entries.values()].map((entry) => entry.handle).filter((handle) => handle !== null);
      const queued = handles.map((handle) => handle.ready());
      await within(Promise.all(queued), deadline - Date.now());
      const current = [...this.#entries.values()].map((entry) => entry.handle).filter((handle) => handle !== null);
      if (current.length === handles.length && current.every((handle, index) => handle === handles[index] && handle.ready() === queued[index])) return;
    }
  }
}
