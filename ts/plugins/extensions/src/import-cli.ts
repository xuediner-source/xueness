/**
 * `xueness plugin imports | import <path> | unimport | activate | deactivate <type> <id>`: the CLI
 * face of the general package import surface. It reads the manifest (and the
 * package files the importer asks for) from disk and sends them
 * through the same HTTP dispatch the settings page uses, so type detection,
 * plugin switches and validation cannot drift between the two.
 */
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { MAX_IMPORT_FILE_BYTES, MAX_IMPORT_FOLDER_BYTES, MAX_IMPORT_FOLDER_FILES, MAX_IMPORT_MANIFEST_BYTES } from "./imports.ts";

type Row = Record<string, any>;
export type ImportApi = (method: string, path: string, data?: Row) => Promise<[number, any]>;
export interface ImportCommandArgs { path?: string | null; type?: string | null; id?: string | null; replace?: boolean; dryRun?: boolean }
export interface ImportCommandResult { code: number; output: Row }

const ROUTE = "/api/plugins/imports";
const SKIPPED_FOLDERS = new Set(["node_modules", ".git"]);
const failure = (code: string, message: string): ImportCommandResult => ({ code: 1, output: { ok: false, error: { code, message } } });
/** A manifest name is exact, or `*.ext` for any file with that ending. */
export const manifestNameMatches = (pattern: string, name: string): boolean => pattern.startsWith("*") ? name.toLowerCase().endsWith(pattern.slice(1).toLowerCase()) : name === pattern;
/** `*` matches within one path segment, `**` across segments. */
export const wantedPattern = (pattern: string): RegExp => new RegExp("^" + pattern.split("**").map(part => part.split("*").map(text => text.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")).join(".*") + "$");

/** Manifests to try for `path`: the file itself, or a folder's known manifest names in registry order. */
function candidates(path: string, names: readonly string[]): { file: string; base: string }[] {
  if (!statSync(path).isDirectory()) return [{ file: path, base: dirname(path) }];
  const entries = readdirSync(path).sort();
  const found = names.flatMap(pattern => entries.filter(entry => manifestNameMatches(pattern, entry)).slice(0, 1)).map(entry => join(path, entry));
  return [...new Set(found)].filter(file => lstatSync(file).isFile()).map(file => ({ file, base: path }));
}

function readText(file: string, limit: number): string | null {
  const stat = lstatSync(file);
  return stat.isFile() && stat.size <= limit ? readFileSync(file, "utf8") : null;
}

/** Package files the importer asked for by path, read from inside the package folder only. */
function requested(base: string, paths: readonly unknown[]): { path: string; content: string }[] {
  const files: { path: string; content: string }[] = [];
  for (const path of paths) {
    if (typeof path !== "string" || isAbsolute(path)) continue;
    const file = resolve(base, path);
    const inside = relative(base, file);
    if (!inside || inside.startsWith("..") || isAbsolute(inside) || !existsSync(file)) continue;
    const content = readText(file, MAX_IMPORT_FILE_BYTES);
    if (content !== null) files.push({ path, content });
  }
  return files;
}

/** Files under the package folder matching the importer's patterns, as base64; null when they exceed the folder limits. */
function matching(base: string, patterns: readonly string[], skip: string): { path: string; content: string; encoding: "base64" }[] | null {
  const tests = patterns.map(wantedPattern);
  // Walk only from each pattern's literal folder prefix, so `.cursor/rules/*.mdc` never scans a whole project.
  const starts = [...new Set(patterns.map(pattern => { const parts = pattern.split("/"); const literal: string[] = []; for (const part of parts.slice(0, -1)) { if (part.includes("*")) break; literal.push(part); } return literal.join("/"); }))];
  const files: { path: string; content: string; encoding: "base64" }[] = [];
  let bytes = 0, overflow = false;
  const walk = (directory: string, prefix: string, depth: number) => {
    if (overflow || depth > 8 || !existsSync(directory) || lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory()) return;
    for (const entry of readdirSync(directory).sort()) {
      const path = prefix ? `${prefix}/${entry}` : entry, full = join(directory, entry), stat = lstatSync(full);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) { if (!SKIPPED_FOLDERS.has(entry)) walk(full, path, depth + 1); continue; }
      if (!stat.isFile() || path === skip || files.some(file => file.path === path) || !tests.some(test => test.test(path))) continue;
      bytes += stat.size;
      if (files.length >= MAX_IMPORT_FOLDER_FILES || bytes > MAX_IMPORT_FOLDER_BYTES) { overflow = true; return; }
      files.push({ path, content: readFileSync(full).toString("base64"), encoding: "base64" });
    }
  };
  for (const start of starts) walk(start ? join(base, ...start.split("/")) : base, start, 0);
  return overflow ? null : files;
}

export async function importCommand(api: ImportApi, action: string, args: ImportCommandArgs): Promise<ImportCommandResult> {
  const [status, listing] = await api("GET", ROUTE);
  if (status >= 400) return failure("unavailable", String(listing?.error ?? "the import surface is unavailable"));
  if (action === "imports") return { code: 0, output: listing };
  if (action === "activate" || action === "deactivate") {
    const [, changed] = await api("POST", `${ROUTE}/${action}`, { type: args.type, id: args.id });
    return { code: changed?.ok === true ? 0 : 1, output: changed };
  }
  if (action === "unimport") {
    const [, removed] = await api("POST", `${ROUTE}/remove`, { type: args.type, id: args.id });
    return { code: removed?.ok === true ? 0 : 1, output: removed };
  }
  const path = resolve(String(args.path ?? ""));
  if (!existsSync(path)) return failure("not_found", `no such file or folder: ${path}`);
  // Unavailable types are tried too: the server then names the plugin to enable.
  const types = (listing.types as Row[]).filter(type => !args.type || type.type === args.type);
  const found = candidates(path, [...new Set(types.flatMap(type => type.manifestNames as string[]))]);
  if (!found.length) return failure("no_manifest", "the folder holds no manifest of a registered package type");
  let last: Row = {};
  for (const { file, base } of found) {
    const result = await importManifest(api, file, base, args);
    // Another manifest in the same folder may be the one a registered type recognises.
    if (result.output?.error?.code === "unknown_package_type") { last = result.output; continue; }
    return result;
  }
  return { code: 1, output: last };
}

/** Preview one manifest, send the files its importer asks for, and install it unless this is a dry run. */
async function importManifest(api: ImportApi, file: string, base: string, args: ImportCommandArgs): Promise<ImportCommandResult> {
  const manifest = readText(file, MAX_IMPORT_MANIFEST_BYTES);
  if (manifest === null) return { code: 1, output: { ok: false, error: { code: "too_large", message: `${basename(file)} is not a file of at most 256 KB` } } };
  // The nearest folder names travel with the file name: types without an id in the manifest name the package after them.
  const body: Row = { manifest, fileName: [...resolve(base).split(/[\\/]/).filter(Boolean).slice(-3), basename(file)].join("/"), ...(args.type ? { type: args.type } : {}) };
  let [, preview] = await api("POST", `${ROUTE}/preview`, body);
  if (preview?.ok !== true) return { code: 1, output: preview };
  const wanted = Array.isArray(preview.preview?.missing) ? preview.preview.missing : [];
  const patterns = Array.isArray(preview.preview?.wants) ? preview.preview.wants.filter((item: unknown) => typeof item === "string") : [];
  if (wanted.length || patterns.length) {
    const extra = patterns.length ? matching(base, patterns, basename(file)) : [];
    if (extra === null) return failure("too_large", `the package folder holds more than ${MAX_IMPORT_FOLDER_FILES} files or ${Math.floor(MAX_IMPORT_FOLDER_BYTES / 1024)} KB`);
    body.files = [...requested(base, wanted), ...extra];
    [, preview] = await api("POST", `${ROUTE}/preview`, body);
    if (preview?.ok !== true) return { code: 1, output: preview };
  }
  if (args.dryRun) return { code: preview.preview?.blocked ? 1 : 0, output: preview };
  const [, installed] = await api("POST", `${ROUTE}/install`, { ...body, type: preview.type, replace: args.replace === true });
  return { code: installed?.ok === true ? 0 : 1, output: installed };
}

/** Every `SKILL.md` under a folder, nearest first; a skill's own subfolders are not searched for more skills. */
function skillManifests(root: string): string[] {
  const found: string[] = [];
  const walk = (directory: string, depth: number) => {
    if (depth > 6 || found.length >= 64) return;
    const entries = readdirSync(directory).sort();
    if (entries.includes("SKILL.md") && lstatSync(join(directory, "SKILL.md")).isFile()) { found.push(join(directory, "SKILL.md")); return; }
    for (const entry of entries) {
      const path = join(directory, entry), stat = lstatSync(path);
      if (stat.isDirectory() && !stat.isSymbolicLink() && !SKIPPED_FOLDERS.has(entry)) walk(path, depth + 1);
    }
  };
  walk(root, 0);
  return found;
}

/**
 * `plugin import <folder> --all-skills`: import every skill folder found under a folder, for instance the checkout of a
 * plugin written for another harness. Its code is never touched; only folders with a `SKILL.md` are read.
 */
export async function importSkillsCommand(api: ImportApi, args: ImportCommandArgs): Promise<ImportCommandResult> {
  const root = resolve(String(args.path ?? ""));
  if (!existsSync(root) || !statSync(root).isDirectory()) return failure("not_found", `no such folder: ${root}`);
  const manifests = skillManifests(root);
  if (!manifests.length) return failure("no_manifest", "no folder with a SKILL.md was found");
  const imported: Row[] = [], failed: Row[] = [];
  for (const file of manifests) {
    const result = await importManifest(api, file, dirname(file), { ...args, type: "skill" });
    const path = relative(root, dirname(file)).split(/[\\/]/).join("/") || ".";
    const view = result.output?.item ?? result.output?.preview;
    if (result.code === 0) imported.push({ path, id: view?.id, files: view?.counts?.[0]?.count });
    else failed.push({ path, code: result.output?.error?.code ?? (result.output?.preview?.blocked ? "blocked" : "failed"), message: String(result.output?.error?.message ?? result.output?.preview?.notes?.[0]?.text ?? "").slice(0, 200) });
  }
  return { code: imported.length ? 0 : 1, output: { ok: imported.length > 0, dryRun: args.dryRun === true, found: manifests.length, imported, failed } };
}
