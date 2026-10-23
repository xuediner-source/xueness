/**
 * Python `plugin_sdk.plan` for the builtins a run may activate.
 *
 * A stored manifest that names a builtin governs it even when the document
 * fails validation. No manifest means the caller's explicit list is enough.
 * Grants are the only way a manifest's `command` / `network` /
 * `filesystem-write` capabilities take effect.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isDict, isPyIntValue, numericValue, pyRepr, pyStr } from "@xueness/contracts";
import { isLink, pyCodeCompare, readJsonObject, resourceKindDir, validResourceId } from "@xueness/sessions";

const API_VERSION = 1;
const CAPABILITIES = ["command", "network", "filesystem-write"] as const;
const BUILTINS = new Set(["skills", "hooks", "subagents", "mcp", "subscriptions", "model_monitor", "workbuddy"]);
const VERSION = /^\d+\.\d+\.\d+$/;
const FORBIDDEN = ["entrypoint", "command"] as const;

export interface PlannedManifest {
  id: string;
  version: string;
  apiVersion: number;
  enabled: boolean;
  builtin: string;
  capabilities: string[];
}

export interface PluginPlan {
  load: string[];
  refused: { name: string; reason: string }[];
  manifests: Record<string, PlannedManifest>;
}

interface Entry { item: Record<string, unknown>; manifest: PlannedManifest | null; errors: string[] }

function pyTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === "") return false;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "bigint") return value !== 0n;
  const numeric = numericValue(value);
  if (numeric !== null && (typeof value !== "string")) return numeric !== 0;
  if (Array.isArray(value)) return value.length > 0;
  if (isDict(value)) return Object.keys(value).length > 0;
  return true;
}

/** Python `==` against `1`: `True` and `1.0` match, `False` does not. */
function equalsApi(value: unknown): boolean {
  return numericValue(value) === 1;
}

function validateManifest(item: Record<string, unknown>): [PlannedManifest | null, string[]] {
  const errors: string[] = [];
  for (const forbidden of FORBIDDEN) if (pyTruthy(item[forbidden])) errors.push("external plugin code requires a separate audit");
  let id: string | null = typeof item.id === "string" ? item.id : null;
  if (!validResourceId(item.id)) { errors.push("invalid id"); id = null; }
  if (typeof item.version !== "string" || !VERSION.test(item.version)) errors.push("version must be MAJOR.MINOR.PATCH");
  if (!isPyIntValue(item.apiVersion)) errors.push("apiVersion must be an integer");
  else if (!equalsApi(item.apiVersion)) errors.push("incompatible apiVersion");
  if (typeof item.builtin !== "string" || !BUILTINS.has(item.builtin)) errors.push("builtin must name a known capability");
  const caps: string[] = [];
  if (item.capabilities !== undefined) {
    if (!Array.isArray(item.capabilities)) errors.push("capabilities must be an array");
    else for (const cap of item.capabilities) {
      if (!CAPABILITIES.includes(cap as typeof CAPABILITIES[number])) { errors.push(`unknown capability: ${pyRepr(cap)}`); break; }
      if (!caps.includes(cap as string)) caps.push(cap as string);
    }
  }
  if (errors.length || id === null || typeof item.version !== "string" || typeof item.builtin !== "string" || !isPyIntValue(item.apiVersion)) return [null, errors];
  return [{ id, version: item.version, apiVersion: Number(item.apiVersion), enabled: item.enabled === true, builtin: item.builtin, capabilities: caps }, []];
}

/** First gate reason on the raw document, or null. Order is part of the contract. */
function gate(item: Record<string, unknown>, grants: ReadonlySet<string>): string | null {
  if (item.enabled !== true) return "disabled";
  if (!equalsApi(item.apiVersion)) return "incompatible apiVersion";
  for (const forbidden of FORBIDDEN) if (pyTruthy(item[forbidden])) return "external plugin code requires a separate audit";
  if (Array.isArray(item.capabilities)) {
    for (const capability of CAPABILITIES) if (item.capabilities.includes(capability) && !grants.has(capability)) return `missing grant: ${capability}`;
  }
  return null;
}

function pluginFiles(stateDir: string): string[] {
  let directory: string;
  try { directory = resourceKindDir(stateDir, "plugins"); } catch { return []; }
  try { if (!statSync(directory).isDirectory()) return []; } catch { return []; }
  if (isLink(directory)) return [];
  const windows = process.platform === "win32";
  let names: string[];
  try { names = readdirSync(directory); } catch { return []; }
  return names.filter((name) => (windows ? name.toLowerCase().endsWith(".json") : name.endsWith(".json")) && !name.includes("/") && !name.includes("\\"))
    .sort(pyCodeCompare)
    .map((name) => join(directory, name));
}

function loadEntries(stateDir: string): Entry[] {
  const entries: Entry[] = [];
  for (const path of pluginFiles(stateDir)) {
    if (isLink(path)) continue;
    const item = readJsonObject(path);
    if (!item || !Object.hasOwn(item, "id")) continue;
    const [manifest, errors] = validateManifest(item);
    entries.push({ item, manifest, errors });
  }
  return entries;
}

/** `plugin_sdk.plan`. `requested` is the caller's explicit builtin list. */
export function planPlugins(stateDir: string, requested: readonly unknown[], grants: readonly unknown[] = []): PluginPlan {
  const grantSet = new Set(grants.filter((grant): grant is string => typeof grant === "string"));
  const byBuiltin = new Map<string, Entry[]>();
  for (const entry of loadEntries(stateDir)) {
    const builtin = entry.item.builtin;
    if (typeof builtin === "string" && BUILTINS.has(builtin)) {
      const rows = byBuiltin.get(builtin) ?? [];
      rows.push(entry);
      byBuiltin.set(builtin, rows);
    }
  }
  const load: string[] = [];
  const refused: { name: string; reason: string }[] = [];
  const manifests: Record<string, PlannedManifest> = {};
  const seen = new Set<string>();
  for (const raw of requested) {
    if (typeof raw !== "string" || !raw || seen.has(raw)) continue;
    seen.add(raw);
    if (!BUILTINS.has(raw)) { refused.push({ name: raw, reason: "unknown capability" }); continue; }
    const candidates = (byBuiltin.get(raw) ?? []).slice().sort((left, right) => pyCodeCompare(pyStr(left.item.id ?? ""), pyStr(right.item.id ?? "")));
    if (!candidates.length) { load.push(raw); continue; }
    const winner = candidates[0]!;
    const winnerId = pyStr(winner.item.id ?? "");
    for (const loser of candidates.slice(1)) refused.push({ name: pyStr(loser.item.id ?? ""), reason: `conflicting manifest: ${winnerId}` });
    let reason = gate(winner.item, grantSet);
    if (reason === null && winner.manifest === null) reason = winner.errors[0] ?? "invalid manifest";
    if (reason !== null) { refused.push({ name: raw, reason }); continue; }
    load.push(raw);
    if (winner.manifest) manifests[raw] = winner.manifest;
  }
  return { load, refused, manifests };
}
