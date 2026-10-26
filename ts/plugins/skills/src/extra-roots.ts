/**
 * Additional skill directories (F07.04): the operator lists extra roots in
 * `<state>/skill-directories.json`, each scanned exactly like the built-in
 * roots and optionally carrying a directory namespace. A namespaced root's
 * skills stay reachable as `namespace:name` even when another root wins the
 * plain name, so a same-name collision never silently overrides anything.
 *
 *   { "schemaVersion": 1, "directories": [
 *       { "path": "/abs/or/relative", "namespace": "docs", "enabled": true } ] }
 *
 * `path` resolves against the state directory; links are refused at every
 * level; a broken entry is a diagnostic, never a failed listing.
 */
import { join, resolve } from "node:path";
import { isDict, isPyIntValue, pyJsonLoads } from "@xueness/contracts";
import { decodeUtf8, isDir, isLink, lexists, readBytes, real } from "./paths.ts";
import { diagnostic, type Diagnostic } from "./frontmatter.ts";

export const SKILL_DIRECTORIES_FILENAME = "skill-directories.json";
export const SKILL_DIRECTORIES_MAX_BYTES = 16 * 1024;
export const SKILL_DIRECTORIES_SCHEMA_VERSION = 1;
export const MAX_EXTRA_SKILL_ROOTS = 8;
export const NAMESPACE_MAX_CHARS = 32;
export const NAMESPACE_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
export const validNamespace = (value: unknown): value is string => typeof value === "string" && NAMESPACE_PATTERN.test(value);

export interface ExtraSkillDirectory { path: string; namespace: string | null; enabled: boolean }
export interface ExtraSkillRoots { directories: ExtraSkillDirectory[]; diagnostics: Diagnostic[]; status: "ok" | "absent" | "corrupt" }

/** The configured extra roots; absent means none, corrupt means none plus a diagnostic. */
export function loadSkillDirectories(stateDir: string): ExtraSkillRoots {
  const path = join(stateDir, SKILL_DIRECTORIES_FILENAME);
  const empty: ExtraSkillRoots = { directories: [], diagnostics: [], status: "absent" };
  if (!lexists(path)) return empty;
  const refuse = (code: string): ExtraSkillRoots => ({ directories: [], diagnostics: [diagnostic(code, "error", `${SKILL_DIRECTORIES_FILENAME} could not be read`, path)], status: "corrupt" });
  if (isLink(path)) return refuse("skill_directories_symlink");
  const read = readBytes(path, SKILL_DIRECTORIES_MAX_BYTES);
  if (read === null || read.tooLarge) return refuse("skill_directories_unreadable");
  const text = decodeUtf8(read.raw);
  if (text === null) return refuse("skill_directories_invalid_encoding");
  let document: unknown;
  try { document = pyJsonLoads(text); } catch { return refuse("skill_directories_invalid_json"); }
  if (!isDict(document) || Object.keys(document).length !== 2 || !isPyIntValue(document.schemaVersion)
    || Number(document.schemaVersion) !== SKILL_DIRECTORIES_SCHEMA_VERSION || !Array.isArray(document.directories)) return refuse("skill_directories_invalid_shape");
  const directories: ExtraSkillDirectory[] = [];
  const diagnostics: Diagnostic[] = [];
  if (document.directories.length > MAX_EXTRA_SKILL_ROOTS) {
    diagnostics.push(diagnostic("skill_directories_limit", "warning", `only the first ${MAX_EXTRA_SKILL_ROOTS} extra skill directories are read`, path));
  }
  const seen = new Set<string>();
  for (const entry of document.directories.slice(0, MAX_EXTRA_SKILL_ROOTS)) {
    if (!isDict(entry) || typeof entry.path !== "string" || !entry.path.trim()) { diagnostics.push(diagnostic("skill_directory_invalid", "error", "an extra skill directory entry needs a path", path)); continue; }
    const namespace = entry.namespace ?? null;
    if (namespace !== null && !validNamespace(namespace)) { diagnostics.push(diagnostic("skill_directory_invalid_namespace", "error", `namespace must be lowercase letters, digits and dashes, at most ${NAMESPACE_MAX_CHARS} characters: ${String(namespace)}`, path)); continue; }
    const candidate = resolve(stateDir, entry.path);
    const resolved = isLink(candidate) ? candidate : real(candidate);
    if (resolved === null) { diagnostics.push(diagnostic("skill_directory_unreadable", "warning", `extra skill directory could not be resolved: ${entry.path}`, path)); continue; }
    if (seen.has(resolved)) { diagnostics.push(diagnostic("skill_directory_duplicate", "warning", `extra skill directory listed twice: ${entry.path}`, path)); continue; }
    seen.add(resolved);
    directories.push({ path: resolved, namespace, enabled: entry.enabled !== false });
  }
  return { directories, diagnostics, status: "ok" };
}

/** The enabled, existing extra roots in listing order; each is its own jail. */
export function extraSkillRoots(stateDir: string): { base: string; namespace: string | null; jail: string; diagnostics: Diagnostic[] }[] {
  const loaded = loadSkillDirectories(stateDir);
  const diagnostics = [...loaded.diagnostics];
  const roots: { base: string; namespace: string | null; jail: string; diagnostics: Diagnostic[] }[] = [];
  for (const directory of loaded.directories) {
    if (!directory.enabled) continue;
    if (isLink(directory.path)) { diagnostics.push(diagnostic("skill_root_symlink", "error", "extra skill root must not be a link", directory.path)); continue; }
    if (!isDir(directory.path)) { diagnostics.push(diagnostic("skill_directory_unreadable", "warning", "extra skill root is not a directory", directory.path)); continue; }
    roots.push({ base: directory.path, namespace: directory.namespace, jail: directory.path, diagnostics: [] });
  }
  if (diagnostics.length) roots.unshift({ base: "", namespace: null, jail: "", diagnostics });
  return roots;
}

/** The namespaced address of a skill (`docs:pdf-tools`), or its plain name. */
export const namespacedName = (namespace: string | null, name: string): string => namespace === null ? name : `${namespace}:${name}`;
