/**
 * Composition profiles (`bundled_plugins/extensions/profiles.py` HTTP).
 *
 * Built-in rows ship in `profiles.json`. Custom rows are data files under
 * `<state>/plugin-profiles` and never imported. A built-in name wins a clash.
 */
import { readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { BUNDLED_PLUGIN_IDS, isDict, JsonFloat, pyJsonLoadsBytes, pyStr, PyValueError } from "@xueness/contracts";
import { isLink, isPyOSError, isPyValueError, pyCodeCompare } from "@xueness/sessions";
import { BoundedReadError, isDirectory, readLimited } from "./io.ts";
import { catalog, preview, profileState, setProfile, type CatalogSlice } from "./runtime.ts";
import type { ExtensionsReply } from "./validate.ts";

const CUSTOM_DIRECTORY = "plugin-profiles";
const MAX_PROFILE_BYTES = 64 * 1024;
const MAX_PROFILES = 64;
const MAX_EXTENDS_DEPTH = 8;
const PROFILE_NAME = /^[a-z][a-z0-9_-]{0,63}$/u;
const DOCUMENT_FIELDS = new Set(["apiVersion", "profiles"]);
const PROFILE_FIELDS = new Set(["name", "nameEn", "description", "descriptionEn", "extends", "plugins"]);
const PLUGIN_IDS = new Set<string>(BUNDLED_PLUGIN_IDS);

interface Profile {
  name: string;
  extends: string | null;
  plugins: Record<string, boolean>;
  nameEn: unknown;
  description: unknown;
  descriptionEn: unknown;
}

interface Resolved {
  name: string;
  source: string;
  chain: string[];
  plugins: Record<string, boolean>;
}

function refuse(message: string): never {
  throw new PyValueError(`invalid plugin profile: ${message}`);
}

const profileName = (value: string): boolean => PROFILE_NAME.test(value) && !value.endsWith("\n");

function looseOne(value: unknown): boolean {
  if (value === true || value === 1) return true;
  return value instanceof JsonFloat && value.value === 1;
}

function readJson(path: string, limit: number): unknown {
  const name = basename(path);
  if (isLink(path)) refuse(`${name} must not be a symlink`);
  let raw: Buffer;
  try {
    raw = readLimited(path, limit);
  } catch (error) {
    if (error instanceof BoundedReadError) refuse(`${name} exceeds ${limit} bytes`);
    if (isPyOSError(error)) refuse(`${name} cannot be read`);
    throw error;
  }
  try {
    return pyJsonLoadsBytes(raw);
  } catch (error) {
    if (isPyValueError(error)) refuse(`${name} is not valid JSON`);
    throw error;
  }
}

function switches(document: unknown, name: string): Profile {
  if (!isDict(document)) refuse(`${name} uses unsupported fields`);
  if (Object.keys(document).some((key) => !PROFILE_FIELDS.has(key))) refuse(`${name} uses unsupported fields`);
  if (Object.hasOwn(document, "name") && document.name !== name) refuse(`${name} does not name itself consistently`);
  const parent = Object.hasOwn(document, "extends") ? document.extends : null;
  if (parent !== null && (typeof parent !== "string" || !profileName(parent))) refuse(`${name} names an invalid profile to extend`);
  const plugins = document.plugins;
  if (!isDict(plugins)) refuse(`${name} must list plugin switches`);
  if (Object.keys(plugins).length === 0) refuse(`${name} must list plugin switches`);
  if (Object.keys(plugins).length > BUNDLED_PLUGIN_IDS.length) refuse(`${name} lists more switches than there are plugins`);
  const copy: Record<string, boolean> = {};
  for (const [pluginId, value] of Object.entries(plugins)) {
    if (!PLUGIN_IDS.has(pluginId)) refuse(`${name} selects an unknown plugin: ${pluginId}`);
    if (typeof value !== "boolean") refuse(`${name} switch for ${pluginId} must be a boolean`);
    else copy[pluginId] = value;
  }
  return {
    name,
    extends: typeof parent === "string" ? parent : null,
    plugins: copy,
    nameEn: Object.hasOwn(document, "nameEn") ? document.nameEn : null,
    description: Object.hasOwn(document, "description") ? document.description : null,
    descriptionEn: Object.hasOwn(document, "descriptionEn") ? document.descriptionEn : null,
  };
}

function builtIn(): Record<string, Profile> {
  const document = readJson(join(import.meta.dirname, "..", "profiles.json"), MAX_PROFILE_BYTES);
  if (!isDict(document)) refuse("the shipped profile file uses unsupported fields");
  if (Object.keys(document).some((key) => !DOCUMENT_FIELDS.has(key)) || !looseOne(document.apiVersion)) refuse("the shipped profile file uses unsupported fields");
  const rows = document.profiles;
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > MAX_PROFILES) refuse("the shipped profile file lists no usable profiles");
  const result: Record<string, Profile> = {};
  for (const row of rows) {
    if (!isDict(row) || typeof row.name !== "string" || !profileName(row.name)) refuse("a shipped profile has an invalid name");
    if (Object.hasOwn(result, row.name)) refuse(`a shipped profile is listed twice: ${row.name}`);
    result[row.name] = switches(row, row.name);
  }
  return result;
}

function jsonStem(name: string): string {
  return name.toLowerCase().endsWith(".json") ? name.slice(0, -5) : name;
}

function custom(stateDir: string): Record<string, Profile> {
  const directory = join(stateDir, CUSTOM_DIRECTORY);
  if (isLink(directory)) refuse(`${CUSTOM_DIRECTORY} must not be a symlink`);
  if (!isDirectory(directory)) return {};
  const names = readdirSync(directory)
    .filter((name) => (process.platform === "win32" ? name.toLowerCase().endsWith(".json") : name.endsWith(".json")))
    .sort(pyCodeCompare);
  if (names.length > MAX_PROFILES) refuse(`more than ${MAX_PROFILES} custom profiles`);
  const result: Record<string, Profile> = {};
  for (const filename of names) {
    const path = join(directory, filename);
    const name = jsonStem(filename);
    if (!profileName(name) || isLink(path)) refuse(`${filename} is not a usable profile file`);
    result[name] = switches(readJson(path, MAX_PROFILE_BYTES), name);
  }
  return result;
}

function tables(stateDir: string): [Record<string, Profile>, Record<string, string>] {
  const table: Record<string, Profile> = {};
  const sources: Record<string, string> = {};
  for (const [name, entry] of Object.entries(builtIn())) {
    table[name] = entry;
    sources[name] = "built-in";
  }
  for (const [name, entry] of Object.entries(custom(stateDir))) {
    if (!Object.hasOwn(table, name)) table[name] = entry;
    if (!Object.hasOwn(sources, name)) sources[name] = "custom";
  }
  return [table, sources];
}

/** One profile with parents merged, deepest parent first. */
export function resolve(stateDir: string, name: unknown): Resolved {
  const [table, sources] = tables(stateDir);
  if (typeof name !== "string" || !profileName(name)) throw new PyValueError(`invalid plugin profile name: ${pyStr(name)}`);
  if (!Object.hasOwn(table, name)) throw new PyValueError(`unknown plugin profile: ${name}`);
  const chain: string[] = [];
  let current = name;
  while (true) {
    if (chain.includes(current)) throw new PyValueError(`cyclic plugin profile inheritance: ${[...chain, current].join(" -> ")}`);
    if (chain.length >= MAX_EXTENDS_DEPTH) throw new PyValueError(`plugin profile inheritance deeper than ${MAX_EXTENDS_DEPTH} levels`);
    const entry = table[current]!;
    chain.push(current);
    if (!entry.extends) break;
    current = entry.extends;
    if (!Object.hasOwn(table, current)) throw new PyValueError(`unknown plugin profile: ${current}`);
  }
  const plugins: Record<string, boolean> = {};
  for (const level of [...chain].reverse()) Object.assign(plugins, table[level]!.plugins);
  return { name, source: sources[name] ?? "built-in", chain, plugins };
}

const sortedIds = (plugins: Record<string, boolean>, enabled: boolean): string[] => Object.keys(plugins).filter((id) => plugins[id] === enabled).sort(pyCodeCompare);

/** Every selectable profile and the switches it would choose. */
export function describe(stateDir: string): Record<string, unknown>[] {
  const active = profileState(stateDir).name;
  const [table, sources] = tables(stateDir);
  return Object.keys(table).sort(pyCodeCompare).map((name) => {
    const resolved = resolve(stateDir, name);
    const row = table[name]!;
    return {
      name,
      source: sources[name],
      extends: resolved.chain.slice(1),
      description: row.description || "",
      descriptionEn: row.descriptionEn || "",
      enabled: sortedIds(resolved.plugins, true),
      disabled: sortedIds(resolved.plugins, false),
      active: name === active,
    };
  });
}

function sliceCatalog(items: CatalogSlice[]): Pick<CatalogSlice, "id" | "enabled" | "effective" | "blockedBy">[] {
  return items.map(({ id, enabled, effective, blockedBy }) => ({ id, enabled, effective, blockedBy }));
}

/** Select a profile, or report the selection when `dryRun` is true. Does not call `sync_services`. */
export function apply(stateDir: string, name: string, dryRun = false): Record<string, unknown> {
  const resolved = resolve(stateDir, name);
  const overlay = resolved.plugins;
  const before = new Map(catalog(stateDir).map((item) => [item.id, item]));
  const after = dryRun ? preview(stateDir, overlay) : setProfile(stateDir, name, overlay);
  const changes: Record<string, unknown>[] = [];
  const blocked: Record<string, unknown>[] = [];
  const warnings: Record<string, unknown>[] = [];
  for (const item of after) {
    const previous = before.get(item.id)!;
    if (typeof overlay[item.id] === "boolean" && item.enabled !== overlay[item.id]) {
      warnings.push({ code: "explicitSwitchKept", id: item.id, message: `your own switch for ${item.id} is kept ahead of the profile` });
    }
    if (item.enabled !== previous.enabled || item.effective !== previous.effective) {
      changes.push({ id: item.id, enabled: item.enabled, wasEnabled: previous.enabled, effective: item.effective, wasEffective: previous.effective });
    }
    if (overlay[item.id] && item.blockedBy.length) blocked.push({ id: item.id, blockedBy: item.blockedBy });
  }
  if (overlay.extensions === false) {
    warnings.push({ code: "profileOwnerDisabled", message: 'this profile switches extensions off, so profiles stop working until "xueness plugins enable extensions" runs' });
  }
  return { ok: true, dryRun: Boolean(dryRun), profile: name, source: resolved.source, extends: resolved.chain.slice(1), changes, blocked, warnings, catalog: sliceCatalog(after) };
}

/** `GET /api/plugins/profiles` and `POST /api/plugins/profiles/apply`. Other paths under the prefix are 405. */
export function dispatchProfiles(method: string, parts: readonly string[], data: unknown, stateDir: string): ExtensionsReply | null {
  if (parts[0] !== "api" || parts[1] !== "plugins" || parts[2] !== "profiles") return null;
  if (parts.length === 3 && method === "GET") return [200, { active: profileState(stateDir).name, profiles: describe(stateDir) }];
  if (parts.length === 4 && parts[3] === "apply" && method === "POST") {
    if (!isDict(data) || Object.keys(data).some((key) => key !== "name" && key !== "dryRun")) return [400, { error: "expected a profile name" }];
    if (typeof data.name !== "string") return [400, { error: "profile name is required" }];
    try {
      return [200, apply(stateDir, data.name, data.dryRun === true)];
    } catch (error) {
      if (isPyValueError(error) || isPyOSError(error)) return [400, { error: (error instanceof Error ? error.message : String(error)).slice(0, 200) }];
      throw error;
    }
  }
  return [405, { error: "method not allowed" }];
}
