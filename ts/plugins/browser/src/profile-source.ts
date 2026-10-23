/**
 * Read a Chrome profile without following links (`profiles._source_info`,
 * `_read_file`, `_snapshot_sources`). Byte and entry caps match Python.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync, type Dirent, type Stats } from "node:fs";
import { join } from "node:path";
import { COPY_PATHS, MAX_COPY_BYTES, MAX_COPY_FILES, MAX_DIRECTORY_DEPTH, MAX_LOCAL_STATE_BYTES, ProfileError, exists, isLink, sameSignature, signature, type FileSig } from "./profile-error.ts";

const NOFOLLOW = process.platform === "win32" ? 0 : constants.O_NOFOLLOW ?? 0;
export interface SourceRecord { kind: "file" | "directory"; sig: FileSig }
export type SourceSnapshot = Map<string, SourceRecord>;

export function relativeParts(relative: string): string[] {
  const value = process.platform === "win32" ? relative.replaceAll("\\", "/") : relative;
  const parts = value.split("/");
  if (!parts.length || parts.some((part) => part === "" || part === "." || part === ".." || part.includes("\0") || part.includes(":") || part.includes("/") || (process.platform === "win32" && part.includes("\\")))) throw new ProfileError("source_invalid");
  return parts;
}

/** lstat each component. A symlink or a non-directory parent is `source_invalid`; a missing leaf is null. */
export function sourceInfo(root: string, parts: readonly string[]): Stats | null {
  let current = root;
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index]!);
    let info: Stats;
    try { info = lstatSync(current); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    if (info.isSymbolicLink()) throw new ProfileError("source_invalid");
    if (index < parts.length - 1 && !info.isDirectory()) throw new ProfileError("source_invalid");
  }
  return lstatSync(current);
}

/** One regular file, capped, re-checked against `expected` so a swap mid-read is `source_busy`. */
export function readSourceFile(root: string, parts: readonly string[], maximum: number, expected?: FileSig): Buffer {
  const before = sourceInfo(root, parts);
  if (!before?.isFile()) throw new ProfileError("source_invalid");
  if (expected && !sameSignature(signature(before), expected)) throw new ProfileError("source_busy");
  const full = join(root, ...parts);
  let fd: number;
  try { fd = openSync(full, constants.O_RDONLY | NOFOLLOW); } catch { throw new ProfileError("source_busy"); }
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile()) throw new ProfileError("source_invalid");
    if (expected && !sameSignature(signature(opened), expected, true)) throw new ProfileError("source_busy");
    if (opened.size > maximum) throw new ProfileError("profile_too_large");
    const data = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < data.length) {
      const read = readSync(fd, data, offset, data.length - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    if (offset > maximum) throw new ProfileError("profile_too_large");
    if (offset !== opened.size) throw new ProfileError("source_busy");
    if (expected) {
      const after = sourceInfo(root, parts);
      if (!after || !sameSignature(signature(after), expected)) throw new ProfileError("source_busy");
    }
    return data.subarray(0, offset);
  } finally { closeSync(fd); }
}

function remember(records: SourceSnapshot, parts: readonly string[], info: Stats, budget: { entries: number; bytes: number }): "file" | "directory" {
  if (info.isSymbolicLink()) throw new ProfileError("source_invalid");
  const kind = info.isDirectory() ? "directory" : info.isFile() ? "file" : null;
  if (!kind) throw new ProfileError("source_invalid");
  const key = parts.join("/");
  const record: SourceRecord = { kind, sig: signature(info) };
  const previous = records.get(key);
  if (previous) {
    if (previous.kind !== record.kind || !sameSignature(previous.sig, record.sig)) throw new ProfileError("source_busy");
    return kind;
  }
  budget.entries += 1;
  if (budget.entries > MAX_COPY_FILES) throw new ProfileError("profile_too_large");
  if (kind === "file") {
    budget.bytes += info.size;
    if (budget.bytes > MAX_COPY_BYTES) throw new ProfileError("profile_too_large");
  }
  records.set(key, record);
  return kind;
}

function walkDirectory(root: string, records: SourceSnapshot, parts: string[], budget: { entries: number; bytes: number }): void {
  const stack: { parts: string[]; expected: FileSig; depth: number }[] = [{ parts, expected: records.get(parts.join("/"))!.sig, depth: 0 }];
  const seen = new Set<string>();
  while (stack.length) {
    const current = stack.pop()!;
    const key = current.parts.join("/");
    if (seen.has(key)) continue;
    seen.add(key);
    if (current.depth > MAX_DIRECTORY_DEPTH) throw new ProfileError("profile_too_large");
    const info = sourceInfo(root, current.parts);
    if (!info?.isDirectory() || !sameSignature(signature(info), current.expected)) throw new ProfileError("source_busy");
    let entries: Dirent[];
    try { entries = readdirSync(join(root, ...current.parts), { withFileTypes: true }); } catch { throw new ProfileError("source_busy"); }
    for (const entry of entries) {
      if (entry.name === "." || entry.name === ".." || entry.name.includes("\0") || entry.name.includes(":") || entry.name.includes("/") || entry.name.includes("\\")) throw new ProfileError("source_invalid");
      const child = [...current.parts, entry.name];
      const childInfo = sourceInfo(root, child);
      if (!childInfo) throw new ProfileError("source_busy");
      const kind = remember(records, child, childInfo, budget);
      if (kind === "directory") stack.push({ parts: child, expected: signature(childInfo), depth: current.depth + 1 });
    }
  }
}

/** Inventory the approved copy list under `profileId`, plus `Local State` when it is a regular file. */
export function snapshotSources(root: string, profileId: string): SourceSnapshot {
  const records: SourceSnapshot = new Map();
  const budget = { entries: 0, bytes: 0 };
  const source = sourceInfo(root, [profileId]);
  if (!source?.isDirectory()) throw new ProfileError("source_busy");
  remember(records, [profileId], source, budget);
  for (const name of COPY_PATHS) {
    const candidate = [profileId, ...name.split("/")];
    let absent = false;
    for (let index = 2; index <= candidate.length; index += 1) {
      const parts = candidate.slice(0, index);
      const info = sourceInfo(root, parts);
      if (!info) { absent = true; break; }
      const kind = remember(records, parts, info, budget);
      if (index < candidate.length && kind !== "directory") throw new ProfileError("source_invalid");
      if (index === candidate.length && kind === "directory") walkDirectory(root, records, parts, budget);
    }
    if (absent) continue;
  }
  const local = sourceInfo(root, ["Local State"]);
  if (local) {
    if (remember(records, ["Local State"], local, budget) !== "file") throw new ProfileError("source_invalid");
    if (local.size > MAX_LOCAL_STATE_BYTES) throw new ProfileError("profile_too_large");
  }
  return records;
}

export function fileRecords(snapshot: SourceSnapshot, profileId: string): [string, FileSig][] {
  const prefix = profileId + "/";
  return [...snapshot.entries()].filter((entry): entry is [string, SourceRecord] => entry[0].startsWith(prefix) && entry[1].kind === "file").map(([key, record]): [string, FileSig] => [key, record.sig]).sort((left, right) => left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0);
}

/** The checked Chrome directory, or null when it is missing or a link. `realpath` so later joins stay inside it. */
export function checkedDirectory(root: string | null): string | null {
  if (!root || isLink(root)) return null;
  try {
    const resolved = realpathSync(root);
    return lstatSync(resolved).isDirectory() ? resolved : null;
  } catch { return null; }
}

export function sameSnapshot(left: SourceSnapshot, right: SourceSnapshot): boolean {
  if (left.size !== right.size) return false;
  for (const [key, record] of left) {
    const other = right.get(key);
    if (!other || other.kind !== record.kind || !sameSignature(other.sig, record.sig)) return false;
  }
  return true;
}
