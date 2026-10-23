/**
 * Session locks (`xueness/session_lease.py`).
 *
 * Python takes two locks around one journal read or write: a per-process
 * thread lock (no timeout), then an exclusive `flock` on
 * `.locks/<sid>.journal.lock` (8 s timeout, 20 ms polling). A run holds the
 * separate nonblocking `.locks/<sid>.lock` lease for a whole turn.
 *
 * Node has no `flock`. `KeyedMutex` replaces the thread lock. File locks go
 * through a `FileLockProvider`: `LocalFileLocks` gives the same exclusivity
 * inside one process (enough when TypeScript is the only writer), and
 * `NativeFileLocks` (see `native-locks.ts`) takes real OS locks (`flock`,
 * `LockFileEx`) so separate processes exclude each other.
 */
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, statSync } from "node:fs";
import { basename, join, normalize } from "node:path";
import { pyCasefold, PyValueError } from "@xueness/contracts";
import { PyBlockingIOError, PyTimeoutError } from "./errors.ts";

export const LOCK_TIMEOUT_SECONDS = 8;

/** `_fold_host_path`: Windows and macOS file names ignore case. */
export function foldHostPath(text: string): string {
  if (process.platform === "win32") return normalize(text).toLowerCase().replaceAll("/", "\\");
  if (process.platform === "darwin") return pyCasefold(text);
  return text;
}

/** A FIFO async mutex per key, standing in for Python's per-journal `threading.Lock`. */
export class KeyedMutex {
  readonly #tails = new Map<string, Promise<void>>();

  async acquire(key: string): Promise<() => void> {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.#tails.set(key, tail);
    await previous;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      release();
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    };
  }
}

export interface FileLockHandle {
  release(): void | Promise<void>;
}

export interface FileLockProvider {
  /** `exclusive_lock`: wait up to `timeoutSeconds`, then raise `TimeoutError`. */
  acquire(directory: string, name: string, timeoutSeconds: number): Promise<FileLockHandle>;
  /** `lease`: take the lock now or raise `BlockingIOError`. */
  tryAcquire(directory: string, name: string): Promise<FileLockHandle>;
  close(): Promise<void>;
}

/** `_lock_name`: one plain file name. */
export function validateLockName(name: string): void {
  if (typeof name !== "string" || !name || name === "." || name === ".." || basename(name) !== name
    || name.includes("/") || name.includes("\\") || name.includes("\0")) {
    throw new PyValueError("invalid session lock");
  }
}

/**
 * `_open_session_lock`: create the lock directory (0700) and open the lock
 * file (0600) without following a link. Python opens the file relative to
 * the directory descriptor; Node has no `openat`, so the directory is
 * checked with `lstat` first and the file is opened with `O_NOFOLLOW`.
 */
export function openSessionLock(directory: string, name: string): number {
  validateLockName(name);
  try {
    mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    // `mkdir(exist_ok=True)` still raises when the name is not a directory.
    if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !isDirectory(directory)) throw error;
  }
  const info = lstatSync(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new PyValueError("invalid lock directory");
  const flags = constants.O_CREAT | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
  let fd: number;
  try {
    fd = openSync(join(directory, name), flags, 0o600);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "ENOTDIR" || code === "EISDIR") throw new PyValueError("invalid session lock", { cause: error });
    throw error;
  }
  try {
    if (!fstatSync(fd).isFile()) throw new PyValueError("invalid session lock");
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  return fd;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

interface Waiter {
  resolve: () => void;
}

/**
 * `flock` exclusivity within this process. Like Python, the lock file stays
 * open while held and closing it is the release.
 */
export class LocalFileLocks implements FileLockProvider {
  readonly #held = new Set<string>();
  readonly #waiters = new Map<string, Waiter[]>();

  #key(directory: string, name: string): string {
    return foldHostPath(normalize(join(directory, name)));
  }

  #grant(key: string, fd: number): FileLockHandle {
    this.#held.add(key);
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        closeSync(fd);
        this.#held.delete(key);
        const next = this.#waiters.get(key)?.shift();
        if (next) next.resolve();
        if (this.#waiters.get(key)?.length === 0) this.#waiters.delete(key);
      },
    };
  }

  async acquire(directory: string, name: string, timeoutSeconds: number): Promise<FileLockHandle> {
    if (typeof timeoutSeconds !== "number" || !(timeoutSeconds >= 0)) throw new PyValueError("invalid lock timeout");
    const fd = openSessionLock(directory, name);
    const key = this.#key(directory, name);
    const deadline = performance.now() + timeoutSeconds * 1000;
    while (this.#held.has(key)) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        closeSync(fd);
        throw new PyTimeoutError("timed out waiting for a file lock");
      }
      await new Promise<void>((resolve) => {
        const waiter: Waiter = { resolve: () => { clearTimeout(timer); resolve(); } };
        const timer = setTimeout(() => {
          const queue = this.#waiters.get(key) ?? [];
          const index = queue.indexOf(waiter);
          if (index >= 0) queue.splice(index, 1);
          resolve();
        }, Math.max(1, Math.ceil(remaining)));
        const queue = this.#waiters.get(key) ?? [];
        queue.push(waiter);
        this.#waiters.set(key, queue);
      });
    }
    return this.#grant(key, fd);
  }

  async tryAcquire(directory: string, name: string): Promise<FileLockHandle> {
    const fd = openSessionLock(directory, name);
    const key = this.#key(directory, name);
    if (this.#held.has(key)) {
      closeSync(fd);
      throw new PyBlockingIOError("[Errno 11] Resource temporarily unavailable", "EAGAIN");
    }
    return this.#grant(key, fd);
  }

  async close(): Promise<void> {}
}
