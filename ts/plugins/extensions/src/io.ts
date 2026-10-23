/** Bounded JSON reads and the private atomic replace `resources._atomic_write_json` uses. */
import { closeSync, constants, fsyncSync, mkdirSync, openSync, readSync, statSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { pyEncodeUtf8, pyJsonDumps, PyValueError } from "@xueness/contracts";
import { exists, fsyncDirectory, mkstemp, protectPrivateFile, replaceFile, writeAll } from "@xueness/sessions";

export class BoundedReadError extends PyValueError {}

/** Read at most `limit + 1` bytes. A larger file throws `BoundedReadError` and is not returned. */
export function readLimited(path: string, limit: number): Buffer {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (size <= limit) {
      const block = Buffer.allocUnsafe(Math.min(65536, limit + 1 - size));
      const count = readSync(fd, block, 0, block.length, null);
      if (count === 0) break;
      chunks.push(block.subarray(0, count));
      size += count;
    }
  } finally {
    closeSync(fd);
  }
  if (size > limit) throw new BoundedReadError("too large");
  return Buffer.concat(chunks);
}

export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** `_atomic_write_json`: private temp, fsync, rename. Callers roll back with the previous bytes. */
export function atomicWriteJson(path: string, item: Record<string, unknown>): void {
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true });
  const temp = mkstemp(parent, ".resource-");
  try {
    try {
      protectPrivateFile(temp.fd);
      writeAll(temp.fd, pyEncodeUtf8(pyJsonDumps(item, { ensureAscii: false, indent: 2 })));
      fsyncSync(temp.fd);
    } finally {
      closeSync(temp.fd);
    }
    replaceFile(temp.path, path);
  } finally {
    if (exists(temp.path)) unlinkSync(temp.path);
  }
  try {
    fsyncDirectory(parent);
  } catch {
    /* Python ignores a directory fsync failure. */
  }
}
