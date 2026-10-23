/**
 * Synchronous advisory locks on one file, shared or exclusive (Python
 * `file_lock.flock`): flock on POSIX, LockFileEx on byte 0 on Windows. Closing
 * the descriptor releases the lock. Blocking acquisition polls the
 * nonblocking form, so a deadline can end the wait; callers hold these locks
 * only around short reads and replacements, never across an await.
 */
import { closeSync, constants, openSync } from "node:fs";
import koffi from "koffi";
import { PyBlockingIOError, PyOSError, PyTimeoutError } from "./errors.ts";

export interface HeldFileLock { readonly fd: number; release(): void }
export interface SyncLockOptions { shared?: boolean; blocking?: boolean; timeoutSeconds?: number }

let posixFlock: ((fd: number, operation: number) => number) | undefined;
let windows: { lock: (...args: unknown[]) => number; osHandle: (fd: number) => number | bigint; error: () => number } | undefined;
const sleeper = new Int32Array(new SharedArrayBuffer(4));

/** Block this thread for `ms` without spinning. */
export function sleepSync(ms: number): void { Atomics.wait(sleeper, 0, 0, Math.max(0, ms)); }

function tryLock(fd: number, shared: boolean): boolean {
  if (process.platform === "win32") {
    if (!windows) {
      const kernel = koffi.load("kernel32.dll");
      const overlap = koffi.struct("XuenessSyncOverlapped", { Internal: "uintptr_t", InternalHigh: "uintptr_t", Offset: "uint32", OffsetHigh: "uint32", hEvent: "uintptr_t" });
      windows = {
        lock: kernel.func("__stdcall", "LockFileEx", "int", ["uintptr_t", "uint32", "uint32", "uint32", "uint32", koffi.pointer(overlap)]),
        osHandle: koffi.load(null).func("intptr_t uv_get_osfhandle(int)"),
        error: kernel.func("uint32 __stdcall GetLastError()"),
      };
    }
    const flags = (shared ? 0 : 2) | 1;
    if (windows.lock(windows.osHandle(fd), flags, 0, 1, 0, { Internal: 0, InternalHigh: 0, Offset: 0, OffsetHigh: 0, hEvent: 0 })) return true;
    const code = windows.error();
    if (code === 33 || code === 158) return false;
    throw Object.assign(new PyOSError(`file lock failed (Windows error ${code})`), { winerror: code });
  }
  posixFlock ??= koffi.load(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : null).func("int flock(int, int)") as (fd: number, operation: number) => number;
  for (;;) {
    if (posixFlock(fd, (shared ? 1 : 2) | 4) === 0) return true;
    const code = koffi.errno();
    if (code === 4) continue;
    if (code === 11 || (process.platform === "darwin" && code === 35)) return false;
    throw new PyOSError("file lock failed", `ERRNO_${code}`);
  }
}

/**
 * Open `path` (created 0600; a final symlink is refused where the platform
 * can) and lock it. Nonblocking acquisition that loses raises
 * BlockingIOError, as `fcntl.flock(..., LOCK_NB)` does.
 */
export function lockFileSync(path: string, options: SyncLockOptions = {}): HeldFileLock {
  const fd = openSync(path, constants.O_CREAT | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    const shared = options.shared === true;
    const deadline = options.timeoutSeconds === undefined ? Infinity : performance.now() + options.timeoutSeconds * 1000;
    let pause = 1;
    while (!tryLock(fd, shared)) {
      if (options.blocking === false) throw new PyBlockingIOError("[Errno 11] Resource temporarily unavailable", "EAGAIN");
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new PyTimeoutError("timed out waiting for a file lock");
      sleepSync(Math.min(pause, remaining));
      pause = Math.min(pause * 2, 20);
    }
  } catch (error) { closeSync(fd); throw error; }
  let released = false;
  return { fd, release() { if (!released) { released = true; closeSync(fd); } } };
}

/** Run `body` while holding the lock; the descriptor closes on every exit. */
export function withFileLockSync<T>(path: string, options: SyncLockOptions, body: () => T): T {
  const held = lockFileSync(path, options);
  try { return body(); } finally { held.release(); }
}
