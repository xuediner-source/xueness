/**
 * Additional command directories (F07.04): the operator lists extra roots in
 * `<state>/command-directories.json`, each scanned exactly like the built-in
 * roots. A root configured with a namespace prefixes every command it holds
 * (`namespace:name`), so a same-name command from another root never silently
 * overrides anything — the loser stays listed as shadowed, and the namespaced
 * address stays exclusively this root's.
 *
 *   { "schemaVersion": 1, "directories": [
 *       { "path": "/abs/or/relative", "namespace": "docs", "enabled": true } ] }
 *
 * `path` resolves against the state directory; links are refused at every
 * level; a broken entry is a diagnostic, never a failed listing.
 */
import { lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import { isDict, isPyIntValue, pyJsonLoads } from "@xueness/contracts";
import { decodeUtf8, isDir, isLink, readBytes, real } from "./paths.ts";
import { diagnostic, type Diagnostic } from "./file-commands.ts";

export const COMMAND_DIRECTORIES_FILENAME = "command-directories.json";
export const COMMAND_DIRECTORIES_MAX_BYTES = 16 * 1024;
export const COMMAND_DIRECTORIES_SCHEMA_VERSION = 1;
export const MAX_EXTRA_COMMAND_ROOTS = 8;
export const NAMESPACE_MAX_CHARS = 32;
export const NAMESPACE_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
export const validNamespace = (value: unknown): value is string => typeof value === "string" && NAMESPACE_PATTERN.test(value);

export interface ExtraCommandDirectory { path: string; namespace: string | null; enabled: boolean }
export interface ExtraCommandRoots { directories: ExtraCommandDirectory[]; diagnostics: Diagnostic[]; status: "ok" | "absent" | "corrupt" }

/** The configured extra roots; absent means none, corrupt means none plus a diagnostic. */
export function loadCommandDirectories(stateDir: string): ExtraCommandRoots {
  const path = join(stateDir, COMMAND_DIRECTORIES_FILENAME);
  const empty: ExtraCommandRoots = { directories: [], diagnostics: [], status: "absent" };
  let stat: ReturnType<typeof lstatSync>;
  try { stat = lstatSync(path); } catch { return empty; }
  if (stat.isSymbolicLink()) return refuse("command_directories_symlink", path);
  const read = readBytes(path, COMMAND_DIRECTORIES_MAX_BYTES);
  if (read === null || read.tooLarge) return refuse("command_directories_unreadable", path);
  const text = decodeUtf8(read.raw);
  if (text === null) return refuse("command_directories_invalid_encoding", path);
  let document: unknown;
  try { document = pyJsonLoads(text); } catch { return refuse("command_directories_invalid_json", path); }
  if (!isDict(document) || Object.keys(document).length !== 2 || !isPyIntValue(document.schemaVersion)
    || Number(document.schemaVersion) !== COMMAND_DIRECTORIES_SCHEMA_VERSION || !Array.isArray(document.directories)) return refuse("command_directories_invalid_shape", path);
  const directories: ExtraCommandDirectory[] = [];
  const diagnostics: Diagnostic[] = [];
  if (document.directories.length > MAX_EXTRA_COMMAND_ROOTS) {
    diagnostics.push(diagnostic("command_directories_limit", "warning", `only the first ${MAX_EXTRA_COMMAND_ROOTS} extra command directories are read`, path));
  }
  const seen = new Set<string>();
  for (const entry of document.directories.slice(0, MAX_EXTRA_COMMAND_ROOTS)) {
    if (!isDict(entry) || typeof entry.path !== "string" || !entry.path.trim()) { diagnostics.push(diagnostic("command_directory_invalid", "error", "an extra command directory entry needs a path", path)); continue; }
    const namespace = entry.namespace ?? null;
    if (namespace !== null && !validNamespace(namespace)) { diagnostics.push(diagnostic("command_directory_invalid_namespace", "error", `namespace must be lowercase letters, digits and dashes, at most ${NAMESPACE_MAX_CHARS} characters: ${String(namespace)}`, path)); continue; }
    const candidate = resolve(stateDir, entry.path);
    const resolved = isLink(candidate) ? candidate : real(candidate);
    if (resolved === null) { diagnostics.push(diagnostic("command_directory_unreadable", "warning", `extra command directory could not be resolved: ${entry.path}`, path)); continue; }
    if (seen.has(resolved)) { diagnostics.push(diagnostic("command_directory_duplicate", "warning", `extra command directory listed twice: ${entry.path}`, path)); continue; }
    seen.add(resolved);
    directories.push({ path: resolved, namespace, enabled: entry.enabled !== false });
  }
  return { directories, diagnostics, status: "ok" };
}

function refuse(code: string, path: string): ExtraCommandRoots {
  return { directories: [], diagnostics: [diagnostic(code, "error", `${COMMAND_DIRECTORIES_FILENAME} could not be read`, path)], status: "corrupt" };
}

/** The enabled, existing extra roots in listing order; each is its own jail. */
export function extraCommandRoots(stateDir: string): { base: string; namespace: string | null; jail: string; diagnostics: Diagnostic[] }[] {
  const loaded = loadCommandDirectories(stateDir);
  const diagnostics = [...loaded.diagnostics];
  const roots: { base: string; namespace: string | null; jail: string; diagnostics: Diagnostic[] }[] = [];
  for (const directory of loaded.directories) {
    if (!directory.enabled) continue;
    if (isLink(directory.path)) { diagnostics.push(diagnostic("command_root_symlink", "error", "extra command root must not be a link", directory.path)); continue; }
    if (!isDir(directory.path)) { diagnostics.push(diagnostic("command_directory_unreadable", "warning", "extra command root is not a directory", directory.path)); continue; }
    roots.push({ base: directory.path, namespace: directory.namespace, jail: directory.path, diagnostics: [] });
  }
  if (diagnostics.length) roots.unshift({ base: "", namespace: null, jail: "", diagnostics });
  return roots;
}

/** The namespaced invocation name of a command (`docs:review`), or its plain name. */
export const namespacedCommandName = (namespace: string | null, name: string): string => namespace === null ? name : `${namespace}:${name}`;
