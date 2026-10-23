/** Private atomic JSON replacement shared by the workflow stores (Python `json.dump` + fsync + replace). */
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { pyDecodeUtf8, pyEncodeUtf8, pyJsonDumps, pyJsonLoads, PyValueError } from "@xueness/contracts";
import { lockFileSync, mkstemp, replaceFile, writeAll, type HeldFileLock, type SyncLockOptions } from "@xueness/sessions";

/** Record locks are held for one read or replacement; a minute means a wedged peer. */
export const RECORD_LOCK_SECONDS = 60;

export function isSymlink(path: string): boolean {
  try { return lstatSync(path).isSymbolicLink(); } catch { return false; }
}

export function ensurePrivateDirectory(path: string, message: string): void {
  if (isSymlink(path)) throw new PyValueError(message);
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

/** `json.dump(record, stream, ensure_ascii=False)` into a temp file, fsync, then replace. */
export function writeJsonAtomic(directory: string, prefix: string, destination: string, value: unknown): void {
  const temp = mkstemp(directory, prefix);
  try {
    try { writeAll(temp.fd, pyEncodeUtf8(pyJsonDumps(value, { ensureAscii: false }))); fsyncSync(temp.fd); }
    finally { closeSync(temp.fd); }
    replaceFile(temp.path, destination);
  } finally {
    if (existsSync(temp.path)) unlinkSync(temp.path);
  }
}

export function readJson(path: string): unknown {
  return pyJsonLoads(pyDecodeUtf8(readFileSync(path)), { lossless: true });
}

export function lockPath(path: string, options: SyncLockOptions = {}): HeldFileLock {
  return lockFileSync(path, { timeoutSeconds: RECORD_LOCK_SECONDS, ...options });
}
