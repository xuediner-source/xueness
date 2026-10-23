/**
 * Python exception families for session storage.
 *
 * HTTP routes and the run loop classify storage failures the way the Python
 * backend does: `OSError` (including `TimeoutError`, `FileNotFoundError` and
 * `BlockingIOError`) is an I/O condition, `ValueError` a refused or corrupt
 * journal, `KeyError` a missing field. Node reports file-system failures as
 * errors with an errno `code`; `pyExceptionName` maps both kinds to the
 * Python class name, and `isPyOSError` / `isPyValueError` answer `except`
 * clauses.
 */
import { PyException, PyJsonDecodeError, PyKeyError, PyValueError, pyStrRepr } from "@xueness/contracts";

/** `OSError` raised by ported code (not by Node itself). */
export class PyOSError extends PyException {
  override name = "OSError";
  readonly code: string | undefined;
  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

/** `TimeoutError` (an `OSError` subclass), e.g. a journal lock wait. */
export class PyTimeoutError extends PyOSError {
  override name = "TimeoutError";
}

/** `BlockingIOError` (an `OSError` subclass): a nonblocking lock is held elsewhere. */
export class PyBlockingIOError extends PyOSError {
  override name = "BlockingIOError";
}

const ERRNO_CLASSES: Record<string, string> = {
  ENOENT: "FileNotFoundError", EEXIST: "FileExistsError", EACCES: "PermissionError", EPERM: "PermissionError",
  EISDIR: "IsADirectoryError", ENOTDIR: "NotADirectoryError", EAGAIN: "BlockingIOError", EWOULDBLOCK: "BlockingIOError",
  EINTR: "InterruptedError", ETIMEDOUT: "TimeoutError", ESRCH: "ProcessLookupError", ECHILD: "ChildProcessError",
  EPIPE: "BrokenPipeError", ECONNRESET: "ConnectionResetError", ECONNREFUSED: "ConnectionRefusedError",
  ECONNABORTED: "ConnectionAbortedError",
};

function errnoCode(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === "string" && /^E[A-Z0-9]+$/.test(code) && typeof (error as NodeJS.ErrnoException).syscall === "string" ? code : null;
}

/** True for what Python would raise as `OSError` or one of its subclasses. */
export function isPyOSError(error: unknown): boolean {
  return error instanceof PyOSError || errnoCode(error) !== null;
}

/** True for `ValueError` and its subclasses (`JSONDecodeError`, `UnicodeError`). */
export function isPyValueError(error: unknown): boolean {
  return error instanceof PyValueError || error instanceof PyJsonDecodeError
    || (error instanceof Error && (error.name === "ValueError" || error.name === "DuplicateKey"));
}

/** True for `KeyError`. */
export function isPyKeyError(error: unknown): boolean {
  return error instanceof PyKeyError;
}

/** The Python exception class name for an error raised by ported storage code. */
export function pyExceptionName(error: unknown): string {
  const code = errnoCode(error);
  if (code !== null) return ERRNO_CLASSES[code] ?? "OSError";
  if (error instanceof Error) return error.name;
  return "Exception";
}

/** The `Store.save` substage Python attaches as `_xueness_store_stage`. */
export type StoreStage =
  | "session_path" | "lock" | "temp_create" | "protect_temp" | "serialize" | "flush" | "replace"
  | "read" | "mutate" | "save";

/** Attach a fixed substage without retaining exception text (`_annotate_store_failure`). */
export function annotateStoreFailure(error: unknown, stage: StoreStage): void {
  if (typeof error === "object" && error !== null) {
    try {
      (error as { xuenessStoreStage?: StoreStage }).xuenessStoreStage = stage;
    } catch {
      // Frozen errors keep their original shape, as Python ignores failures here.
    }
  }
}

/** The substage attached by `annotateStoreFailure`, if any. */
export function storeStage(error: unknown): StoreStage | null {
  return typeof error === "object" && error !== null ? ((error as { xuenessStoreStage?: StoreStage }).xuenessStoreStage ?? null) : null;
}

/** C `strerror` text (identical in glibc and macOS libc) for common file-system errors. */
const STRERROR: Record<string, string> = {
  EPERM: "Operation not permitted", ENOENT: "No such file or directory", EIO: "Input/output error", EBADF: "Bad file descriptor",
  EAGAIN: "Resource temporarily unavailable", EACCES: "Permission denied", EEXIST: "File exists", EXDEV: "Invalid cross-device link",
  ENOTDIR: "Not a directory", EISDIR: "Is a directory", EINVAL: "Invalid argument", ENFILE: "Too many open files in system",
  EMFILE: "Too many open files", ENOSPC: "No space left on device", EROFS: "Read-only file system", ENAMETOOLONG: "File name too long",
  ELOOP: "Too many levels of symbolic links", ENOTEMPTY: "Directory not empty",
};

/** `exc.strerror` for a Node file-system error (`None` when the error carries no errno). */
export function pyStrerror(error: unknown): string | null {
  const code = errnoCode(error);
  if (code === null) return null;
  return STRERROR[code] ?? (/^[A-Z0-9]+: ([^,]+)/u.exec((error as Error).message)?.[1] ?? code);
}

/**
 * `str(exc)` for a Node file-system error on POSIX: `[Errno 2] No such file or
 * directory: '/x'`. `filename` names the path when Node leaves it off the error.
 */
export function pyOSErrorText(error: unknown, filename?: string): string {
  const code = errnoCode(error), info = error as NodeJS.ErrnoException;
  if (code === null || process.platform === "win32" || typeof info.errno !== "number") return error instanceof Error ? error.message : String(error);
  const described = /^[A-Z0-9]+: ([^,]+)/u.exec(info.message)?.[1] ?? code;
  const head = `[Errno ${Math.abs(info.errno)}] ${STRERROR[code] ?? described.charAt(0).toUpperCase() + described.slice(1)}`;
  const path = filename ?? info.path, dest = (info as { dest?: unknown }).dest;
  if (typeof path !== "string") return head;
  return `${head}: ${pyStrRepr(path)}${typeof dest === "string" ? ` -> ${pyStrRepr(dest)}` : ""}`;
}
