/**
 * Profile layer of `plugin-state.json` (`plugin_runtime` profile_state / preview / set_profile).
 *
 * Resolution reads the shipped bundled manifests (default, dependencies,
 * installPackage) so the graph is not copied here. Writes are in-process:
 * Python's cross-process flock is the host's lock, not this reply.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BUNDLED_PLUGIN_IDS, isDict, JsonFloat, pyJsonLoadsBytes, PyKeyError, PyValueError } from "@xueness/contracts";
import { isLink, isPyOSError, isPyValueError, pyCodeCompare } from "@xueness/sessions";
import { BoundedReadError, readLimited, atomicWriteJson } from "./io.ts";
import { loadManifests } from "./sdk.ts";

const MAX_STATE_BYTES = 65536;
const MAX_PROFILE_NAME = 64;
const CONFIG_NAME = "plugin-state.json";
const PLUGIN_IDS = BUNDLED_PLUGIN_IDS as readonly string[];

export interface CatalogSlice {
  id: string;
  enabled: boolean;
  effective: boolean;
  blockedBy: string[];
}

/** One resolved catalog row before the manifest fields are merged in. */
export interface CatalogRow extends CatalogSlice {
  installed: boolean;
}

interface BundledManifest {
  defaultEnabled: boolean;
  dependencies: string[];
  installPackage?: string;
}

export interface ProfileLayer {
  name: string | null;
  overlay: Record<string, boolean>;
}

export interface SwitchState {
  enabled: Record<string, boolean>;
  profile: ProfileLayer;
}

let manifestCache: Map<string, BundledManifest> | null = null;

/**
 * `ts/catalog` in a checkout, `dist/catalog` in a build. A checkout loads this
 * package through the `ts/node_modules` workspace junction, but a build loads
 * the materialized copy at `dist/node_modules/@xueness/plugin-extensions`, so
 * `import.meta.dirname` sits at a different depth. Search upwards for the
 * shipped manifests instead of hardcoding one depth.
 */
function catalogDirectory(): string {
  for (let dir = import.meta.dirname; ; dir = dirname(dir)) {
    const candidate = join(dir, "catalog");
    if (PLUGIN_IDS.every((pid) => existsSync(join(candidate, pid + ".json")))) return candidate;
    if (dirname(dir) === dir) throw new PyValueError("bundled plugin catalog is missing");
  }
}

function bundledManifests(): Map<string, BundledManifest> {
  if (manifestCache) return manifestCache;
  const catalog = catalogDirectory();
  const manifests = new Map<string, BundledManifest>();
  for (const pid of PLUGIN_IDS) {
    const item = JSON.parse(readFileSync(join(catalog, pid + ".json"), "utf8")) as Record<string, unknown>;
    if (item.id !== pid || item.apiVersion !== 1 || typeof item.apiVersion === "boolean") throw new PyValueError("incompatible bundled plugin manifest");
    if (typeof item.defaultEnabled !== "boolean") throw new PyValueError("invalid bundled plugin default");
    if (!Object.hasOwn(item, "dependencies")) throw new PyKeyError("'dependencies'");
    if (!Array.isArray(item.dependencies) || item.dependencies.some((dep) => typeof dep !== "string" || !PLUGIN_IDS.includes(dep))) {
      throw new PyValueError("unknown bundled plugin dependency");
    }
    const installPackage = typeof item.installPackage === "string" && item.installPackage ? item.installPackage : undefined;
    manifests.set(pid, { defaultEnabled: item.defaultEnabled, dependencies: item.dependencies, ...(installPackage ? { installPackage } : {}) });
  }
  manifestCache = manifests;
  return manifests;
}

function acceptedVersion(value: unknown): boolean {
  if (typeof value === "boolean") return false;
  if (value === 1) return true;
  return value instanceof JsonFloat && value.value === 1;
}

function switchMap(value: unknown, message: string): Record<string, boolean> {
  if (!isDict(value)) throw new PyValueError(message);
  const switches: Record<string, boolean> = {};
  for (const [pid, item] of Object.entries(value)) {
    if (!PLUGIN_IDS.includes(pid) || typeof item !== "boolean") throw new PyValueError(message);
    switches[pid] = item;
  }
  return switches;
}

function readProfile(value: unknown): ProfileLayer {
  if (value == null) return { name: null, overlay: {} };
  if (!isDict(value) || Object.keys(value).some((key) => key !== "name" && key !== "overlay")) throw new PyValueError("unknown plugin profile fields");
  const name = Object.hasOwn(value, "name") ? value.name : null;
  if (name !== null && (typeof name !== "string" || name.length === 0 || name.length > MAX_PROFILE_NAME)) throw new PyValueError("invalid plugin profile name");
  const overlay = Object.hasOwn(value, "overlay") ? value.overlay : undefined;
  return { name: name as string | null, overlay: switchMap(overlay, "invalid plugin profile switches") };
}

/** `_read_state`. A missing file is an empty switch map; anything else is refused. */
export function readState(stateDir: string): SwitchState {
  const path = join(stateDir, CONFIG_NAME);
  if (isLink(path)) throw new PyValueError("plugin configuration must not be a symlink");
  let raw: Buffer;
  try {
    raw = readLimited(path, MAX_STATE_BYTES);
  } catch (error) {
    if (error instanceof BoundedReadError) throw new PyValueError("plugin configuration too large");
    if (isPyOSError(error) && (error as NodeJS.ErrnoException).code === "ENOENT") return { enabled: {}, profile: { name: null, overlay: {} } };
    throw error;
  }
  let item: unknown;
  try {
    item = pyJsonLoadsBytes(raw, { lossless: true });
  } catch (error) {
    if (isPyValueError(error)) throw new PyValueError("invalid plugin configuration");
    throw error;
  }
  if (!isDict(item) || !acceptedVersion(item.apiVersion)) throw new PyValueError("invalid plugin configuration version");
  if (Object.keys(item).some((key) => key !== "apiVersion" && key !== "enabled" && key !== "profile")) throw new PyValueError("unknown plugin configuration fields");
  return { enabled: switchMap(Object.hasOwn(item, "enabled") ? item.enabled : undefined, "invalid plugin switches"), profile: readProfile(Object.hasOwn(item, "profile") ? item.profile : null) };
}

/** `profile_state`: the active profile, or a closed empty layer when the file is broken. */
export function profileState(stateDir: string): ProfileLayer {
  try {
    return readState(stateDir).profile;
  } catch (error) {
    if (isPyValueError(error) || isPyOSError(error)) return { name: null, overlay: {} };
    throw error;
  }
}

export function brokenState(): SwitchState {
  const enabled: Record<string, boolean> = {};
  for (const pid of PLUGIN_IDS) enabled[pid] = false;
  return { enabled, profile: { name: null, overlay: {} } };
}

/** `_resolve_items` without the manifest merge: switch, install and dependency state per bundled id. */
export function resolveRows(stateDir: string, switches: Record<string, boolean>, overlay: Record<string, boolean>): CatalogRow[] {
  const manifests = bundledManifests();
  const packages = new Set<string>();
  if ([...manifests.values()].some((item) => item.installPackage)) {
    for (const item of loadManifests(stateDir)) packages.add(`${item.id}\0${item.builtin}`);
  }
  const installed = new Map<string, boolean>();
  for (const [pid, item] of manifests) installed.set(pid, !item.installPackage || packages.has(`${item.installPackage}\0${pid}`));
  const effective = new Map<string, boolean>();
  const chosen = (pid: string): boolean => (Object.hasOwn(switches, pid) ? switches[pid]! : Object.hasOwn(overlay, pid) ? overlay[pid]! : manifests.get(pid)!.defaultEnabled);
  const resolve = (pid: string, visiting: readonly string[]): boolean => {
    const known = effective.get(pid);
    if (known !== undefined) return known;
    if (visiting.includes(pid)) throw new PyValueError("cyclic plugin dependencies");
    const available = installed.get(pid) === true && chosen(pid) && manifests.get(pid)!.dependencies.every((dep) => resolve(dep, [...visiting, pid]));
    effective.set(pid, available);
    return available;
  };
  for (const pid of PLUGIN_IDS) resolve(pid, []);
  return PLUGIN_IDS.map((pid) => ({
    id: pid,
    enabled: chosen(pid),
    effective: effective.get(pid) === true,
    installed: installed.get(pid) === true,
    blockedBy: manifests.get(pid)!.dependencies.filter((dep) => effective.get(dep) !== true),
  }));
}

const slice = (rows: readonly CatalogRow[]): CatalogSlice[] => rows.map(({ id, enabled, effective, blockedBy }) => ({ id, enabled, effective, blockedBy }));

function readOrBroken(stateDir: string): SwitchState {
  try {
    return readState(stateDir);
  } catch (error) {
    if (isPyValueError(error) || isPyOSError(error)) return brokenState();
    throw error;
  }
}

/** `catalog`, sliced to the fields profile HTTP returns. Callers own the array. */
export function catalog(stateDir: string): CatalogSlice[] {
  const state = readOrBroken(stateDir);
  return slice(resolveRows(stateDir, state.enabled, state.profile.overlay));
}

/** `preview`: the catalog a proposed overlay would produce. Nothing is written. */
export function preview(stateDir: string, overlay: Record<string, boolean>): CatalogSlice[] {
  const state = readOrBroken(stateDir);
  return slice(resolveRows(stateDir, state.enabled, switchMap(overlay, "invalid plugin profile switches")));
}

export function writeState(stateDir: string, switches: Record<string, boolean>, profile: ProfileLayer): void {
  const item: Record<string, unknown> = { apiVersion: 1, enabled: switches };
  if (profile.name !== null || Object.keys(profile.overlay).length > 0) item.profile = { name: profile.name, overlay: profile.overlay };
  atomicWriteJson(join(stateDir, CONFIG_NAME), item);
}

/** `set_profile`: keep user switches, replace the overlay, return the new catalog. */
export function setProfile(stateDir: string, name: string | null, overlay: Record<string, boolean>): CatalogSlice[] {
  if (name !== null && (typeof name !== "string" || name.length === 0 || name.length > MAX_PROFILE_NAME)) throw new PyValueError("invalid plugin profile name");
  if (!isDict(overlay)) throw new PyValueError("plugin profile overlay must be id/boolean switches");
  if (Object.keys(overlay).length > PLUGIN_IDS.length) throw new PyValueError("plugin profile overlay too large");
  const unknown = Object.keys(overlay).filter((pid) => !PLUGIN_IDS.includes(pid)).sort(pyCodeCompare);
  if (unknown.length) throw new PyValueError(`unknown plugin: ${unknown.join(", ")}`);
  switchMap(overlay, "profile switch must be a boolean");
  const state = readState(stateDir);
  writeState(stateDir, state.enabled, { name, overlay: { ...overlay } });
  return catalog(stateDir);
}
