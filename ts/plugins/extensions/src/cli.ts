/**
 * The `plugins validate|update|profile` sub-actions this plugin owns
 * (Python `validate_update.validate/update` and `profiles.command`): path
 * audits read files without following links; nothing is written unless an
 * update or profile apply is explicitly asked for.
 */
import { closeSync, fstatSync, lstatSync, openSync, readdirSync, readSync, statSync, constants } from "node:fs";
import { join } from "node:path";
import { isDict, pyJsonLoadsBytes } from "@xueness/contracts";
import { pyCodeCompare } from "@xueness/sessions";
import { installPackage, marketplaceCatalog } from "./marketplace.ts";
import { apply, describe, resolve } from "./profiles.ts";
import { preview, profileState } from "./runtime.ts";
import { digest, loadManifests } from "./sdk.ts";
import { issue, validateManifestDocument, validateMarketplace, validateInline, type Issue } from "./validate.ts";

type Row = Record<string, any>;
const MAX_MANIFEST_BYTES = 256 * 1024, MAX_MARKETPLACE_BYTES = 1024 * 1024, MAX_DIRECTORY_DOCUMENTS = 200;
class Refused extends Error { code: string; constructor(code: string, message: string) { super(message); this.code = code; } }

const isLink = (path: string): boolean => { try { return lstatSync(path).isSymbolicLink(); } catch { return false; } };
const baseName = (path: string): string => path.split("/").filter(Boolean).pop() ?? path;
const suffix = (name: string): string => { const dot = name.lastIndexOf("."); return dot > 0 && dot < name.length - 1 ? name.slice(dot) : ""; };
const report = (path: string, kind: string, errors: Issue[], warnings: Issue[], items: Row[]): Row => ({ path, kind, ok: errors.length === 0, errors, warnings, items });

function readJson(path: string, limit: number): unknown {
  const name = baseName(path);
  if (isLink(path)) throw new Refused("symlink_refused", `manifest must not be a symlink: ${name}`);
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); } catch { throw new Refused("unreadable", `manifest cannot be opened: ${name}`); }
  let raw: Buffer;
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) throw new Refused("not_a_file", `manifest is not a regular file: ${name}`);
    if (info.size > limit) throw new Refused("too_large", `manifest exceeds ${limit} bytes: ${name}`);
    const chunks: Buffer[] = [];
    let size = 0;
    while (size <= limit) {
      const part = Buffer.alloc(Math.min(65536, limit + 1 - size));
      const count = readSync(fd, part, 0, part.length, null);
      if (!count) break;
      chunks.push(part.subarray(0, count));
      size += count;
    }
    if (size > limit) throw new Refused("too_large", `manifest exceeds ${limit} bytes: ${name}`);
    raw = Buffer.concat(chunks);
  } catch (error) {
    if (error instanceof Refused) throw error;
    throw new Refused("unreadable", `manifest cannot be read: ${name}`);
  } finally { closeSync(fd); }
  try { return pyJsonLoadsBytes(raw); } catch { throw new Refused("invalid_json", `manifest is not valid JSON: ${name}`); }
}

function dependencyCycles(documents: Row[]): string[] {
  const byId = new Map<unknown, Row>();
  for (const row of documents) if (isDict(row.document)) byId.set(row.document.id, row.document);
  const cycles: string[] = [];
  const visit = (rid: unknown, chain: unknown[]): void => {
    if (chain.includes(rid)) { cycles.push([...chain, rid].map(String).join(" -> ")); return; }
    const deps = byId.get(rid)?.dependencies;
    for (const dependency of Array.isArray(deps) ? deps : []) if (byId.has(dependency)) visit(dependency, [...chain, rid]);
  };
  for (const rid of byId.keys()) visit(rid, []);
  return cycles;
}

/** `validate(path)`: one manifest, one marketplace listing, or a directory of manifests. */
export function validatePath(target: string): Row {
  if (isLink(target)) return report(target, "unknown", [issue("symlink_refused", "validated path must not be a symlink")], [], []);
  let info;
  try { info = statSync(target); } catch { return report(target, "unknown", [issue("path_not_found", "nothing to validate at this path")], [], []); }
  if (info.isDirectory()) return validateDirectory(target);
  if (!info.isFile()) return report(target, "unknown", [issue("not_a_file", "validated path is neither a file nor a directory")], [], []);
  let document: unknown;
  try { document = readJson(target, MAX_MARKETPLACE_BYTES); } catch (error) { if (error instanceof Refused) return report(target, "unknown", [issue(error.code, error.message)], [], []); throw error; }
  const inline = validateInline(document);
  return { ...inline, path: target };
}

function validateDirectory(path: string): Row {
  let names: string[];
  try { names = readdirSync(path).sort(pyCodeCompare); } catch { return report(path, "unknown", [issue("unreadable", "directory cannot be listed")], [], []); }
  if (names.length > MAX_DIRECTORY_DOCUMENTS) return report(path, "unknown", [issue("too_many_entries", `directory holds more than ${MAX_DIRECTORY_DOCUMENTS} entries`)], [], []);
  if (names.includes("marketplace.json")) {
    let document: unknown;
    try { document = readJson(join(path, "marketplace.json"), MAX_MARKETPLACE_BYTES); } catch (error) { if (error instanceof Refused) return report(path, "marketplace", [issue(error.code, error.message)], [], []); throw error; }
    const [errors, warnings, items] = validateMarketplace(document);
    return report(path, "marketplace", errors, warnings, items);
  }
  const documents: Row[] = [], errors: Issue[] = [], warnings: Issue[] = [], items: Row[] = [];
  for (const name of names) {
    const entry = join(path, name);
    let directory = false;
    try { directory = statSync(entry).isDirectory(); } catch { directory = false; }
    if (suffix(name) !== ".json" || directory) continue;
    try { documents.push({ file: name, document: readJson(entry, MAX_MANIFEST_BYTES) }); }
    catch (error) { if (error instanceof Refused) errors.push(issue(error.code, error.message, name)); else throw error; }
  }
  if (!documents.length) return report(path, "directory", errors.length ? errors : [issue("nothing_to_validate", "this directory holds no JSON manifest")], [], items);
  const resolvable = new Set(documents.filter((row) => isDict(row.document)).map((row) => row.document.id));
  for (const row of documents) {
    const [rowErrors, rowWarnings, manifest] = validateManifestDocument(row.document, resolvable);
    items.push({ id: manifest ? manifest.id : null, version: manifest ? manifest.version : null, file: row.file, ok: rowErrors.length === 0, errors: rowErrors, warnings: rowWarnings });
    errors.push(...rowErrors);
    warnings.push(...rowWarnings);
  }
  for (const text of dependencyCycles(documents)) errors.push(issue("dependency_cycle", "cyclic manifest dependencies: " + text));
  return report(path, "directory", errors, warnings, items);
}

function version(text: unknown): number[] {
  return String(text).split(".").map((part) => {
    if (!/^\s*[-+]?\d+\s*$/.test(part)) throw new Error("invalid version");
    return Number.parseInt(part, 10);
  });
}
const newerThan = (left: number[], right: number[]): boolean => {
  for (let i = 0; i < Math.min(left.length, right.length); i += 1) if (left[i] !== right[i]) return left[i]! > right[i]!;
  return left.length > right.length;
};

/** `update(state, id | --all, dry_run)`: upgrade installed data manifests the marketplace lists newer. */
export function updatePackages(stateDir: string, pluginId: string | null, all: boolean, dryRun: boolean): Row {
  if (Boolean(pluginId) === all) throw new Error("exactly one plugin id or --all is required");
  let rows: Row[];
  try { rows = marketplaceCatalog(stateDir); } catch { throw new Error("marketplace catalog is unavailable or invalid"); }
  const byId = new Map(rows.map((row) => [row.id, row]));
  const installed = new Map(loadManifests(stateDir).map((row) => [row.id, row]));
  const result: Row = { ok: true, dryRun, updated: [], skipped: [], errors: [] };
  for (const rid of all ? [...installed.keys()].sort(pyCodeCompare) : [pluginId!]) {
    if (!all && !installed.has(rid)) { result.errors.push(issue("not_installed", "no installed manifest with this id; install it first", rid)); continue; }
    const row = byId.get(rid);
    if (!row) {
      if (all) result.skipped.push({ id: rid, reason: "not in the marketplace catalog" });
      else result.errors.push(issue("not_in_catalog", "the marketplace no longer lists this package", rid));
      continue;
    }
    const [errors] = validateManifestDocument(row.manifest);
    if (row.sha256 !== digest(row.manifest)) errors.push(issue("digest_mismatch", "catalog digest no longer matches the offered manifest", rid));
    if (errors.length) { result.errors.push(...errors); continue; }
    let newer: boolean;
    try { newer = newerThan(version(row.version), version(installed.get(rid)!.version)); }
    catch { result.errors.push(issue("invalid_version", "installed version cannot be compared", rid)); continue; }
    if (!newer) { result.skipped.push({ id: rid, reason: "already at the newest listed version" }); continue; }
    const planned = { id: rid, fromVersion: installed.get(rid)!.version, toVersion: row.version, sha256: row.sha256 };
    if (!dryRun) {
      try { installPackage(stateDir, rid, row.sha256, true); }
      catch (error) { result.errors.push(issue("update_refused", error instanceof Error ? error.message : String(error), rid)); continue; }
    }
    result.updated.push(planned);
  }
  result.ok = result.errors.length === 0;
  return result;
}

/** `profiles.command`: list, show (with the catalog it would produce) or apply a composition profile. */
export function profileCommand(stateDir: string, action: string, name: string | null, dryRun: boolean): Row {
  if (action === "list") return { ok: true, active: profileState(stateDir).name, profiles: describe(stateDir) };
  if (action === "show") {
    const resolved = resolve(stateDir, name);
    return { ok: true, profile: resolved.name, source: resolved.source, extends: resolved.chain.slice(1), plugins: resolved.plugins,
      catalog: preview(stateDir, resolved.plugins).map(({ id, enabled, effective, blockedBy }) => ({ id, enabled, effective, blockedBy })) };
  }
  if (action === "apply") return apply(stateDir, String(name), dryRun);
  throw new Error("unsupported profile action: " + action);
}
