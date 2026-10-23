/**
 * `GET /api/composer` (Python `composer_api._get_catalog`): the roots, files,
 * sessions, skills, plugins, capabilities and models a draft may reference.
 * Every list is bounded and labelled; nothing here grants authority.
 */
import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { isDict, pyCasefold, pyDecodeUtf8, pyJsonLoads, pyLen, pyStrip, pyTruthy } from "@xueness/contracts";
import { isLink, pyCodeCompare, realish } from "@xueness/sessions";
import { COMPOSER_CAPABILITIES } from "./composer-data.ts";
import { remoteCatalog, type ComposerRemotePort } from "./composer-remote.ts";
import { hasIgnoredComponent, IGNORED_DIRS, isolatedRoots, parts, readSession, requireEnabled, rootCrossesIgnored, safeLabel, SID_RE, within, type ComposerScope } from "./composer-roots.ts";

type Row = Record<string, unknown>;
export interface PluginEntry { id: string; name?: unknown; description?: unknown }
export interface ComposerCatalogOptions extends ComposerScope {
  allowReal: boolean;
  /** Effective plugins in catalogue order (`plugin_runtime.catalog`, `effective` only). */
  plugins(): readonly PluginEntry[];
  /** Python `skills.catalog` text for the enabled skills. */
  skillsCatalog?(): string;
  models?(): { options: readonly Row[] };
  gitCatalog?(root: string): Promise<Row | null>;
  /** Saved SSH targets from the remote plugin. */
  remote?: ComposerRemotePort;
}

const lstat = (path: string) => { try { return lstatSync(path); } catch { return null; } };
const stat = (path: string) => { try { return statSync(path); } catch { return null; } };

/** `_composer_walk_files`: breadth-first, casefold-sorted, never through links or ignored directories. */
function* walkFiles(root: string): Generator<string> {
  const queue = [root];
  while (queue.length) {
    const current = queue.shift()!;
    let names: string[];
    try { names = readdirSync(current); } catch { continue; }
    const entries = names.map((name) => ({ name, key: pyCasefold(name) })).sort((a, b) => pyCodeCompare(a.key, b.key));
    for (const { name } of entries) {
      const entry = join(current, name), info = lstat(entry);
      if (!info) continue;
      try {
        if (info.isSymbolicLink()) {
          const resolved = realish(entry);
          if (!within(root, resolved)) continue;
          const target = stat(resolved);
          if (!target || target.isDirectory()) continue;
          if (target.isFile() && !hasIgnoredComponent(parts(root, resolved))) yield resolved;
          continue;
        }
        if (info.isDirectory()) { if (!IGNORED_DIRS.has(pyCasefold(name))) queue.push(entry); }
        else if (info.isFile()) {
          const resolved = realish(entry);
          if (within(root, resolved) && !hasIgnoredComponent(parts(root, resolved))) yield resolved;
        }
      } catch { continue; }
    }
  }
}

/** `_file_catalog` over `files.preview.workspace_files(max_tree_files=300)`. */
export function fileCatalog(o: ComposerCatalogOptions, root: string): Row[] {
  if (!o.enabled("files") || isolatedRoots(o).includes(root) || rootCrossesIgnored(o, root)) return [];
  const base = realish(root), files: string[] = [];
  for (const path of walkFiles(base)) {
    if (!stat(path)) continue;
    files.push(parts(base, path).join("/"));
    if (files.length >= 300) break;
  }
  return files.sort(pyCodeCompare).filter((rel) => rel && pyLen(rel) <= 1024).slice(0, 300).map((rel) => ({ id: rel, label: rel }));
}

/** `_session_catalog`: up to 120 sessions of this root, by id. */
export function sessionCatalog(o: ComposerCatalogOptions, root: string): Row[] {
  if (!o.enabled("sessions") || isolatedRoots(o).includes(root)) return [];
  const directory = o.store.directory;
  if (isLink(directory) || !stat(directory)?.isDirectory()) return [];
  const ids: string[] = [];
  let names: string[];
  try { names = readdirSync(directory); } catch { return []; }
  for (const name of names) {
    const sid = name.endsWith(".json") ? name.slice(0, -5) : "";
    if (!SID_RE.test(sid) || !lstat(join(directory, name))?.isFile()) continue;
    ids.push(sid);
    if (ids.length >= 480) break;
  }
  const result: Row[] = [];
  for (const sid of ids.sort(pyCodeCompare).slice(0, 120)) {
    const session = readSession(o, sid);
    if (!session || typeof session.root !== "string") continue;
    try { if (realish(session.root) !== root) continue; } catch { continue; }
    const item: Row = { id: sid, label: safeLabel(pyTruthy(session.title) ? session.title : session.task, sid.slice(0, 8)) };
    const description = typeof session.status === "string" ? safeLabel(session.status, "", 80) : "";
    if (description) item.description = description;
    result.push(item);
  }
  return result;
}

/** `_skills_catalog`: the JSON lines of the skills catalogue, up to 100. */
export function skillsCatalog(o: ComposerCatalogOptions): Row[] {
  if (!o.enabled("skills") || !o.skillsCatalog) return [];
  let lines: string[];
  try { lines = o.skillsCatalog().split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/u).slice(1); } catch { return []; }
  const result: Row[] = [];
  for (const line of lines) {
    if (line === "(catalog truncated)") break;
    let item: unknown;
    try { item = pyJsonLoads(line); } catch { continue; }
    const sid = isDict(item) ? item.id : null;
    if (typeof sid !== "string" || !sid) continue;
    const output: Row = { id: sid, label: safeLabel((item as Row).name, sid) };
    const description = safeLabel((item as Row).description, "", 240);
    if (description) output.description = description;
    result.push(output);
    if (result.length >= 100) break;
  }
  return result;
}

/** `_plugin_catalog`: effective plugins with printable names. */
export function pluginCatalog(o: Pick<ComposerCatalogOptions, "plugins">): Row[] {
  let items: readonly PluginEntry[];
  try { items = o.plugins(); } catch { return []; }
  return items.map((item) => ({ id: item.id, label: safeLabel(item.name, item.id),
    ...typeof item.description === "string" && pyStrip(item.description) ? { description: safeLabel(item.description, "", 240) } : {} }));
}

/** `composer_capabilities.catalog`: every declared capability with its owner's switch. */
export const capabilityCatalog = (o: Pick<ComposerScope, "enabled">): Row[] => COMPOSER_CAPABILITIES.map((item) => ({ id: item.id, pluginId: item.pluginId, label: item.name, labelEn: item.nameEn,
  description: item.description, descriptionEn: item.descriptionEn, available: o.enabled(item.pluginId) }));

/** `_background_count`: unfinished workflows of this root (read-only). */
export function backgroundCount(o: ComposerScope, root: string): number | null {
  if (!o.enabled("workflows")) return null;
  const directory = join(realish(o.stateDir), "workflows");
  if (isLink(directory) || !stat(directory)?.isDirectory()) return 0;
  let count = 0, names: string[];
  try { names = readdirSync(directory); } catch { return 0; }
  for (const name of names) {
    if (!name.endsWith(".json") || !/^[a-f0-9]{32}$/.test(name.slice(0, -5)) || isLink(join(directory, name))) continue;
    try {
      const item = pyJsonLoads(pyDecodeUtf8(readFileSync(join(directory, name))));
      if (!isDict(item) || !["id", "status", "created_at", "updated_at", "root", "concurrency", "plan"].every((key) => Object.hasOwn(item, key)) || !isDict(item.plan) || !Object.hasOwn(item.plan, "name")) continue;
      if (["completed", "failed", "cancelled"].includes(item.status as string) || typeof item.root !== "string") continue;
      if (realish(item.root) === root) count += 1;
    } catch { continue; }
  }
  return count;
}

/** `_get_catalog`. */
export async function composerCatalog(o: ComposerCatalogOptions, root: string): Promise<Row> {
  requireEnabled(o, "sessions");
  const providersOn = o.enabled("providers");
  const roots = o.allowedRoots().map((path) => ({ path, name: basename(path) || path }));
  const response: Row = { root, roots, isolatedRoot: realish(o.webRuns), files: fileCatalog(o, root), sessions: sessionCatalog(o, root), skills: skillsCatalog(o),
    plugins: pluginCatalog(o), capabilities: capabilityCatalog(o), models: providersOn && o.models ? [...o.models().options] : [], allowReal: o.allowReal === true && providersOn };
  if (o.enabled("remote")) response.remoteConnections = remoteCatalog(o);
  const background = backgroundCount(o, root);
  if (background !== null) response.backgroundCount = background;
  if (o.enabled("git") && o.gitCatalog) {
    const git = await o.gitCatalog(root);
    if (git !== null) response.git = git;
  }
  return response;
}
