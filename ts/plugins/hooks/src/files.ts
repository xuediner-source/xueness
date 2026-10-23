/**
 * Link-refusing reads and host-path comparison for hook files (Python
 * `resources._is_link`, the `O_NOFOLLOW` reads in `hooks._safe_read_json` and
 * `workspace_hooks._read_text`, `write_lock.host_relative_to`). A miss is an
 * answer, never an exception.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { basename, dirname, normalize, resolve, sep } from "node:path";

/** A symbolic link or junction; an entry that cannot be inspected fails closed. */
export function isLink(path: string): boolean {
  try { return lstatSync(path).isSymbolicLink(); } catch (error) { return (error as NodeJS.ErrnoException).code !== "ENOENT"; }
}

/** `os.path.lexists`. */
export function lexists(path: string): boolean {
  try { lstatSync(path); return true; } catch { return false; }
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

/** `host_relative_to`: the POSIX suffix of `child` inside `parent`, "." for the same path, null outside. */
export function hostRelativeTo(child: string, parent: string): string | null {
  const c = normalize(child).replace(/[\\/]+$/, "") || sep;
  const p = normalize(parent).replace(/[\\/]+$/, "") || sep;
  if (fold(c) === fold(p)) return ".";
  const prefix = p.endsWith(sep) ? p : p + sep;
  if (!fold(c).startsWith(fold(prefix))) return null;
  return c.slice(prefix.length).split(sep).filter(Boolean).join("/") || null;
}

/** Read one regular file without following a link at the entry, at most `max + 1` bytes. */
export function readCapped(path: string, max: number): Buffer | null {
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
    return Buffer.concat(chunks);
  } catch { return null; } finally { closeSync(fd); }
}

const STRICT = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
/** Strict UTF-8 that keeps a BOM (Python `bytes.decode("utf-8")`); null when invalid. */
export function utf8(raw: Buffer): string | null {
  try { return STRICT.decode(raw); } catch { return null; }
}
