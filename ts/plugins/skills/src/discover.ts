/**
 * Directory-shaped skills (`<name>/SKILL.md`), Python `file_skills`: roots,
 * scanning, attachments (names and sizes only), merge with the resource store
 * and exact lookup. Highest precedence first:
 *
 *   <workspace>/.xueness/skills   project
 *   <workspace>/.zcode/skills     project-compat
 *   <state>/skills                user
 *   <skill-directories.json>      extra (F07.04: operator-listed roots, each
 *                                  its own jail, optionally namespaced so a
 *                                  same-name skill stays reachable as
 *                                  `namespace:name` instead of being silently
 *                                  overridden)
 *   <state>/resources/skills      resource (resources.ts)
 *   <plugin>/bundled              bundled (TS only: documentation, visualization,
 *                                  and Seagull research skills shipped with app; Python has no such source)
 */
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { extraSkillRoots, namespacedName } from "./extra-roots.ts";
import { diagnostic, parseFrontmatter, stripFrontmatter, validateFrontmatter, type Diagnostic, type SkillMeta } from "./frontmatter.ts";
import { contained, isDir, isFile, isLink, readText, real } from "./paths.ts";
import { pyCompare, pyStrip } from "./text.ts";

export const SKILL_FILE_NAME = "SKILL.md";
export const MAX_SKILL_FILE_BYTES = 256 * 1024;
export const MAX_SKILLS_PER_ROOT = 128;
const MAX_ATTACHMENTS_PER_SKILL = 32;
const SOURCE_PRIORITY: Record<string, number> = { project: 0, "project-compat": 1, user: 2, extra: 3, resource: 4, bundled: 5 };
const SCOPE_BY_SOURCE: Record<string, string> = { project: "project", "project-compat": "project", user: "user", extra: "extra", resource: "resource", bundled: "bundled" };

export type Source = "project" | "project-compat" | "user" | "extra" | "resource" | "bundled";
export interface SkillRow {
  id: string; name: string; description: string; tags: string[]; frontmatterKeys: string[];
  source: Source; scope: string; namespace: string | null; path: string; directory: string; rootPath: string; bytes: number;
  attachments: { name: string; bytes: number }[]; attachmentsTruncated: boolean;
  shadowed: boolean; shadowedBy: string | null;
  enabled?: boolean;
}

export function skillRoots(stateDir: string, root: string | null, includeCompat = true): [Source, string, string][] {
  const items: [Source, string, string][] = [];
  const jail = real(stateDir);
  if (root !== null) {
    const workspace = real(root);
    if (workspace !== null) {
      items.push(["project", join(workspace, ".xueness", "skills"), workspace]);
      if (includeCompat) items.push(["project-compat", join(workspace, ".zcode", "skills"), workspace]);
    }
  }
  if (jail !== null && !isLink(stateDir)) items.push(["user", join(jail, "skills"), jail]);
  return items;
}

/** Child names sorted as Python sorts `Path.iterdir()` by name. */
export function sortedChildren(directory: string): string[] | null {
  try { return readdirSync(directory).sort(pyCompare); } catch { return null; }
}

function attachments(directory: string, jail: string): [SkillRow["attachments"], boolean] {
  const items: SkillRow["attachments"] = [];
  for (const name of sortedChildren(directory) ?? []) {
    if (name === SKILL_FILE_NAME || name.startsWith(".")) continue;
    const entry = join(directory, name);
    if (isLink(entry)) continue;
    let size: number;
    try {
      if (!isFile(entry) || !contained(real(entry) ?? entry, jail)) continue;
      size = lstatSync(entry).size;
    } catch { continue; }
    if (items.length >= MAX_ATTACHMENTS_PER_SKILL) return [items, true];
    items.push({ name, bytes: size });
  }
  return [items, false];
}

function row(source: Source, directory: string, base: string, meta: SkillMeta, size: number, files: SkillRow["attachments"], truncated: boolean, namespace: string | null): SkillRow {
  const name = namespacedName(namespace, meta.name);
  return { id: `file:${source}:${name}`, name, description: meta.description, tags: meta.tags, frontmatterKeys: meta.keys,
    source, scope: SCOPE_BY_SOURCE[source] ?? "user", namespace, path: join(directory, SKILL_FILE_NAME), directory, rootPath: base, bytes: size,
    attachments: files, attachmentsTruncated: truncated, shadowed: false, shadowedBy: null };
}

function readEntry(source: Source, base: string, jail: string, directory: string, name: string, namespace: string | null): { row: SkillRow; issue: null } | { row: null; issue: Diagnostic } {
  const path = join(directory, SKILL_FILE_NAME);
  if (isLink(path)) return { row: null, issue: diagnostic("skill_file_symlink", "warning", `SKILL.md must not be a link: ${name}`, path) };
  const resolved = real(path);
  if (resolved === null || !contained(resolved, base)) return { row: null, issue: diagnostic("skill_escapes_root", "error", `skill path leaves its skill root: ${name}`, path) };
  const { text, size, failure } = readText(path, MAX_SKILL_FILE_BYTES);
  if (failure || text === null) {
    const detail = failure === "skill_file_too_large" && size ? ` (${size} bytes)` : "";
    return { row: null, issue: diagnostic(failure ?? "skill_unreadable", "error", `SKILL.md could not be read as text${detail}: ${name}`, path) };
  }
  const parsed = parseFrontmatter(text);
  if (parsed.error) return { row: null, issue: diagnostic(parsed.error, "error", `SKILL.md frontmatter is unusable: ${name}`, path) };
  const checked = validateFrontmatter(parsed.values, parsed.keys, path);
  if (!checked.meta) return { row: null, issue: checked.issue };
  const [files, truncated] = attachments(directory, jail);
  return { row: row(source, directory, base, checked.meta, size ?? 0, files, truncated, namespace), issue: null };
}

function scanRoot(source: Source, base: string, jail: string, diagnostics: Diagnostic[], limit: number, namespace: string | null): SkillRow[] {
  if (isLink(base)) { diagnostics.push(diagnostic("skill_root_symlink", "error", "skill root must not be a link", base)); return []; }
  const resolved = real(base);
  if (resolved === null) { diagnostics.push(diagnostic("skill_root_unreadable", "warning", "skill root could not be resolved", base)); return []; }
  if (!contained(resolved, jail)) { diagnostics.push(diagnostic("skill_root_escapes", "error", "skill root resolves outside its workspace", base)); return []; }
  if (!isDir(base)) return [];
  const candidates = sortedChildren(base);
  if (candidates === null) { diagnostics.push(diagnostic("skill_root_unreadable", "warning", "skill root could not be listed", base)); return []; }
  const rows: SkillRow[] = [];
  for (const name of candidates) {
    if (name.startsWith(".")) continue;
    const directory = join(base, name);
    if (isLink(directory)) { diagnostics.push(diagnostic("skill_directory_symlink", "warning", `skill directory must not be a link: ${name}`, directory)); continue; }
    if (!isDir(directory)) continue;
    const entry = readEntry(source, resolved, jail, directory, name, namespace);
    if (entry.issue) { diagnostics.push(entry.issue); continue; }
    if (rows.length >= limit) { diagnostics.push(diagnostic("skill_root_limit", "warning", `only the first ${limit} skills are read from this root`, base)); break; }
    rows.push(entry.row);
  }
  return rows;
}

/** `bundled`: the app's own skill directory, scanned last and jailed to itself; null (Python parity) skips it. */
export function discover(stateDir: string, root: string | null, includeCompat = true, limit = MAX_SKILLS_PER_ROOT, bundled: string | null = null): { skills: SkillRow[]; diagnostics: Diagnostic[] } {
  const skills: SkillRow[] = [];
  const diagnostics: Diagnostic[] = [];
  const roots = skillRoots(stateDir, root, includeCompat);
  for (const [source, base, jail] of roots) skills.push(...scanRoot(source, base, jail, diagnostics, limit, null));
  // F07.04: operator-listed extra directories, each its own jail, before the shipped ones.
  for (const extra of extraSkillRoots(stateDir)) {
    if (extra.base === "") { diagnostics.push(...extra.diagnostics); continue; }
    skills.push(...scanRoot("extra", extra.base, extra.jail, diagnostics, limit, extra.namespace));
  }
  const shipped = bundled === null ? null : real(bundled);
  if (shipped !== null) skills.push(...scanRoot("bundled", shipped, shipped, diagnostics, limit, null));
  return { skills, diagnostics };
}

const lower = (value: unknown): string => String(value || "").toLowerCase();
function claimKeys(item: SkillRow): string[] {
  const keys = [lower(item.name)];
  if (item.source === "resource") keys.push(lower(item.id));
  return [...new Set(keys)].filter((key) => key);
}
function compareRows(a: SkillRow, b: SkillRow): number {
  return pyCompare(lower(a.name), lower(b.name)) || (SOURCE_PRIORITY[a.source] ?? 9) - (SOURCE_PRIORITY[b.source] ?? 9) || pyCompare(String(a.id), String(b.id));
}

/** Both families, name collisions resolved by precedence (Python `merge`). */
export function merge(resourceRows: readonly SkillRow[], fileRows: readonly SkillRow[]): SkillRow[] {
  const claimed = new Map<string, string>();
  const rows: SkillRow[] = [];
  for (const item of [...fileRows, ...resourceRows].sort(compareRows)) {
    const winner = claimKeys(item).map((key) => claimed.get(key)).find((value) => value !== undefined);
    if (winner !== undefined) { rows.push({ ...item, shadowed: true, shadowedBy: winner }); continue; }
    for (const key of claimKeys(item)) claimed.set(key, item.source);
    rows.push(item);
  }
  return rows;
}

/** The winning row whose id or name equals `key` exactly; never a path or a glob. */
export function find(rows: readonly SkillRow[], key: unknown): SkillRow | null {
  if (typeof key !== "string" || !key) return null;
  return rows.find((item) => !item.shadowed && item.enabled !== false && (key === item.id || key === item.name)) ?? null;
}

/** Re-check the jail at read time, then the SKILL.md body without its frontmatter. */
export function readBody(item: Pick<SkillRow, "path" | "rootPath">, max = MAX_SKILL_FILE_BYTES): { ok: true; content: string; size: number } | { ok: false; error: string } {
  const path = String(item.path || "");
  const base = String(item.rootPath || "");
  if (isLink(path)) return { ok: false, error: "SKILL.md must not be a link" };
  const resolved = real(path);
  const jail = real(base);
  if (resolved === null || jail === null || !contained(resolved, jail)) return { ok: false, error: "skill path leaves its skill root" };
  const { text, size, failure } = readText(path, max);
  if (failure || text === null) return { ok: false, error: `SKILL.md could not be read (${failure ?? "skill_unreadable"})` };
  return { ok: true, content: pyStrip(stripFrontmatter(text)), size: size ?? 0 };
}
