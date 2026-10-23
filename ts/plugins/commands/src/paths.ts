/**
 * Link-refusing reads and host-path containment for command files (Python
 * `resources._is_link`, `Path.resolve()`, `write_lock.host_path_contained` and
 * the `O_NOFOLLOW` reads in `file_commands`). Nothing here follows a
 * link at the entry itself; a miss is an answer, never an exception.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, resolve, sep } from "node:path";

/** A symbolic link or junction (Node reports both); an entry that cannot be inspected fails closed. */
export function isLink(path: string): boolean {
  try { return lstatSync(path).isSymbolicLink(); } catch (error) { return (error as NodeJS.ErrnoException).code !== "ENOENT"; }
}

/** Python `Path.resolve()` (non-strict): links resolved as far as the path exists. */
export function real(path: string): string | null {
  const absolute = resolve(path);
  try { return realpathSync.native(absolute); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
    const parent = dirname(absolute);
    if (parent === absolute) return absolute;
    const base = real(parent);
    return base === null ? null : resolve(base, basename(absolute));
  }
}

const fold = (text: string): string => process.platform === "win32" || process.platform === "darwin" ? text.toLowerCase() : text;

/** `child` is `parent` or inside it, case-folded the way the host compares paths. */
export function contained(child: string, parent: string): boolean {
  const c = fold(resolve(child));
  const p = fold(resolve(parent));
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

/** Python `Path.is_dir()` / `is_file()` (they follow links; callers refuse links first). */
export const isDir = (path: string): boolean => { try { return statSync(path).isDirectory(); } catch { return false; } };
export const isFile = (path: string): boolean => { try { return statSync(path).isFile(); } catch { return false; } };

export type ReadFailure = "command_unreadable" | "command_file_too_large" | "command_invalid_encoding";
const DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Read one regular file without following a link at the entry, at most `max` bytes. */
export function readBytes(path: string, max: number): { raw: Buffer; tooLarge: boolean } | null {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); } catch { return null; }
  try {
    if (!fstatSync(fd).isFile()) return null;
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, max + 1 - total));
      if (!chunk.length) break;
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (!count) break;
      chunks.push(chunk.subarray(0, count)); total += count;
    }
    const raw = Buffer.concat(chunks);
    return { raw, tooLarge: raw.length > max };
  } catch { return null; } finally { closeSync(fd); }
}

/** Python `file_commands._read_text`: text, byte size, or why it could not be read. */
export function readText(path: string, max: number): { text: string | null; size: number | null; failure: ReadFailure | null } {
  const read = readBytes(path, max);
  if (!read) return { text: null, size: null, failure: "command_unreadable" };
  if (read.tooLarge) return { text: null, size: read.raw.length, failure: "command_file_too_large" };
  try { return { text: DECODER.decode(read.raw), size: read.raw.length, failure: null }; }
  catch { return { text: null, size: read.raw.length, failure: "command_invalid_encoding" }; }
}

/** Strict UTF-8 (a leading BOM kept as U+FEFF, as Python's "utf-8" codec does). */
export function decodeUtf8(raw: Buffer): string | null {
  try { return DECODER.decode(raw); } catch { return null; }
}
