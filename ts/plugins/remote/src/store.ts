/**
 * Named SSH connection store. Field rules follow `_validate`, `_load`,
 * `_digest`, `_ssh_argv` and `_ssh_env` in `bundled_plugins/remote/plugin.py`.
 * Defaults are materialized on the returned object; the stored and hashed record keeps
 * only the keys Python would keep, so digests match rows saved by either backend.
 */
import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isDict, isPyIntValue, pyEncodeUtf8, pyJsonDumps, pyJsonLoadsBytes, pyLen, PyValueError } from "@xueness/contracts";

export interface RemoteConnection {
  id: string;
  host: string;
  user: string;
  port: number;
  directory: string;
  system: "posix" | "windows";
}

export const WINDOWS_REMOTE_ERROR =
  "remote Windows hosts are not supported (system=windows): commands are quoted for a POSIX shell and cannot be run safely on cmd or PowerShell";

const FILE_NAME = "remote-connections.json";
const MAX_BYTES = 100_000;
const MAX_ROWS = 100;
const FIELDS = new Set(["id", "host", "user", "port", "directory", "system"]);
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}/;
const HOST_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}/;
const USER_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]{0,63}/;
const SECRET_KEY = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i;
/** `os.devnull` is `nul` on Windows, not `NUL`. */
const SSH_DEVNULL = process.platform === "win32" ? "nul" : "/dev/null";
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const NONBLOCK = constants.O_NONBLOCK ?? 0;
const SHARING = new Set(["EPERM", "EBUSY", "EACCES"]);

function fail(message: string): never {
  throw new PyValueError(message);
}

function codeOf(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

/** Python `re.fullmatch`. `$` is not used: it would accept a trailing newline. */
function fullMatch(pattern: RegExp, value: string): boolean {
  const found = pattern.exec(value);
  return found?.[0]?.length === value.length;
}

function token(row: Record<string, unknown>, key: "id" | "host" | "user", pattern: RegExp): string {
  const value = Object.hasOwn(row, key) ? row[key] : undefined;
  if (typeof value !== "string" || !fullMatch(pattern, value)) fail(`invalid remote ${key}`);
  return value;
}

function portOf(row: Record<string, unknown>): number {
  const value = Object.hasOwn(row, "port") ? row.port : 22;
  const port = typeof value === "bigint" ? Number(value) : value;
  if (!isPyIntValue(value) || typeof port !== "number" || !Number.isSafeInteger(port) || port < 1 || port > 65535) fail("invalid remote port");
  return port;
}

function directoryOf(row: Record<string, unknown>): string {
  const value = Object.hasOwn(row, "directory") ? row.directory : ".";
  if (typeof value !== "string" || pyLen(value) > 1000 || value.includes("\0")) fail("invalid remote directory");
  return value;
}

function systemOf(row: Record<string, unknown>): "posix" | "windows" {
  const value = Object.hasOwn(row, "system") ? row.system : "posix";
  if (value !== "posix" && value !== "windows") fail("invalid remote system");
  return value;
}

/** The validated object exactly as received or stored: Python keeps omitted keys absent. */
const SOURCES = new WeakMap<RemoteConnection, Record<string, unknown>>();

/**
 * `_validate`. Missing port, directory and system read as 22, "." and "posix";
 * the stored and hashed record keeps only the keys that were present.
 */
export function validateConnection(row: unknown, _opts?: { systemMentioned?: boolean }): RemoteConnection {
  if (!isDict(row) || Object.keys(row).some((key) => !FIELDS.has(key))) fail("invalid remote fields");
  const checked: RemoteConnection = {
    id: token(row, "id", ID_PATTERN),
    host: token(row, "host", HOST_PATTERN),
    user: token(row, "user", USER_PATTERN),
    port: portOf(row),
    directory: directoryOf(row),
    system: systemOf(row),
  };
  SOURCES.set(checked, { ...row });
  return checked;
}

/** `_keep_saved_system`: keep a stored `system` when this save does not mention the field. */
export function keepSavedSystem(row: RemoteConnection, previous: RemoteConnection | undefined, systemMentioned: boolean): RemoteConnection {
  const source = persisted(row);
  if (systemMentioned || Object.hasOwn(source, "system") || previous === undefined || !Object.hasOwn(persisted(previous), "system")) return row;
  const kept: RemoteConnection = { ...row, system: previous.system };
  SOURCES.set(kept, { ...source, system: persisted(previous).system });
  return kept;
}

/** The record Python stores, returns and hashes for this connection. */
export function persisted(row: RemoteConnection): Record<string, unknown> {
  return SOURCES.get(row) ?? { id: row.id, host: row.host, user: row.user, port: row.port, directory: row.directory, system: row.system };
}

/**
 * `_digest`: sha256 of `json.dumps(row, sort_keys=True, separators=(',', ':'))`.
 * `ensure_ascii` stays at Python's default, so non-ASCII directories use `\\u` escapes.
 * Only the stored keys are hashed.
 */
export function digest(row: RemoteConnection): string {
  const canonical = pyJsonDumps(persisted(row), { sortKeys: true, separators: [",", ":"], ensureAscii: true });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** `_require_posix_remote`. Windows is refused before a POSIX-quoted command is built. */
export function posixOrThrow(row: RemoteConnection): void {
  if (row.system === "windows") fail(WINDOWS_REMOTE_ERROR);
  if (row.system !== "posix") fail("invalid remote system");
}

/** `_ssh_argv`, including `-F` pointed at `os.devnull`. */
export function sshArgv(row: RemoteConnection, remoteCommand: string): string[] {
  return [
    "ssh", "-F", SSH_DEVNULL, "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
    "-o", "ConnectTimeout=10", "-p", String(row.port), `${row.user}@${row.host}`, remoteCommand,
  ];
}

/** `_ssh_env`: drop any key containing KEY, TOKEN, SECRET, PASSWORD or CREDENTIAL. */
export function sshEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(env)) {
    const value = env[key];
    if (typeof value !== "string" || SECRET_KEY.test(key)) continue;
    out[key] = value;
  }
  return out;
}

function connectionsPath(stateDir: string): string {
  return join(resolve(stateDir), FILE_NAME);
}

function refuseSymlink(path: string): void {
  try {
    if (lstatSync(path).isSymbolicLink()) fail("remote state symlink denied");
  } catch (error) {
    if (codeOf(error) !== "ENOENT") throw error;
  }
}

/** Read at most 100001 bytes, the same cap `_load` uses before parsing. */
function readBounded(path: string): Buffer {
  const fd = openSync(path, constants.O_RDONLY | NOFOLLOW | NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) fail("remote state must be a regular file");
    const chunks: Buffer[] = [];
    let size = 0;
    while (size <= MAX_BYTES) {
      const block = Buffer.alloc(Math.min(65536, MAX_BYTES + 1 - size));
      const count = readSync(fd, block, 0, block.length, null);
      if (count === 0) break;
      chunks.push(block.subarray(0, count));
      size += count;
    }
    if (size > MAX_BYTES) fail("remote configuration too large");
    return Buffer.concat(chunks);
  } finally {
    closeSync(fd);
  }
}

/** `_load`. A missing file is `[]`. Symlinks, non-files, size, shape and duplicate ids are refused. */
export function loadConnections(stateDir: string): RemoteConnection[] {
  const path = connectionsPath(stateDir);
  let info;
  try {
    info = lstatSync(path);
  } catch (error) {
    if (codeOf(error) === "ENOENT") return [];
    throw error;
  }
  if (info.isSymbolicLink()) fail("remote state symlink denied");
  if (!info.isFile()) fail("remote state must be a regular file");
  let raw: Buffer;
  try {
    raw = readBounded(path);
  } catch (error) {
    if (codeOf(error) === "ENOENT") return [];
    throw error;
  }
  const parsed = pyJsonLoadsBytes(raw, { lossless: true, errorDialect: "3.11" });
  if (!Array.isArray(parsed) || parsed.length > MAX_ROWS) fail("invalid remote configuration");
  const rows = parsed.map((item) => validateConnection(item));
  const ids = new Set<string>();
  for (const row of rows) {
    if (ids.has(row.id)) fail("duplicate remote connection id");
    ids.add(row.id);
  }
  return rows;
}

function writeAll(fd: number, bytes: Buffer): void {
  for (let at = 0; at < bytes.length;) at += writeSync(fd, bytes, at, bytes.length - at);
}

function discard(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (codeOf(error) !== "ENOENT") throw error;
  }
}

function makeTemp(directory: string): { fd: number; path: string } {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const path = join(directory, `.resource-${randomBytes(4).toString("hex")}`);
    try {
      return { fd: openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600), path };
    } catch (error) {
      if (codeOf(error) !== "EEXIST") throw error;
    }
  }
  throw new Error("No usable temporary file name found");
}

/** `os.replace`, retrying brief Windows sharing collisions for half a second. */
function replaceFile(source: string, destination: string): void {
  const deadline = performance.now() + 500;
  for (;;) {
    try {
      renameSync(source, destination);
      return;
    } catch (error) {
      const code = codeOf(error) ?? "";
      if (process.platform !== "win32" || !SHARING.has(code) || performance.now() >= deadline) throw error;
      const until = performance.now() + 10;
      while (performance.now() < until) { /* same budget as resources.replace_file */ }
    }
  }
}

/** Atomic replace of `remote-connections.json`. A symlinked target is refused and left untouched. */
export function saveConnections(stateDir: string, rows: RemoteConnection[]): void {
  const path = connectionsPath(stateDir);
  refuseSymlink(path);
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true });
  const bytes = pyEncodeUtf8(pyJsonDumps(rows.map(persisted), { ensureAscii: false, indent: 2 }));
  const temp = makeTemp(parent);
  try {
    writeAll(temp.fd, bytes);
    fsyncSync(temp.fd);
  } catch (error) {
    try { closeSync(temp.fd); } catch { /* the write error is the one that matters */ }
    discard(temp.path);
    throw error;
  }
  closeSync(temp.fd);
  try {
    refuseSymlink(path);
    replaceFile(temp.path, path);
  } catch (error) {
    discard(temp.path);
    throw error;
  }
}
