/**
 * Atomic file replacement: write a temporary sibling, fsync, rename over the
 * target. A symlink is followed so the link itself survives; the file mode is
 * kept. Windows renames are retried while another process holds the file.
 */
import { randomBytes } from "node:crypto";
import { link, mkdir, open, realpath, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const RETRYABLE = new Set(["EPERM", "EBUSY", "EACCES"]);

async function resolveTarget(path: string): Promise<{ target: string; mode: number | undefined }> {
  try {
    const target = await realpath(path);
    return { target, mode: (await stat(target)).mode & 0o7777 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { target: path, mode: undefined };
    throw error;
  }
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (process.platform !== "win32" || !RETRYABLE.has(code) || attempt >= 5) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20 * 2 ** attempt));
    }
  }
}

export interface AtomicWriteOptions {
  /** Create missing parent directories (default true). */
  mkdirs?: boolean;
  /** Mode for a new file (default 0o666 minus umask). */
  mode?: number;
  /** Atomically fail if the target already exists. */
  createOnly?: boolean;
  /** Revalidate an expected revision immediately before replacing the target. */
  beforeRename?: () => Promise<void>;
  signal?: AbortSignal;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error("File system operation was cancelled") as Error & { code: string };
  error.name = "AbortError";
  error.code = "cancelled";
  throw error;
}

/** Replace `path` with `data` atomically. Returns the path actually written. */
export async function writeFileAtomic(path: string, data: Uint8Array, options: AtomicWriteOptions = {}): Promise<string> {
  throwIfAborted(options.signal);
  const { target, mode } = await resolveTarget(path);
  const directory = dirname(target);
  if (options.mkdirs !== false) await mkdir(directory, { recursive: true });
  throwIfAborted(options.signal);
  const temporary = join(directory, `.${basename(target)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  const handle = await open(temporary, "wx", mode ?? options.mode ?? 0o666);
  try {
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    throwIfAborted(options.signal);
    if (options.createOnly) {
      await link(temporary, target);
      await unlink(temporary);
    } else {
      await options.beforeRename?.();
      throwIfAborted(options.signal);
      await renameWithRetry(temporary, target);
    }
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  return target;
}
