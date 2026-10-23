/**
 * Memory HTTP surface (Python `bundled_plugins/memory` `plugin.dispatch`).
 *
 *   GET  /api/memory/tracks              metadata only; empty when the root is unset
 *   GET  /api/memory/workspaces          one entry per root that has a real track file
 *   GET  /api/memory/tracks/<name>       text plus sha256, optional `root` query
 *   POST /api/memory/tracks/<name>       confirmed write, optimistic digest
 *
 * Other methods on a track editor path are 405. A disabled plugin is 403 before
 * any of that work. Paths and errors match the Python modules, including the
 * generic editor failure string.
 */
import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { pyDecodeUtf8, pyEncodeUtf8, pyLen, PyUnicodeDecodeError, PyUnicodeEncodeError, pyStrip } from "@xueness/contracts";
import { isRelativeTo, pyResolve, TRACK_NAMES, trackPaths, type TrackName } from "./memory.ts";

const MEMORY_ROOT_ENV = "XUENESS_MEMORY_ROOT";
const MAX_BYTES = 100_000;
const TRACK_ERROR = "memory track unavailable or invalid";
export const MEMORY_HTTP_ROUTES = ["GET /api/memory/tracks", "GET /api/memory/workspaces", "GET /api/memory/tracks/:name", "POST /api/memory/tracks/:name"] as const;
type Reply = [number, unknown];
interface TrackEntry { name: TrackName; path: string; bytes: number; present: boolean }

export interface MemoryHttpOptions {
  /** Host plugin-state directory. Writes stay in-process; Python's advisory `.plugin-state.lock` is not taken. */
  stateDir: string;
  enabled(id: string): boolean;
  projectDir: string;
  workspaceRoots?: readonly string[];
  selectedRoots?: () => readonly string[];
  sessionRoots?: () => readonly string[];
  env?: NodeJS.ProcessEnv;
}

class TrackInvalid extends Error {}
class DigestMismatch extends Error {}

/** Python `str` order: Unicode code points, not UTF-16 code units. */
function codePointCompare(left: string, right: string): number {
  const a = Array.from(left);
  const b = Array.from(right);
  const count = Math.min(a.length, b.length);
  for (let index = 0; index < count; index += 1) {
    const delta = a[index]!.codePointAt(0)! - b[index]!.codePointAt(0)!;
    if (delta) return delta;
  }
  return a.length - b.length;
}

function memoryRoot(env: NodeJS.ProcessEnv): string | null {
  const raw = env[MEMORY_ROOT_ENV];
  if (raw === undefined) return null;
  const stripped = pyStrip(raw);
  return stripped ? stripped : null;
}

function isTrack(name: string): name is TrackName {
  return (TRACK_NAMES as readonly string[]).includes(name);
}

function isOsError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" && (/^E[A-Z0-9]+$/.test(code) || code === "UNKNOWN");
}

/** `Path.is_symlink`: missing and ENOTDIR are false; other OS errors propagate. */
function isLink(path: string): boolean {
  try { return lstatSync(path).isSymbolicLink(); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }
}

function parents(path: string): string[] {
  const chain: string[] = [];
  let current = dirname(path);
  while (chain.length < 64) {
    chain.push(current);
    const next = dirname(current);
    if (next === current) return chain;
    current = next;
  }
  return chain;
}

/** `catalog.workspace_roots`: resolved project, declared roots, selected roots, session roots. */
function workspaceIds(options: MemoryHttpOptions): string[] {
  const ids = new Set<string>();
  ids.add(pyResolve(options.projectDir));
  for (const root of options.workspaceRoots ?? []) ids.add(pyResolve(root));
  for (const root of options.selectedRoots?.() ?? []) ids.add(pyResolve(root));
  for (const root of options.sessionRoots?.() ?? []) ids.add(pyResolve(root));
  return [...ids].sort(codePointCompare);
}

/** `catalog.scoped_context`. `root` may be the one-element list `parse_qs` produces. */
function scopedCwd(query: Record<string, unknown>, options: MemoryHttpOptions): string | undefined {
  if (!Object.hasOwn(query, "root")) return undefined;
  let root = query.root;
  if (Array.isArray(root)) {
    if (root.length !== 1) throw new TrackInvalid("invalid memory workspace");
    root = root[0];
  }
  if (root == null) return undefined;
  if (typeof root !== "string" || pyLen(root) > 4096 || root.includes("\0")) throw new TrackInvalid("invalid memory workspace");
  const canonical = pyResolve(root);
  if (!workspaceIds(options).includes(canonical)) throw new TrackInvalid("unknown memory workspace");
  return canonical;
}

function cwdOf(options: MemoryHttpOptions, scoped: string | undefined): string {
  return scoped || options.projectDir;
}

/** `editor._path`: the track file, or a refusal for a missing root, bad name, link, or escape. */
function locate(root: string, cwd: string, name: string): string {
  if (!isTrack(name)) throw new TrackInvalid("memory track unavailable");
  const base = pyResolve(root);
  const target = trackPaths(base, cwd)[name];
  if (isLink(base) || isLink(target) || !isRelativeTo(pyResolve(target), base)) throw new TrackInvalid("memory track path denied");
  for (const parent of parents(target)) {
    if (isRelativeTo(parent, base) && isLink(parent)) throw new TrackInvalid("memory track parent denied");
  }
  return target;
}

function readTrack(root: string, cwd: string, name: string): { name: string; content: string; digest: string } {
  const target = locate(root, cwd, name);
  let raw: Buffer;
  try { raw = readFileSync(target); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") raw = Buffer.alloc(0);
    else throw error;
  }
  if (raw.length > MAX_BYTES) throw new TrackInvalid("memory track too large to edit");
  return { name, content: pyDecodeUtf8(raw), digest: createHash("sha256").update(raw).digest("hex") };
}

/** `replace_file`: rename over the destination, retrying brief Windows sharing errors. */
function replaceFile(source: string, destination: string): void {
  const deadline = performance.now() + 500;
  for (;;) {
    try { renameSync(source, destination); return; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (process.platform !== "win32" || !["EPERM", "EBUSY", "EACCES"].includes(code) || performance.now() >= deadline) throw error;
      const until = performance.now() + 10;
      while (performance.now() < until) { /* same half-second budget as Python */ }
    }
  }
}

/** Temp file in the track directory, fsync, then replace. `newline="\\n"` means the bytes are unchanged. */
function writeAtomic(target: string, bytes: Buffer): void {
  const tmp = join(dirname(target), `.memory-${randomBytes(8).toString("hex")}`);
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    for (let at = 0; at < bytes.length;) at += writeSync(fd, bytes, at, bytes.length - at);
    fsyncSync(fd);
  } catch (error) {
    try { closeSync(fd); } catch { /* the original error is the one that matters */ }
    try { unlinkSync(tmp); } catch { /* already gone */ }
    throw error;
  }
  closeSync(fd);
  try { replaceFile(tmp, target); }
  finally {
    try { unlinkSync(tmp); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

function record(data: unknown): Record<string, unknown> {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new TypeError("memory editor data must be an object");
  return data as Record<string, unknown>;
}

function writeTrack(root: string, cwd: string, name: string, data: unknown): { name: string; content: string; digest: string } {
  const body = record(data);
  const content = body.content;
  if (body.confirmed !== true || typeof content !== "string") throw new TrackInvalid("confirmed content required (max 100KB)");
  const encoded = pyEncodeUtf8(content);
  if (encoded.length > MAX_BYTES) throw new TrackInvalid("confirmed content required (max 100KB)");
  const current = readTrack(root, cwd, name);
  if (body.digest !== current.digest) throw new DigestMismatch("memory changed; reload before saving");
  const target = locate(root, cwd, name);
  mkdirSync(dirname(target), { recursive: true });
  locate(root, cwd, name);
  writeAtomic(target, encoded);
  return readTrack(root, cwd, name);
}

/** `memory_api.track_entries`. `path.is_file()` follows links; a failure is absence. */
function trackEntries(root: string, cwd: string): TrackEntry[] {
  const paths = trackPaths(root, cwd);
  return TRACK_NAMES.map((name) => {
    const path = paths[name];
    try {
      const stat = statSync(path, { bigint: true });
      if (stat.isFile()) return { name, path, bytes: Number(stat.size), present: true };
    } catch (error) { if (!isOsError(error)) throw error; }
    return { name, path, bytes: 0, present: false };
  });
}

/** `catalog.dispatch`: configured whenever the root is set, even with no files. */
function workspaceList(options: MemoryHttpOptions, env: NodeJS.ProcessEnv): { workspaces: { id: string; label: string; files: unknown[] }[]; configured: boolean } {
  const root = memoryRoot(env);
  if (root == null) return { workspaces: [], configured: false };
  const resolved = pyResolve(root);
  const workspaces = [];
  for (const id of workspaceIds(options)) {
    const files = [];
    for (const track of trackEntries(root, id)) {
      if (!track.present) continue;
      try {
        if (isLink(track.path) || !isRelativeTo(pyResolve(track.path), resolved)) continue;
        const updatedAt = Number(statSync(track.path, { bigint: true }).mtimeNs / 1_000_000n);
        files.push({ ...track, fileName: basename(track.path), updatedAt });
      } catch (error) { if (!isOsError(error)) throw error; }
    }
    if (files.length) workspaces.push({ id, label: basename(id) || id, files });
  }
  return { workspaces, configured: true };
}

function editor(method: string, name: string, query: Record<string, unknown>, data: unknown, options: MemoryHttpOptions, env: NodeJS.ProcessEnv): Reply {
  // Scope first, as Python does: a bad `root` is 400 even for a method that would otherwise be 405.
  const cwd = cwdOf(options, scopedCwd(query, options));
  if (method !== "GET" && method !== "POST") return [405, { error: "method not allowed" }];
  const root = memoryRoot(env);
  if (root == null) throw new TrackInvalid("memory track unavailable");
  return method === "GET" ? [200, readTrack(root, cwd, name)] : [200, writeTrack(root, cwd, name, data)];
}

function fail(error: unknown): Reply {
  if (error instanceof DigestMismatch) return [409, { error: "memory changed; reload before saving" }];
  if (error instanceof TrackInvalid || error instanceof PyUnicodeDecodeError || error instanceof PyUnicodeEncodeError || isOsError(error)) return [400, { error: TRACK_ERROR }];
  throw error;
}

export function createMemoryHttp(options: MemoryHttpOptions) {
  const envOf = (): NodeJS.ProcessEnv => options.env ?? process.env;
  const owns = (method: string, parts: readonly string[]): boolean => parts[0] === "api" && parts[1] === "memory"
    && (parts.length === 3 && parts[2] === "tracks" && method === "GET"
      || parts.length === 3 && parts[2] === "workspaces" && method === "GET"
      || parts.length === 4 && parts[2] === "tracks");
  return {
    routes: [...MEMORY_HTTP_ROUTES],
    owns,
    dispatch(method: string, parts: readonly string[], query: Record<string, unknown> = {}, data: unknown = {}): Reply | null {
      if (!owns(method, parts)) return null;
      if (!options.enabled("memory")) return [403, { error: "plugin disabled or dependency unavailable: memory", plugin: "memory" }];
      const env = envOf();
      try {
        if (parts.length === 3 && parts[2] === "workspaces") return [200, workspaceList(options, env)];
        if (parts.length === 3) return [200, { tracks: memoryRoot(env) == null ? [] : trackEntries(memoryRoot(env)!, cwdOf(options, undefined)) }];
        return editor(method, parts[3]!, query, data, options, env);
      } catch (error) { return fail(error); }
    },
  };
}
