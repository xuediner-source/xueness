/**
 * The kernel resource repository (Python `resources.py`): one private JSON
 * document per item at `<state>/resources/<kind>/<id>.json`. Reads refuse
 * links and never echo a foreign file; writes are atomic private replacements;
 * the HTTP answers (`GET/POST/PUT /api/resources/<kind>`,
 * `PATCH/DELETE /api/resources/<kind>/<id>`) are Python's, word for word.
 */
import { closeSync, constants, fsyncSync, mkdirSync, openSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDict, pyDecodeUtf8, pyEncodeUtf8, pyJsonDumps, pyJsonLoads, pyRepr, pyStr, pyUtcNow, PyValueError, setOwn } from "@xueness/contracts";
import { isPyOSError, pyOSErrorText, pyStrerror } from "./errors.ts";
import { exists, fsyncDirectory, isFile, isLink, mkstemp, protectPrivateFile, readAll, replaceFile, writeAll } from "./journal-fs.ts";
import { realish } from "./realish.ts";

export const RESOURCE_KINDS: readonly string[] = ["skills", "commands", "hooks", "mcp", "subagents", "plugins"];
// Python `re.match("^...$")`: `$` also matches before one trailing newline.
const ID_PATTERN = /^[A-Za-z0-9._-]{1,64}\n?$/;
type Row = Record<string, unknown>;
export type ResourceReply = [number, Row];

/** Python code point ordering for `sorted()` keys. */
export function pyCodeCompare(a: string, b: string): number {
  const left = Array.from(a, (c) => c.codePointAt(0)!), right = Array.from(b, (c) => c.codePointAt(0)!);
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) if (left[index] !== right[index]) return left[index]! - right[index]!;
  return left.length - right.length;
}

/** `_valid_id`: a usable file stem, never `.`/`..`, never a path. */
export function validResourceId(value: unknown): value is string {
  if (typeof value !== "string" || value === "" || value === "." || value === "..") return false;
  if (value.includes("..") || value.includes("/") || value.includes("\\")) return false;
  return ID_PATTERN.test(value);
}

/** `_kind_dir`: `<resolved state/resources>/<kind>`, refusing links at every owned level. */
export function resourceKindDir(stateDir: string, kind: string): string {
  const root = join(stateDir, "resources");
  if (isLink(stateDir) || isLink(root)) throw new PyValueError("resource root must not be a link or reparse point");
  const resolved = realish(root);
  if (!RESOURCE_KINDS.includes(kind)) throw new PyValueError("unknown kind");
  const target = join(resolved, kind);
  if (isLink(target)) throw new PyValueError("resource kind must not be a link or reparse point");
  return target;
}

function itemPath(stateDir: string, kind: string, rid: string): string {
  const path = join(resourceKindDir(stateDir, kind), rid + ".json");
  if (isLink(path)) throw new PyValueError("resource id must not be a symlink");
  return path;
}

/** `sorted(directory.glob("*.json"))` names (pathlib matches dot files too); an unreadable directory lists nothing. */
export function jsonEntries(directory: string): string[] {
  try { return readdirSync(directory).filter((name) => name.endsWith(".json")).sort(pyCodeCompare); } catch { return []; }
}

/** `_safe_read_json`/`_load_item`: one JSON object read without following a link, or `null`. */
export function readJsonObject(path: string): Row | null {
  if (isLink(path)) return null;
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); } catch { return null; }
  try {
    const value = pyJsonLoads(pyDecodeUtf8(readAll(fd)), { lossless: true });
    return isDict(value) ? value : null;
  } catch { return null; } finally { closeSync(fd); }
}

function loadItem(path: string): Row | null {
  const item = readJsonObject(path);
  return item && Object.hasOwn(item, "id") ? item : null;
}

const isDirectory = (path: string): boolean => { try { return statSync(path).isDirectory(); } catch { return false; } };

/** `_atomic_write_json`: a private temporary beside the target, fsynced and renamed into place. */
export function atomicWriteJson(path: string, item: Row): void {
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true });
  const temp = mkstemp(parent, ".resource-");
  try {
    try { protectPrivateFile(temp.fd); writeAll(temp.fd, pyEncodeUtf8(pyJsonDumps(item, { ensureAscii: false, indent: 2 }))); fsyncSync(temp.fd); } finally { closeSync(temp.fd); }
    replaceFile(temp.path, path);
  } finally {
    if (exists(temp.path)) unlinkSync(temp.path);
  }
  try { fsyncDirectory(parent); } catch { /* Python ignores a directory fsync failure. */ }
}

const persistFailure = (error: unknown): ResourceReply => [400, { error: "could not persist resource: " + (pyStrerror(error) ?? pyOSErrorText(error)) }];
const own = (data: Row, key: string): unknown => Object.hasOwn(data, key) ? data[key] : null;

function list(stateDir: string, kind: string): Row[] {
  const directory = resourceKindDir(stateDir, kind);
  if (!isDirectory(directory)) return [];
  const items: Row[] = [];
  for (const name of jsonEntries(directory)) {
    const path = join(directory, name);
    if (isLink(path)) continue;
    const item = loadItem(path);
    if (item !== null) items.push(item);
  }
  return items.sort((a, b) => pyCodeCompare(pyStr(a.id), pyStr(b.id)));
}

function post(stateDir: string, kind: string, data: Row): ResourceReply {
  const rid = own(data, "id");
  if (!validResourceId(rid)) return [400, { error: "invalid resource id" }];
  const createOnly = Object.hasOwn(data, "createOnly") ? data.createOnly : false;
  if (typeof createOnly !== "boolean") return [400, { error: "createOnly must be a boolean" }];
  let path: string;
  try { path = itemPath(stateDir, kind, rid); } catch (error) { if (error instanceof PyValueError) return [400, { error: "invalid resource id" }]; throw error; }
  const now = pyUtcNow();
  if (createOnly && exists(path)) return [409, { error: `resource already exists: ${rid}` }];
  const existing = exists(path) ? loadItem(path) : null;
  const item: Row = { id: rid, createdAt: existing && typeof existing.createdAt === "string" ? existing.createdAt : now, updatedAt: now };
  for (const [key, value] of Object.entries(data)) if (!["id", "createdAt", "updatedAt", "createOnly"].includes(key)) setOwn(item, key, value);
  try { atomicWriteJson(path, item); } catch (error) { if (isPyOSError(error)) return persistFailure(error); throw error; }
  return [200, { item }];
}

function patch(stateDir: string, kind: string, rid: string, data: Row): ResourceReply {
  if (!validResourceId(rid)) return [400, { error: "invalid resource id" }];
  if (Object.hasOwn(data, "id") && data.id !== rid) return [400, { error: "id in body must match the path" }];
  let path: string;
  try { path = itemPath(stateDir, kind, rid); } catch (error) { if (error instanceof PyValueError) return [400, { error: "invalid resource id" }]; throw error; }
  const existing = exists(path) ? loadItem(path) : null;
  if (existing === null) return [404, { error: `resource not found: ${rid}` }];
  const item: Row = { ...existing };
  for (const [key, value] of Object.entries(data)) if (!["id", "createdAt", "updatedAt"].includes(key)) setOwn(item, key, value);
  setOwn(item, "id", rid);
  setOwn(item, "createdAt", Object.hasOwn(existing, "createdAt") ? existing.createdAt : pyUtcNow());
  setOwn(item, "updatedAt", pyUtcNow());
  try { atomicWriteJson(path, item); } catch (error) { if (isPyOSError(error)) return persistFailure(error); throw error; }
  return [200, { item }];
}

function put(stateDir: string, kind: string, data: Row): ResourceReply {
  const items = own(data, "items");
  if (!Array.isArray(items)) return [400, { error: "items must be an array" }];
  const seen = new Set<string>(), planned: [string, Row][] = [];
  for (const item of items) {
    if (!isDict(item)) return [400, { error: "each item must be a JSON object" }];
    const rid = own(item, "id");
    if (!validResourceId(rid)) return [400, { error: `invalid resource id: ${pyRepr(rid)}` }];
    if (seen.has(rid)) return [400, { error: `duplicate resource id: ${rid}` }];
    seen.add(rid); planned.push([rid, item]);
  }
  const now = pyUtcNow();
  let directory: string;
  try { directory = resourceKindDir(stateDir, kind); } catch (error) { if (error instanceof PyValueError) return [400, { error: error.message }]; throw error; }
  const written: Row[] = [];
  for (const [rid, item] of planned) {
    let path: string;
    try { path = itemPath(stateDir, kind, rid); } catch (error) { if (error instanceof PyValueError) return [400, { error: error.message }]; throw error; }
    const existing = exists(path) ? loadItem(path) : null;
    const record: Row = {};
    for (const [key, value] of Object.entries(item)) if (key !== "createdAt" && key !== "updatedAt") setOwn(record, key, value);
    setOwn(record, "id", rid);
    setOwn(record, "createdAt", existing && typeof existing.createdAt === "string" ? existing.createdAt : now);
    setOwn(record, "updatedAt", now);
    try { atomicWriteJson(path, record); } catch (error) { if (isPyOSError(error)) return persistFailure(error); throw error; }
    written.push(record);
  }
  if (isDirectory(directory)) {
    for (const name of jsonEntries(directory)) {
      const entry = join(directory, name);
      if (isLink(entry) || !isFile(entry)) continue;
      if (seen.has(name.length > 5 ? name.slice(0, -5) : name)) continue;
      try { unlinkSync(entry); } catch { /* Python leaves an undeletable stale item in place. */ }
    }
  }
  return [200, { items: written.sort((a, b) => pyCodeCompare(pyStr(a.id), pyStr(b.id))) }];
}

function remove(stateDir: string, kind: string, rid: string): ResourceReply {
  if (!validResourceId(rid)) return [400, { error: "invalid resource id" }];
  let path: string;
  try { path = itemPath(stateDir, kind, rid); } catch (error) { if (error instanceof PyValueError) return [400, { error: "invalid resource id" }]; throw error; }
  if (!exists(path) || isLink(path) || !isFile(path)) return [404, { error: `resource not found: ${rid}` }];
  try { unlinkSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [404, { error: `resource not found: ${rid}` }];
    if (isPyOSError(error)) return [400, { error: `resource not deletable: ${rid}` }];
    throw error;
  }
  return [200, { ok: true, id: rid }];
}

/** Python `resources.dispatch` for `/api/resources/<kind>[/<id>]`; `null` where Python falls through. */
export function resourceDispatch(stateDir: string, method: string, parts: readonly string[], data: unknown): ResourceReply | null {
  if (parts.length < 3 || parts[0] !== "api" || parts[1] !== "resources") return null;
  const kind = parts[2]!;
  if (!RESOURCE_KINDS.includes(kind)) return [404, { error: `unknown resource kind: ${kind}` }];
  const verb = method.toUpperCase();
  const body = (): Row | null => isDict(data) ? data : null;
  try {
    if (verb === "GET") return parts.length === 3 ? [200, { items: list(stateDir, kind), capability: { userScopeAvailable: true } }] : null;
    if (verb === "POST" && parts.length === 3) return body() ? post(stateDir, kind, body()!) : [400, { error: "request body must be a JSON object" }];
    if (verb === "PATCH" && parts.length === 4) return body() ? patch(stateDir, kind, parts[3]!, body()!) : [400, { error: "request body must be a JSON object" }];
    if (verb === "PUT" && parts.length === 3) return body() ? put(stateDir, kind, body()!) : [400, { error: "request body must be a JSON object" }];
    if (verb === "DELETE" && parts.length === 4) return remove(stateDir, kind, parts[3]!);
  } catch (error) {
    if (error instanceof PyValueError) return [400, { error: error.message }];
    throw error;
  }
  return null;
}
