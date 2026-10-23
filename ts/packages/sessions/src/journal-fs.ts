/**
 * File primitives behind the durable session journal (`xueness/core.py`).
 *
 * Journals are published by writing a private temp file in the same
 * directory, fsyncing it, pointing `<sid>.json.bak` at the previous inode
 * with a hard link, renaming over the live name and fsyncing the directory.
 * Reads never follow links and refuse non-regular files. Every refusal uses
 * the Python message so callers and HTTP routes classify it identically.
 */
import { constants, closeSync, fchmodSync, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readdirSync, readSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { PyValueError } from "@xueness/contracts";
import { isPyOSError, PyOSError } from "./errors.ts";
import { protectWindowsDirectory, protectWindowsFile } from "./windows-native.ts";

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const NONBLOCK = constants.O_NONBLOCK ?? 0;
const DIRECTORY = constants.O_DIRECTORY ?? 0;

export const STALE_SESSION_TEMP_SECONDS = 60;

/** `_is_link`: a symbolic link (or junction), or an entry that cannot be inspected. */
export function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

/** `Path.is_file()`: follows links; any failure is False. */
export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** `Path.exists()`: follows links; a missing target is False. */
export function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Read every byte of an open descriptor. */
export function readAll(fd: number): Buffer {
  const chunks: Buffer[] = [];
  for (;;) {
    const block = Buffer.allocUnsafe(1024 * 1024);
    const count = readSync(fd, block, 0, block.length, null);
    if (count === 0) break;
    chunks.push(block.subarray(0, count));
  }
  return Buffer.concat(chunks);
}

/** `_read_regular_bytes`: the file's bytes, refusing links and non-regular files. */
export function readRegularBytes(path: string): Buffer {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | NONBLOCK | NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (NOFOLLOW && (code === "ELOOP" || code === "ENOTDIR")) {
      throw new PyValueError("session file is a symbolic link or reparse point", { cause: error });
    }
    throw error;
  }
  try {
    if (!fstatSync(fd).isFile()) throw new PyValueError("session file is a symbolic link or reparse point");
    return readAll(fd);
  } finally {
    closeSync(fd);
  }
}

/** `_write_all`: loop until every byte is written. */
export function writeAll(fd: number, payload: Uint8Array, position: number | null = null): void {
  let offset = 0;
  while (offset < payload.length) {
    const written = writeSync(fd, payload, offset, payload.length - offset, position === null ? null : position + offset);
    if (written <= 0) throw new PyOSError("session journal write made no progress");
    offset += written;
  }
}

/** `_fsync_directory`: make a rename or hard link durable. Best effort. */
export function fsyncDirectory(directory: string): void {
  let fd: number;
  try {
    fd = openSync(directory, constants.O_RDONLY | DIRECTORY);
  } catch {
    return;
  }
  try {
    fsyncSync(fd);
  } catch {
    // Some file systems refuse directory fsync; the publish still happened.
  } finally {
    closeSync(fd);
  }
}

/**
 * `_protect_private_file`: owner-only mode before any sensitive byte is
 * written. Windows uses a protected owner/SYSTEM/Administrators DACL.
 */
export function protectPrivateFile(fd: number): void {
  if (process.platform === "win32") return protectWindowsFile(fd);
  fchmodSync(fd, 0o600);
}

/** Protect an existing private directory; Windows updates use its open handle. */
export function protectPrivateDirectory(path: string): void {
  if (process.platform === "win32") return protectWindowsDirectory(path);
  const fd = openSync(path, constants.O_RDONLY | DIRECTORY | NOFOLLOW);
  try { fchmodSync(fd, 0o700); } finally { closeSync(fd); }
}

/** `_cleanup_stale_session_temps`: drop crash leftovers older than a minute; skip links. */
export function cleanupStaleSessionTemps(directory: string): void {
  const cutoff = Date.now() / 1000 - STALE_SESSION_TEMP_SECONDS;
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return;
  }
  for (const name of entries) {
    const entry = join(directory, name);
    if (!name.startsWith(".session-") || isLink(entry)) continue;
    try {
      const info = lstatSync(entry);
      if (!info.isFile() || info.mtimeMs / 1000 >= cutoff) continue;
      unlinkSync(entry);
    } catch {
      continue;
    }
  }
}

const TEMP_CHARACTERS = "abcdefghijklmnopqrstuvwxyz0123456789_";

/** `tempfile.mkstemp(prefix=..., dir=...)`: an exclusive 0600 file with 8 random characters. */
export function mkstemp(directory: string, prefix: string): { fd: number; path: string } {
  for (let attempt = 0; attempt < 10000; attempt += 1) {
    let name = prefix;
    for (let index = 0; index < 8; index += 1) name += TEMP_CHARACTERS[Math.floor(Math.random() * TEMP_CHARACTERS.length)];
    const path = join(directory, name);
    try {
      const fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
      return { fd, path };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
  }
  throw new PyOSError("No usable temporary file name found", "EEXIST");
}

/** `_rotate_journal_backup`: point `<path>.bak` at the current inode before replacing it. */
export function rotateJournalBackup(path: string): void {
  const backup = path + ".bak";
  if (isLink(path) || isLink(backup)) return;
  try {
    if (exists(backup)) unlinkSync(backup);
    linkSync(path, backup);
  } catch (error) {
    if (isPyOSError(error)) return;
    throw error;
  }
  fsyncDirectory(dirname(path));
}

const SHARING_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

/** `replace_file`: atomic rename, retrying brief Windows sharing collisions for 0.5 s. */
export function replaceFile(source: string, destination: string): void {
  const deadline = performance.now() + 500;
  for (;;) {
    try {
      renameSync(source, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (process.platform !== "win32" || !SHARING_CODES.has(code) || performance.now() >= deadline) throw error;
      const until = performance.now() + 10;
      while (performance.now() < until) {
        // A short spin keeps the rename synchronous, as in Python.
      }
    }
  }
}
