/** `bots.json`: symlink refusal, 100000-byte cap, `_validate` / `_load` / save. */
import { randomBytes } from "node:crypto";
import { closeSync, constants, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDict, isPyIntValue, pyEncodeUtf8, pyJsonDumps, pyJsonLoadsBytes, pyLen, PyValueError, pyStr } from "@xueness/contracts";
import type { FileLockProvider } from "@xueness/sessions";

const CHANNEL_FIELDS = new Set(["id", "kind", "tokenEnv", "root", "allowedChats"]);
const INBOX_FIELDS = ["key", "channel", "chatId", "sessionId"];
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,100}$/;
const CHAT = /^-?[0-9]{1,20}$/;
const STATE_CAP = 100_000;
const queues = new Map<string, Promise<void>>();

export interface BotState { channels: Record<string, unknown>[]; inbox: Record<string, unknown>[] }

/** `re.fullmatch`: `$` must not accept a trailing newline. */
export function fullMatch(pattern: RegExp, text: string): boolean {
  const match = pattern.exec(text);
  return match !== null && match.index === 0 && match[0].length === text.length;
}

/** `Path.resolve()` non-strict: real path of the deepest existing ancestor. */
export function pyResolve(path: string): string {
  const missing: string[] = [];
  let current = resolve(path);
  for (;;) {
    try {
      const real = lstatReal(current);
      return missing.length ? join(real, ...missing.reverse()) : real;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      missing.push(basename(current));
      current = parent;
    }
  }
}

const lstatReal = (path: string): string => realpathSync.native(path);

/** `PurePath.is_relative_to` (case-folded on Windows by `path.relative`). */
export function isRelativeTo(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function isSymlink(path: string): boolean {
  try { return lstatSync(path).isSymbolicLink(); } catch { return false; }
}

function isDirectory(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

function botsFile(stateDir: string): string {
  const path = join(stateDir, "bots.json");
  if (isSymlink(path)) throw new PyValueError("bot configuration cannot be a symlink");
  return path;
}

function readCapped(path: string): Buffer {
  const fd = openSync(path, constants.O_RDONLY);
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    const block = Buffer.allocUnsafe(65536);
    for (;;) {
      const count = readSync(fd, block, 0, block.length, null);
      if (count <= 0) break;
      total += count;
      if (total > STATE_CAP) throw new PyValueError("bot state too large");
      chunks.push(Buffer.from(block.subarray(0, count)));
    }
  } finally { try { closeSync(fd); } catch { /* the read error is the one that matters */ } }
  return Buffer.concat(chunks);
}

function negative(offset: number | bigint): boolean {
  return typeof offset === "bigint" ? offset < 0n : offset < 0;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const present = Object.keys(value);
  return present.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/** `_validate`: kind, id, token env name, existing workspace, explicit chat ids. */
export function validateChannel(data: unknown): Record<string, unknown> {
  if (!isDict(data) || Object.keys(data).some((key) => !CHANNEL_FIELDS.has(key))) throw new PyValueError("invalid channel fields");
  if (data.kind !== "telegram" || typeof data.id !== "string" || !fullMatch(ID, data.id)) throw new PyValueError("invalid channel");
  if (typeof data.tokenEnv !== "string" || !fullMatch(ENV_NAME, data.tokenEnv)) throw new PyValueError("token environment name required");
  if (typeof data.root !== "string" || data.root.length === 0) throw new PyValueError("channel workspace required");
  const root = pyResolve(data.root);
  if (!isDirectory(root)) throw new PyValueError("channel workspace required");
  const chats = data.allowedChats;
  if (!Array.isArray(chats) || chats.length < 1 || chats.length > 100 || chats.some((item) => !fullMatch(CHAT, pyStr(item)))) {
    throw new PyValueError("explicit allowed chat ids required");
  }
  return { ...data, root, allowedChats: chats.map((item) => pyStr(item)) };
}

/** `_load`. Missing file is an empty inbox; every other refusal propagates. */
export function loadState(stateDir: string): BotState {
  const path = botsFile(stateDir);
  let raw: Buffer;
  try { raw = readCapped(path); }
  catch (error) {
    if (error instanceof PyValueError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { channels: [], inbox: [] };
    throw error;
  }
  const row = pyJsonLoadsBytes(raw, { lossless: true });
  if (!isDict(row) || Object.keys(row).some((key) => key !== "channels" && key !== "inbox")) throw new PyValueError("invalid bot state");
  const channels = row.channels;
  const inbox = row.inbox;
  if (!Array.isArray(channels) || channels.length > 100 || !Array.isArray(inbox) || inbox.length > 200) throw new PyValueError("invalid bot state");
  const ids = new Set<string>();
  for (const channel of channels) {
    if (!isDict(channel)) throw new PyValueError("invalid bot state");
    const offset = Object.hasOwn(channel, "offset") ? channel.offset : 0;
    if (!isPyIntValue(offset) || negative(offset)) throw new PyValueError("invalid bot offset");
    const fields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(channel)) if (key !== "offset") fields[key] = value;
    const clean = validateChannel(fields);
    const id = String(clean.id);
    if (ids.has(id)) throw new PyValueError("duplicate bot channel");
    ids.add(id);
  }
  for (const item of inbox) {
    if (!isDict(item) || !exactKeys(item, INBOX_FIELDS) || Object.values(item).some((value) => typeof value !== "string" || pyLen(value) > 128)) {
      throw new PyValueError("invalid bot inbox");
    }
  }
  return row as unknown as BotState;
}

function replaceFile(source: string, destination: string): void {
  const deadline = performance.now() + 500;
  for (;;) {
    try { renameSync(source, destination); return; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (process.platform !== "win32" || !["EPERM", "EBUSY", "EACCES"].includes(code) || performance.now() >= deadline) throw error;
      const until = performance.now() + 10;
      while (performance.now() < until) { /* same half-second budget as Python */ }
    }
  }
}

function fsyncDirectory(directory: string): void {
  let fd: number;
  try { fd = openSync(directory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0)); }
  catch { return; }
  try { fsyncSync(fd); } catch { /* some file systems refuse directory fsync */ } finally { closeSync(fd); }
}

/** `_atomic_write_json`: private temp in the same directory, fsync, replace. */
export function writeState(stateDir: string, state: BotState): void {
  const destination = botsFile(stateDir);
  const directory = dirname(destination);
  mkdirSync(directory, { recursive: true });
  const bytes = pyEncodeUtf8(pyJsonDumps(state, { ensureAscii: false, indent: 2 }));
  const temporary = join(directory, `.resource-${randomBytes(8).toString("hex")}`);
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    try { fchmodSync(fd, 0o600); } catch { /* Windows ACL is best-effort */ }
    for (let at = 0; at < bytes.length;) {
      const wrote = writeSync(fd, bytes, at, bytes.length - at);
      if (wrote <= 0) throw Object.assign(new Error("bot state write made no progress"), { name: "OSError", code: "EIO", syscall: "write" });
      at += wrote;
    }
    fsyncSync(fd);
  } catch (error) {
    try { closeSync(fd); } catch { /* keep the write error */ }
    try { unlinkSync(temporary); } catch { /* keep the write error */ }
    throw error;
  }
  closeSync(fd);
  try { replaceFile(temporary, destination); }
  finally {
    try { unlinkSync(temporary); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  fsyncDirectory(directory);
}

function lockKey(stateDir: string): string {
  const full = resolve(stateDir);
  return process.platform === "win32" ? full.toLowerCase() : full;
}

/**
 * `_config_lock`: callers in this process queue; with the host's native lock
 * provider the shared `.plugin-state.lock` also excludes Python CLI writers.
 */
export async function withConfigLock<T>(stateDir: string, body: () => Promise<T> | T, locks?: FileLockProvider): Promise<T> {
  const key = lockKey(stateDir);
  const previous = queues.get(key) ?? Promise.resolve();
  let release: () => void = () => {};
  const gate = new Promise<void>((done) => { release = done; });
  const tail = previous.then(() => gate);
  queues.set(key, tail.then(() => {}, () => {}));
  await previous.catch(() => {});
  try {
    const handle = locks ? await locks.acquire(stateDir, ".plugin-state.lock", 30) : null;
    try { return await body(); } finally { handle?.release(); }
  } finally { release(); }
}

/** POST save. Replaces the same id and drops its offset. Jail runs before the lock. */
export async function saveChannel(stateDir: string, data: unknown, createRoots: readonly string[] = [], locks?: FileLockProvider): Promise<Record<string, unknown>> {
  const row = validateChannel(data);
  if (createRoots.length > 0 && !createRoots.some((root) => isRelativeTo(String(row.root), pyResolve(root)))) {
    throw new PyValueError("channel workspace denied");
  }
  await withConfigLock(stateDir, () => {
    const state = loadState(stateDir);
    state.channels = state.channels.filter((item) => item.id !== row.id);
    state.channels.push(row);
    writeState(stateDir, state);
  }, locks);
  return row;
}
