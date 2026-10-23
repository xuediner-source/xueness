/** Shared Chrome-import guards (`profiles.ProfileError`, link and signature checks). */
import { lstatSync, type Stats } from "node:fs";

export class ProfileError extends Error {
  constructor(message: string) { super(message); this.name = "ProfileError"; }
}

export const PROFILE_ID = /^(Default|Profile [0-9]{1,4})$/;
export const COPY_PATHS = ["Bookmarks", "History", "History-journal", "Cookies", "Cookies-journal", "Network/Cookies", "Network/Cookies-journal", "Local Storage", "IndexedDB", "Session Storage"] as const;
export const MAX_COPY_BYTES = 256 * 1024 * 1024;
export const MAX_COPY_FILES = 10_000;
export const MAX_LOCAL_STATE_BYTES = 8 * 1024 * 1024;
export const MAX_DIRECTORY_DEPTH = 256;

export interface FileSig { mode: number; dev: number; ino: number; size: number; mtimeNs: bigint; ctimeNs: bigint }

/** `stat.S_IFMT` plus the identity fields `_signature` records. */
export function signature(info: Stats): FileSig {
  // `lstatSync` without `{ bigint: true }` types `mtimeNs` off `Stats`. Accept either form.
  const stamped = info as Stats & { mtimeNs?: bigint; ctimeNs?: bigint; size: number | bigint };
  const mtimeNs = typeof stamped.mtimeNs === "bigint" ? stamped.mtimeNs : BigInt(Math.round(info.mtimeMs * 1e6));
  const ctimeNs = typeof stamped.ctimeNs === "bigint" ? stamped.ctimeNs : BigInt(Math.round(info.ctimeMs * 1e6));
  return { mode: info.mode & 0o170000, dev: info.dev, ino: info.ino, size: Number(stamped.size), mtimeNs, ctimeNs };
}

/**
 * Windows `lstat` ctime is creation time and an open handle's ctime is last-change
 * time. An open file may differ in that one field; the lstat taken before and
 * after the read still compares the full signature.
 */
export function sameSignature(actual: FileSig, expected: FileSig, openHandle = false): boolean {
  if (actual.mode !== expected.mode || actual.dev !== expected.dev || actual.ino !== expected.ino || actual.size !== expected.size || actual.mtimeNs !== expected.mtimeNs) return false;
  return openHandle && process.platform === "win32" ? true : actual.ctimeNs === expected.ctimeNs;
}

export function exists(path: string): boolean {
  try { lstatSync(path); return true; } catch { return false; }
}

/** `profiles._link`: a symlink (and, on Windows, a junction Node reports as one). Missing is not a link. */
export function isLink(path: string): boolean {
  try { return lstatSync(path).isSymbolicLink(); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function isErrno(error: unknown): boolean {
  return typeof (error as NodeJS.ErrnoException | undefined)?.code === "string";
}
