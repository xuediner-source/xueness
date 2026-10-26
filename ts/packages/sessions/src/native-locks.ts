/** Native flock/LockFileEx shared with Python, without a broker process. */
import { closeSync, constants, fstatSync, mkdirSync, openSync } from "node:fs";
import { setTimeout } from "node:timers/promises";
import koffi from "koffi";
import { PyValueError } from "@xueness/contracts";
import { PyBlockingIOError, PyOSError, PyTimeoutError } from "./errors.ts";
import { validateLockName, type FileLockHandle, type FileLockProvider } from "./locks.ts";
import { openWindowsLock } from "./windows-native.ts";

interface NativeHandle { tryLock(): boolean; close(): void }
let posix: ReturnType<typeof loadPosix> | undefined;
function loadPosix() {
  const libc = koffi.load(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : null);
  return {
    // mode is variadic; Apple arm64 passes it on the stack, unlike fixed arguments.
    openat: libc.func("int openat(int, const char *, int, ...)"),
    flock: libc.func("int flock(int, int)"),
  };
}
function openPosix(directory: string, name: string): NativeHandle {
  // Node omits O_CLOEXEC from fs.constants. These are the kernel ABI values
  // for supported Linux and macOS targets (Linux asm-generic/fcntl.h and
  // Apple's bsd/sys/fcntl.h); set it atomically with openat, avoiding the
  // descriptor-inheritance race of a later F_SETFD call.
  const cloexec = process.platform === "darwin" ? 0x01000000 : process.platform === "linux" ? 0x00080000 : 0;
  if (!cloexec) throw new PyOSError("native session locks require Windows, Linux or macOS");
  const a = posix ??= loadPosix();
  const parent = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  let fd = -1;
  try {
    fd = a.openat(parent, name, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK | cloexec, "uint32", 0o600);
    if (fd < 0) throw new PyOSError("session lock file could not be opened", `ERRNO_${koffi.errno()}`);
    if (!fstatSync(fd).isFile()) throw new PyValueError("invalid session lock");
  } catch (error) {
    if (fd >= 0) closeSync(fd);
    throw error;
  } finally { closeSync(parent); }
  let closed = false;
  return {
    tryLock() {
      if (closed) throw new PyOSError("session lock is closed");
      if (a.flock(fd, 2 | 4) === 0) return true;
      const code = koffi.errno();
      if (code === 11 || (process.platform === "darwin" && code === 35)) return false;
      throw new PyOSError("session lock failed", `ERRNO_${code}`);
    },
    close() { if (!closed) { closed = true; closeSync(fd); } },
  };
}

export class NativeFileLocks implements FileLockProvider {
  readonly #handles = new Set<NativeHandle>();
  #closed = false;
  #open(directory: string, name: string): NativeHandle {
    if (this.#closed) throw new PyOSError("session lock provider is closed");
    validateLockName(name);
    try { mkdirSync(directory, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const handle = process.platform === "win32" ? openWindowsLock(directory, name) : openPosix(directory, name);
    this.#handles.add(handle);
    return handle;
  }
  #release(handle: NativeHandle): void { this.#handles.delete(handle); handle.close(); }
  async acquire(directory: string, name: string, timeoutSeconds: number): Promise<FileLockHandle> {
    if (typeof timeoutSeconds !== "number" || !(timeoutSeconds >= 0)) throw new PyValueError("invalid lock timeout");
    const handle = this.#open(directory, name);
    const deadline = performance.now() + timeoutSeconds * 1000;
    try {
      while (!handle.tryLock()) {
        const remaining = deadline - performance.now();
        if (remaining <= 0) throw new PyTimeoutError("timed out waiting for a file lock");
        await setTimeout(Math.min(20, remaining));
      }
      return { release: () => this.#release(handle) };
    } catch (error) { this.#release(handle); throw error; }
  }
  async tryAcquire(directory: string, name: string): Promise<FileLockHandle> {
    const handle = this.#open(directory, name);
    try {
      if (!handle.tryLock()) throw new PyBlockingIOError("[Errno 11] Resource temporarily unavailable", "EAGAIN");
      return { release: () => this.#release(handle) };
    } catch (error) { this.#release(handle); throw error; }
  }
  async close(): Promise<void> {
    this.#closed = true;
    for (const handle of this.#handles) handle.close();
    this.#handles.clear();
  }
}
