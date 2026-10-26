/** The settings-page skill store `<state>/resources/skills/<id>.json` (Python `skills._load_items` / `resource_rows`). */
import { lstatSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDict, pyJsonLoads } from "@xueness/contracts";
import type { SkillRow } from "./discover.ts";
import { contained, isDir, isLink, readBytes, decodeUtf8, real } from "./paths.ts";
import { pyCompare, pyStrip } from "./text.ts";

type Row = Record<string, unknown>;
const MAX_RESOURCE_BYTES = 16 * 1024 * 1024;

/** Python `_safe_read_json`: a JSON object from a non-link file, or null. */
export function readResource(path: string): Row | null {
  if (isLink(path)) return null;
  const read = readBytes(path, MAX_RESOURCE_BYTES);
  if (!read || read.tooLarge) return null;
  const text = decodeUtf8(read.raw);
  if (text === null) return null;
  try { const value = pyJsonLoads(text); return isDict(value) ? value : null; } catch { return null; }
}

/** `<state>/resources/skills`, refused when the state, resources or kind directory is a link. */
export function skillsDirectory(stateDir: string): string | null {
  const resources = join(stateDir, "resources");
  if (isLink(stateDir) || isLink(resources)) return null;
  const root = real(resources);
  if (root === null) return null;
  const target = join(root, "skills");
  if (isLink(target) || !contained(target, root)) return null;
  return target;
}

export interface ResourceItem { id: string; name: string; item: Row; path: string }

/** Every usable stored skill, in id order. */
export function loadItems(stateDir: string): ResourceItem[] {
  const directory = skillsDirectory(stateDir);
  if (directory === null || !isDir(directory)) return [];
  let names: string[];
  try { names = readdirSync(directory); } catch { return []; }
  const windows = process.platform === "win32";
  const items: ResourceItem[] = [];
  for (const name of names.filter((entry) => windows ? entry.toLowerCase().endsWith(".json") : entry.endsWith(".json")).sort(pyCompare)) {
    const path = join(directory, name);
    if (isLink(path)) continue;
    const item = readResource(path);
    if (item === null) continue;
    const id = item.id; const label = item.name;
    if (typeof id !== "string" || !pyStrip(id) || typeof label !== "string" || !pyStrip(label) || item.enabled === false) continue;
    items.push({ id: pyStrip(id), name: pyStrip(label), item, path });
  }
  return items.sort((a, b) => pyCompare(a.id, b.id));
}

export function resourceRows(stateDir: string): SkillRow[] {
  return loadItems(stateDir).map(({ id, name, item, path }) => {
    let size = 0;
    try { size = lstatSync(path).size; } catch { /* Python reports 0 */ }
    return { id, name, description: typeof item.description === "string" ? pyStrip(item.description) : "", tags: [], frontmatterKeys: [],
      source: "resource", scope: "resource", namespace: null, path, directory: dirname(path), rootPath: dirname(path), bytes: size,
      attachments: [], attachmentsTruncated: false, shadowed: false, shadowedBy: null };
  });
}
