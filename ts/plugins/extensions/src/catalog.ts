/**
 * The kernel plugin manager: `GET /api/plugins` and `POST /api/plugins/<id>`
 * (`plugin_runtime.catalog`, `set_enabled`, `plugin_scope.activation_plan` and
 * that branch of `dispatch_http`).
 *
 * A row is the shipped manifest, keys in file order, plus switch, install,
 * dependency and activation state. The frontend declarations (`panels`,
 * `frontendModules`, `desktopModules`) come from the TS manifests (`ui`);
 * every other field is the shipped manifest. A toggle takes the shared
 * `.plugin-state.lock` when the host supplies its lock provider. Python's
 * `sync_services` is not called here: Python syncs on its next mutating request.
 */
import { BUNDLED_PLUGIN_IDS, PyValueError } from "@xueness/contracts";
import { isPyOSError, isPyValueError, type FileLockProvider } from "@xueness/sessions";
import { componentSummary } from "./components.ts";
import { brokenState, readState, resolveRows, writeState, type SwitchState } from "./runtime.ts";

type Dict = Record<string, unknown>;
type Reply = [number, unknown];
const PLUGIN_IDS = BUNDLED_PLUGIN_IDS as readonly string[];
export const UI_FIELDS = ["panels", "frontendModules", "desktopModules"] as const;
export type UiDeclarations = Partial<Record<(typeof UI_FIELDS)[number], readonly string[]>>;
const BROKEN = "invalid plugin configuration; repair plugin-state.json";

export interface PluginCatalogOptions {
  stateDir: string;
  /** The shipped bundled manifests by id. */
  manifests: () => ReadonlyMap<string, Dict>;
  /** The TS manifests' frontend declarations by id. */
  ui: ReadonlyMap<string, UiDeclarations>;
  /** Second `/api/plugins` segments a manifest's `httpFamilies` claim (`_plugin_owned_segments`). */
  ownedSegments: ReadonlySet<string>;
  locks?: FileLockProvider;
}

const textList = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item !== "") : [];

/** `activation_plan`: providers before dependents, and why an effective plugin cannot activate. */
export function activationPlan(rows: readonly Dict[]): { order: string[]; blocked: Map<string, string> } {
  const byId = new Map<string, Dict>();
  for (const row of rows) if (typeof row.id === "string") byId.set(row.id, row);
  const candidates = [...byId].filter(([, row]) => row.effective === true).map(([pid]) => pid);
  const candidateSet = new Set(candidates);
  const providers = new Map<string, string>();
  for (const pid of candidates) for (const name of textList(byId.get(pid)!.provides)) if (!providers.has(name)) providers.set(name, pid);
  const order: string[] = [], ready = new Set<string>(), blocked = new Map<string, string>();
  const pending = [...candidates];
  const wanted = (pid: string): string[] => {
    const published = textList(byId.get(pid)!.provides);
    return textList(byId.get(pid)!.inject).filter((name) => !published.includes(name));
  };
  const deps = (pid: string): string[] => textList(byId.get(pid)!.dependencies);
  const failure = (pid: string): string | null => {
    const parts: string[] = [];
    const dead = deps(pid).filter((dep) => byId.has(dep) && !candidateSet.has(dep));
    if (dead.length) parts.push("dependency not effective: " + dead.join(", "));
    const missing = [...new Set(wanted(pid).filter((name) => !providers.has(name) || blocked.has(providers.get(name)!)))];
    for (const name of missing) parts.push(providers.has(name) ? "provider cannot activate: " + name : "service unavailable: " + name);
    return parts.join("; ") || null;
  };
  while (pending.length) {
    let progressed = false;
    for (const pid of [...pending]) {
      const detail = failure(pid);
      if (detail) { pending.splice(pending.indexOf(pid), 1); blocked.set(pid, detail); progressed = true; continue; }
      const waiting = [
        ...wanted(pid).filter((name) => providers.has(name) && !ready.has(providers.get(name)!)),
        ...deps(pid).filter((dep) => candidateSet.has(dep) && !ready.has(dep)),
      ];
      if (waiting.length) continue;
      pending.splice(pending.indexOf(pid), 1); ready.add(pid); order.push(pid); progressed = true;
    }
    if (!progressed) {
      for (const pid of pending) {
        const cycle = wanted(pid).filter((name) => pending.includes(providers.get(name) ?? "\0"));
        blocked.set(pid, "cyclic service injection" + (cycle.length ? ": " + cycle.join(", ") : ""));
      }
      pending.length = 0;
    }
  }
  return { order, blocked };
}

/** `catalog`: every bundled plugin with its switch, install, dependency and activation state. */
export function catalogItems(options: PluginCatalogOptions): Dict[] {
  let state: SwitchState;
  let error = "";
  try {
    state = readState(options.stateDir);
  } catch (caught) {
    if (!isPyValueError(caught) && !isPyOSError(caught)) throw caught;
    state = brokenState();
    error = BROKEN;
  }
  const manifests = options.manifests();
  const items = resolveRows(options.stateDir, state.enabled, state.profile.overlay).map((row) => {
    const item: Dict = { ...manifests.get(row.id) };
    const ui = options.ui.get(row.id);
    for (const key of UI_FIELDS) if (ui && (ui[key] !== undefined || Object.hasOwn(item, key))) item[key] = [...ui[key] ?? []];
    // F07.05: the panel answers "which components live in this plugin" without a second round trip.
    item.components = componentSummary(options.stateDir, row.id);
    Object.assign(item, { enabled: row.enabled, effective: row.effective, installed: row.installed, blockedBy: row.blockedBy }, error ? { configurationError: error } : {});
    return item;
  });
  const { order, blocked } = activationPlan(items);
  const activated = new Set(order);
  for (const item of items) {
    item.activated = activated.has(item.id as string);
    if (blocked.has(item.id as string)) item.activationError = blocked.get(item.id as string);
  }
  return items;
}

/** `set_enabled`: switch one plugin under the shared lock and return the new catalog. */
export async function setPluginEnabled(options: PluginCatalogOptions, pluginId: string, enabled: unknown): Promise<Dict[]> {
  if (!PLUGIN_IDS.includes(pluginId)) throw new PyValueError("unknown plugin: " + pluginId);
  if (typeof enabled !== "boolean") throw new PyValueError("enabled must be a boolean");
  const handle = await options.locks?.acquire(options.stateDir, ".plugin-state.lock", 30);
  try {
    const state = readState(options.stateDir);
    if (enabled) {
      const item = catalogItems(options).find((row) => row.id === pluginId)!;
      if (!item.installed) throw new PyValueError("install the optional package from the marketplace first");
      const unavailable = item.blockedBy as string[];
      if (unavailable.length) throw new PyValueError("enable dependencies first: " + unavailable.join(", "));
    }
    state.enabled[pluginId] = enabled;
    writeState(options.stateDir, state.enabled, state.profile);
    return catalogItems(options);
  } finally {
    handle?.release();
  }
}

export function ownsPluginCatalog(options: Pick<PluginCatalogOptions, "ownedSegments">, parts: readonly string[]): boolean {
  return parts[0] === "api" && parts[1] === "plugins" && (parts.length < 3 || !options.ownedSegments.has(parts[2]!));
}

/** The `/api/plugins` branch of `dispatch_http`. */
export async function dispatchPluginCatalog(options: PluginCatalogOptions, method: string, parts: readonly string[], data: Dict): Promise<Reply> {
  if (parts.length === 2 && method === "GET") return [200, { plugins: catalogItems(options) }];
  if (parts.length === 3 && method === "POST") {
    const keys = Object.keys(data);
    if (keys.length !== 1 || keys[0] !== "enabled") return [400, { error: "expected enabled boolean only" }];
    try {
      return [200, { plugins: await setPluginEnabled(options, parts[2]!, data.enabled) }];
    } catch (error) {
      if (isPyValueError(error) || isPyOSError(error)) return [400, { error: error instanceof Error ? error.message : String(error) }];
      throw error;
    }
  }
  return [405, { error: "method not allowed" }];
}
