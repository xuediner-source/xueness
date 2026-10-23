/**
 * One bounded directory level under permitted roots: a port of `list_level`
 * and its helpers in Python `bundled_plugins/files/directory_api.py`.
 *
 * The level is a name-sorted window of at most `maxEntries + 1` rows (Python
 * string order, by code point), so memory stays bounded however many children
 * a directory has. Symlinks are followed for the row kind; broken or cyclic
 * links and special files are skipped. Hidden rows are filtered after the
 * window, exactly as Python does.
 */
import { lstatSync, opendirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { pyStrip } from "@xueness/contracts";
import { pyOSErrorText, realish } from "@xueness/sessions";

export const DEFAULT_MAX_ENTRIES = 1000;
export const DIRECTORY_UNREADABLE = "directory-unreadable";

/** Typed browse failure (`DirectoryError`); deliberately not an OSError. */
export class DirectoryError extends Error {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string, message: string) {
    super(message);
    this.name = "DirectoryError";
    this.code = code;
    this.path = path;
  }
}

export interface DirectoryEntry { name: string; path: string; type: "directory" | "file"; hidden: boolean; isSymbolicLink: boolean }
export interface DirectoryCrumb { name: string; path: string; hidden: false }
export interface DirectoryLevel { path: string; home: string; crumbs: DirectoryCrumb[]; entries: DirectoryEntry[]; truncated: boolean }

const WINDOWS = process.platform === "win32";

/** `fully_qualified`: one fixed location regardless of the process state. */
export function fullyQualified(path: unknown): boolean {
  if (typeof path !== "string" || !path || path.includes("\0")) return false;
  if (WINDOWS) return /^(?:[A-Za-z]:|[\\/]{2}[^\\/]+[\\/][^\\/]+)[\\/]/.test(path);
  return path.startsWith("/") && !path.startsWith("//");
}

/** `PurePath.is_relative_to` for canonical absolute paths (equality included). */
export function isWithin(path: string, root: string): boolean {
  const [p, r] = WINDOWS ? [path.toLowerCase(), root.toLowerCase()] : [path, root];
  return p === r || p.startsWith(r.endsWith(sep) ? r : r + sep);
}

/** Python `str` ordering (code points), not UTF-16 code units. */
export function compareCodePoints(a: string, b: string): number {
  const shift = (unit: number): number => unit >= 0xd800 && unit <= 0xdfff ? unit + 0x2000 : unit >= 0xe000 ? unit - 0x800 : unit;
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const left = a.charCodeAt(index), right = b.charCodeAt(index);
    if (left !== right) return shift(left) - shift(right);
  }
  return a.length - b.length;
}

export function resolveRoots(roots: readonly string[]): string[] {
  if (!roots.length) return [realish("/")];
  const resolved: string[] = [];
  for (const root of roots) {
    try { resolved.push(realish(root)); } catch { /* an unopenable root is skipped */ }
  }
  if (!resolved.length) throw new DirectoryError(DIRECTORY_UNREADABLE, "", "permitted roots are unreadable");
  return [...new Set(resolved)];
}

export function fence(candidate: string, roots: readonly string[]): string {
  const resolved = realish(candidate);
  if (roots.some((root) => isWithin(resolved, root))) return resolved;
  throw new DirectoryError(DIRECTORY_UNREADABLE, resolved, `${resolved} is outside the permitted roots`);
}

function resolveTarget(roots: readonly string[], path: string | null): string {
  const home = realish(homedir());
  if (path === null || pyStrip(path) === "") return roots.some((root) => isWithin(home, root)) ? home : roots[0]!;
  const value = pyStrip(path);
  if (!fullyQualified(value)) throw new DirectoryError(DIRECTORY_UNREADABLE, value, `cannot list "${value}": not a fully qualified path`);
  return fence(value, roots);
}

/** `ancestry_crumbs`: root-to-target chain, stopping at the permitted roots. */
export function ancestryCrumbs(target: string, roots: readonly string[]): DirectoryCrumb[] {
  const resolvedRoots = roots.map((root) => realish(root));
  const crumbs: DirectoryCrumb[] = [];
  let current = target;
  for (;;) {
    const parent = dirname(current);
    crumbs.unshift({ name: parent === current ? current : basename(current), path: current, hidden: false });
    if (parent === current || !resolvedRoots.some((root) => isWithin(parent, root))) return crumbs;
    current = parent;
  }
}

/** `_bounded_insert`: keep the `keep` smallest names; true when one was dropped. */
function boundedInsert(window: [string, DirectoryEntry["type"]][], candidate: [string, DirectoryEntry["type"]], keep: number): boolean {
  if (window.length === keep && compareCodePoints(candidate[0], window[window.length - 1]![0]) >= 0) return true;
  let lo = 0, hi = window.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (compareCodePoints(candidate[0], window[mid]![0]) < 0) hi = mid;
    else lo = mid + 1;
  }
  window.splice(lo, 0, candidate);
  if (window.length <= keep) return false;
  window.pop();
  return true;
}

function classifyEntry(full: string, isDir: boolean, isLink: boolean): DirectoryEntry["type"] | null {
  if (isDir) return "directory";
  try {
    const info = statSync(full);
    if (isLink && info.isDirectory()) return "directory";
    return info.isFile() ? "file" : null;
  } catch { return null; }
}

function isSymlink(path: string): boolean {
  try { return lstatSync(path).isSymbolicLink(); } catch { return false; }
}

/** `list_level(roots, path, include_hidden, max_entries, include_files)`. */
export function listLevel(roots: readonly string[], path: string | null = null, includeHidden = false, maxEntries = DEFAULT_MAX_ENTRIES, includeFiles = false): DirectoryLevel {
  const permitted = resolveRoots(roots);
  const rawHome = realish(homedir());
  const home = permitted.some((root) => isWithin(rawHome, root)) ? rawHome : permitted[0]!;
  const target = resolveTarget(permitted, path);
  const limit = Math.max(1, Math.trunc(maxEntries)), keep = limit + 1;
  const window: [string, DirectoryEntry["type"]][] = [];
  let evicted = false;
  try {
    const level = opendirSync(target);
    try {
      for (let dent = level.readSync(); dent; dent = level.readSync()) {
        const full = join(target, dent.name);
        let isDir = dent.isDirectory(), isLink = dent.isSymbolicLink();
        // Without a dirent type (DT_UNKNOWN), `DirEntry.is_dir` falls back to lstat.
        if (!isDir && !isLink && !dent.isFile()) {
          try { const info = lstatSync(full); isDir = info.isDirectory(); isLink = info.isSymbolicLink(); } catch { continue; }
        }
        const kind = classifyEntry(full, isDir, isLink);
        if (kind === null || !includeFiles && kind !== "directory") continue;
        if (boundedInsert(window, [dent.name, kind], keep)) evicted = true;
      }
    } finally { level.closeSync(); }
  } catch (error) {
    throw new DirectoryError(DIRECTORY_UNREADABLE, target, `cannot list ${target}: ${pyOSErrorText(error, target)}`);
  }
  const entries: DirectoryEntry[] = [];
  let truncated = evicted;
  for (const [name, kind] of window) {
    const hidden = name.startsWith(".");
    if (hidden && !includeHidden) continue;
    if (entries.length === limit) { truncated = true; break; }
    const full = join(target, name);
    entries.push({ name, path: full, type: kind, hidden, isSymbolicLink: isSymlink(full) });
  }
  return { path: target, home, crumbs: ancestryCrumbs(target, permitted), entries, truncated };
}