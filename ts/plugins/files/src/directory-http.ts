/**
 * `create_child` plus GET `/api/system` and GET|POST `/api/directory`
 * (`bundled_plugins/files/directory_api.py`).
 *
 * Startup list/create roots are extended on every call with `allowedRoots()`
 * (Python `workspaces_api.allowed_roots`), then deduped inside `list_level`.
 * Other verbs return null so the front door can proxy them.
 */
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { isDict, pyGet, pyStr, pyStrip, PyValueError } from "@xueness/contracts";
import { isPyKeyError, isPyOSError, isPyValueError, pyExceptionName, pyOSErrorText, realish } from "@xueness/sessions";
import { DEFAULT_MAX_ENTRIES, DirectoryError, fence, fullyQualified, isWithin, listLevel, resolveRoots } from "./directory-level.ts";

export const DIRECTORY_EXISTS = "directory-exists";
export const DIRECTORY_CREATE_FAILED = "directory-create-failed";

const WINDOWS = process.platform === "win32";

export interface DirectoryHttpOptions {
  listRoots?: readonly string[];
  createRoots?: readonly string[];
  /** Used when the matching startup list is missing or empty (`browse_root`, else `/`). */
  browseRoot?: string;
  allowedRoots?: () => readonly string[];
  maxEntries?: number;
}

/** `PurePath` join that keeps `..` and drops `.`, the way `parent / name` prints. */
function pathlibChild(parent: string, name: string): string {
  if (!WINDOWS) {
    const absolute = name.startsWith("/") && !name.startsWith("//");
    return purePosix(absolute ? name : `${parent}${parent.endsWith("/") ? "" : "/"}${name}`);
  }
  const text = name.replaceAll("/", "\\");
  const unc = /^\\\\[^\\]+\\[^\\]+/u.exec(text)?.[0] ?? "";
  const drive = unc || (/^[A-Za-z]:/u.exec(text)?.[0] ?? "");
  const rest = text.slice(drive.length);
  const parentDrive = /^\\\\[^\\]+\\[^\\]+/u.exec(parent)?.[0] ?? (/^[A-Za-z]:/u.exec(parent)?.[0] ?? "");
  if (rest.startsWith("\\")) return pureWin(drive || !parentDrive ? text : `${parentDrive}\\${rest.replace(/^\\+/u, "")}`);
  if (drive) return pureWin(drive.toLowerCase() === parentDrive.toLowerCase() ? `${parent}\\${rest}` : text);
  return pureWin(`${parent}\\${text}`);
}

function purePosix(raw: string): string {
  const root = raw.startsWith("//") && !raw.startsWith("///") ? "//" : raw.startsWith("/") ? "/" : "";
  const parts = raw.split("/").filter((part) => part && part !== ".");
  return root + parts.join("/") || ".";
}

function pureWin(raw: string): string {
  const text = raw.replaceAll("/", "\\");
  const unc = /^\\\\[^\\]+\\[^\\]+/u.exec(text)?.[0] ?? "";
  const drive = unc || (/^[A-Za-z]:/u.exec(text)?.[0] ?? "");
  const rest = text.slice(drive.length);
  const parts = rest.split("\\").filter((part) => part && part !== ".");
  const body = parts.join("\\");
  if (!drive && !rest.startsWith("\\") && !body) return ".";
  return drive + (rest.startsWith("\\") ? "\\" : "") + body;
}

/** `create_child`: one non-recursive child directory under a fenced parent. */
export function createChild(roots: readonly string[], path: unknown, name: unknown): string {
  const permitted = resolveRoots(roots);
  if (typeof path !== "string" || !fullyQualified(path)) {
    throw new DirectoryError(DIRECTORY_CREATE_FAILED, pyStr(path), `cannot create under "${pyStr(path)}": not a fully qualified path`);
  }
  const parent = fence(path, permitted);
  if (typeof name !== "string" || pyStrip(name) === "" || name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
    const shown = pyStr(name);
    throw new DirectoryError(DIRECTORY_CREATE_FAILED, pathlibChild(parent, shown), `"${shown}" is not a single path segment`);
  }
  const target = fence(pathlibChild(parent, name), permitted);
  try {
    mkdirSync(target);
  } catch (error) {
    if (pyExceptionName(error) === "FileExistsError") throw new DirectoryError(DIRECTORY_EXISTS, target, `${target} already exists`);
    if (!isPyOSError(error)) throw error;
    throw new DirectoryError(DIRECTORY_CREATE_FAILED, target, `cannot create ${target}: ${pyOSErrorText(error, target)}`);
  }
  return target;
}

function ignoredRootError(error: unknown): boolean {
  return isPyOSError(error) || isPyValueError(error) || isPyKeyError(error)
    || (error instanceof Error && (error.name === "RuntimeError" || error.name === "ImportError" || error.name === "ModuleNotFoundError"));
}

function startupRoots(explicit: readonly string[] | undefined, browseRoot: string | undefined, allowed?: () => readonly string[]): string[] {
  const roots = explicit && explicit.length ? [...explicit] : [browseRoot || "/"];
  if (!allowed) return roots;
  try { roots.push(...allowed()); } catch (error) { if (!ignoredRootError(error)) throw error; }
  return roots;
}

function entriesLimit(value: number | undefined): number {
  if (value === undefined || value === 0) return DEFAULT_MAX_ENTRIES;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new PyValueError("invalid literal for int() with base 10");
  return Math.trunc(value);
}

function statusFor(code: string): number {
  return code === DIRECTORY_EXISTS ? 409 : 400;
}

function failure(error: unknown): [number, { error: string; message: string }] | null {
  if (error instanceof DirectoryError) return [statusFor(error.code), { error: error.code, message: error.message }];
  return null;
}

function queryFirst(query: Record<string, unknown> | null | undefined, key: string): unknown {
  if (!query || typeof query !== "object" || !Object.hasOwn(query, key)) return null;
  const value = query[key];
  return Array.isArray(value) ? value.length ? value[0] : null : value;
}

/** `str(value).strip().lower()` truthiness used for `includeHidden` / `includeFiles`. */
function truthy(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (value == null) return false;
  return ["1", "true", "yes", "on"].includes(pyStrip(String(value)).toLowerCase());
}

export type DirectoryReply = [number, unknown];

/** Python `directory_api.dispatch`. Returns null for an unsupported verb. */
export function dispatchDirectory(method: string, parts: readonly string[], query: Record<string, unknown> | null, data: unknown, options: DirectoryHttpOptions = {}): DirectoryReply | null {
  const verb = typeof method === "string" ? method.toUpperCase() : "";
  if (parts.length === 2 && parts[0] === "api" && parts[1] === "system") {
    if (verb !== "GET") return null;
    try {
      const roots = resolveRoots(startupRoots(options.listRoots, options.browseRoot, options.allowedRoots));
      const home = realish(homedir());
      return [200, { homedir: roots.some((root) => isWithin(home, root)) ? home : roots[0]! }];
    } catch (error) {
      const failed = failure(error);
      if (failed) return failed;
      throw error;
    }
  }
  if (parts.length !== 2 || parts[0] !== "api" || parts[1] !== "directory") return null;
  if (verb === "GET") {
    const path = queryFirst(query, "path");
    try {
      return [200, listLevel(
        startupRoots(options.listRoots, options.browseRoot, options.allowedRoots),
        typeof path === "string" ? path : null,
        truthy(queryFirst(query, "includeHidden")),
        entriesLimit(options.maxEntries),
        truthy(queryFirst(query, "includeFiles")),
      )];
    } catch (error) {
      const failed = failure(error);
      if (failed) return failed;
      throw error;
    }
  }
  if (verb !== "POST") return null;
  if (!isDict(data)) return [400, { error: "invalid json body" }];
  try {
    return [200, { path: createChild(startupRoots(options.createRoots, options.browseRoot, options.allowedRoots), pyGet(data, "path"), pyGet(data, "name")) }];
  } catch (error) {
    const failed = failure(error);
    if (failed) return failed;
    throw error;
  }
}
