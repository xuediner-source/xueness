/**
 * Append-only, hash-chained revisions next to the JSON snapshot
 * (`sessions/history.py`, schema `xueness.session-history.v1`).
 *
 * Every saved revision appends one line to `<sid>.history.jsonl`:
 * `{schema, seq, sessionId, timestamp, parentHash, stateHash, reset,
 * operations, recordHash}`. `stateHash` is the digest of the session without
 * `history_revision` / `history_hash`; `recordHash` signs the rest of the
 * line; `parentHash` links the chain. A missing publication (the snapshot
 * moved on without a line) is repaired with a `reset` record holding the
 * whole state, and only a torn final line is ignored.
 *
 * The format, digests and validation match Python, so either backend can
 * extend a log the other wrote. Python orders `delete` operations by hash;
 * this port uses key order (equivalent on replay).
 */
import { closeSync, constants, fstatSync, ftruncateSync, fsyncSync, openSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  isDict, isPyIntValue, pyDecodeUtf8, pyDeepCopy, pyDictGet, pyEncodeUtf8, pyEquals, pyJsonDumps, pyJsonLoads,
  PyAttributeError, pyTypeName, pyUtcNow, PyValueError, setOwn,
} from "@xueness/contracts";
import { apply, compareInts, difference, digest, getItem, normalizeInt, type HistoryOperation } from "./history-ops.ts";
import { exists, isLink, protectPrivateFile, readAll, writeAll } from "./journal-fs.ts";

export const SCHEMA = "xueness.session-history.v1";
export const MAX_LINE_BYTES = 32 * 1024 * 1024;
export const META: ReadonlySet<string> = new Set(["history_revision", "history_hash"]);

export type HistoryRecord = Record<string, unknown> & { seq: number | bigint; recordHash: string; stateHash: string };

/** What history needs from the store: id validation and the journal directory. */
export interface HistoryHost {
  readonly directory: string;
  pathFor(sid: string): string;
}

export interface HistoryToken {
  path: string;
  row: Record<string, unknown>;
  value: Record<string, unknown>;
  records: HistoryRecord[];
  goodSize: number;
}

interface Snapshot {
  state: unknown;
  records: HistoryRecord[];
  size: number;
}

const CACHE = new Map<string, Snapshot & { signature: string | null }>();
const listeners = new Set<() => void>();

/** The session without history metadata (`content`). */
export function content(session: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(session)) if (!META.has(key)) setOwn(out, key, session[key]);
  return out;
}

/** `_path`: `<directory>/<sid>.history.jsonl`, refusing links. */
export function historyPath(host: HistoryHost, sid: string): string {
  host.pathFor(sid);
  const path = join(host.directory, sid + ".history.jsonl");
  if (isLink(path)) throw new PyValueError("session history is a symbolic link or reparse point");
  return path;
}

function rowItems(row: unknown): Record<string, unknown> {
  if (!isDict(row)) throw new PyAttributeError(`'${pyTypeName(row)}' object has no attribute 'items'`);
  return row;
}

/** `_scan`: replay and validate every complete line. */
export function scan(path: string): Snapshot {
  let state: unknown = {};
  const records: HistoryRecord[] = [];
  let size = 0;
  if (!exists(path)) return { state, records, size };
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let data: Buffer;
  try {
    if (!fstatSync(fd).isFile()) throw new PyValueError("session history is not a regular file");
    data = readAll(fd);
  } finally {
    closeSync(fd);
  }
  let offset = 0;
  while (offset < data.length) {
    const newline = data.indexOf(0x0a, offset);
    if (newline < 0) break; // only a torn final publication may be repaired
    const raw = data.subarray(offset, newline + 1);
    if (raw.length > MAX_LINE_BYTES) throw new PyValueError("session history record is too large");
    const row = rowItems(pyJsonLoads(pyDecodeUtf8(raw), { lossless: true }));
    const previous = records.length ? records[records.length - 1]! : null;
    const unsigned: Record<string, unknown> = {};
    for (const key of Object.keys(row)) if (key !== "recordHash") setOwn(unsigned, key, row[key]);
    const seq = pyDictGet(row, "seq");
    if (!pyEquals(pyDictGet(row, "schema"), SCHEMA) || !isPyIntValue(seq) || compareInts(seq, 1) < 0
      || !pyEquals(pyDictGet(row, "recordHash"), digest(unsigned))
      || !pyEquals(pyDictGet(row, "parentHash"), previous ? previous.recordHash : "")
      || (previous !== null && compareInts(seq, previous.seq) <= 0)) {
      throw new PyValueError("session history chain is invalid");
    }
    state = apply(state, getItem(row, "operations"));
    if (digest(state) !== getItem(row, "stateHash")) throw new PyValueError("session history state is invalid");
    records.push(row as HistoryRecord);
    size += raw.length;
    offset = newline + 1;
  }
  return { state, records, size };
}

/** `_signature`: size, mtime, ctime and inode, or null when missing. */
function signature(path: string): string | null {
  if (!exists(path)) return null;
  const info = statSync(path, { bigint: true });
  return `${info.size}:${info.mtimeNs}:${info.ctimeNs}:${info.ino}`;
}

/** `_current`: the cached replay while the file signature is unchanged. */
export function current(path: string): Snapshot {
  const stamp = signature(path);
  const cached = CACHE.get(path);
  if (cached && cached.signature === stamp) return cached;
  const snapshot = scan(path);
  if (CACHE.size > 128) CACHE.clear();
  CACHE.set(path, { ...snapshot, signature: stamp });
  return snapshot;
}

function encodeRow(row: Record<string, unknown>): string {
  return pyJsonDumps(row, { separators: [",", ":"] });
}

/**
 * `prepare`: stage the next revision before the snapshot is published. The
 * caller holds the journal lock. Returns null when nothing changed.
 */
export function prepare(host: HistoryHost, session: Record<string, unknown>): HistoryToken | null {
  const sid = getItem(session, "id") as string;
  const path = historyPath(host, sid);
  const { state: previous, records, size: goodSize } = current(path);
  const value = content(session);
  const stateHash = digest(value);
  const last = records.length ? records[records.length - 1]! : null;
  if (last && last.stateHash === stateHash) {
    setOwn(session, "history_revision", last.seq);
    setOwn(session, "history_hash", stateHash);
    return null;
  }
  const raw = Object.hasOwn(session, "history_revision") ? session.history_revision : 0;
  const claimed = isPyIntValue(raw) && compareInts(raw, 0) >= 0 ? raw : 0;
  const lastSeq = last ? last.seq : 0;
  const seq = normalizeInt(BigInt(compareInts(lastSeq, claimed) >= 0 ? lastSeq : claimed) + 1n);
  const reset = !records.length || compareInts(claimed, lastSeq) !== 0;
  const operations: HistoryOperation[] = reset ? [{ op: "set", path: [], value: pyDeepCopy(value) }] : difference(previous, value);
  const row: Record<string, unknown> = {
    schema: SCHEMA, seq, sessionId: sid, timestamp: pyUtcNow(), parentHash: last ? last.recordHash : "",
    stateHash, reset, operations,
  };
  row.recordHash = digest(row);
  if (pyEncodeUtf8(encodeRow(row)).length + 1 > MAX_LINE_BYTES) throw new PyValueError("session history record is too large");
  setOwn(session, "history_revision", seq);
  setOwn(session, "history_hash", stateHash);
  return { path, row, value: pyDeepCopy(value), records, goodSize };
}

/** `commit`: append the staged line after the snapshot was published. */
export function commit(token: HistoryToken | null): void {
  if (token === null) return;
  const { path, row, value, records, goodSize } = token;
  const raw = pyEncodeUtf8(encodeRow(row) + "\n");
  if (raw.length > MAX_LINE_BYTES) throw new PyValueError("session history record is too large");
  const fd = openSync(path, constants.O_RDWR | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    if (!fstatSync(fd).isFile() || isLink(path)) throw new PyValueError("session history is not a regular file");
    protectPrivateFile(fd);
    ftruncateSync(fd, goodSize);
    writeAll(fd, raw, goodSize);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  CACHE.set(path, { state: value, records: [...records, row as HistoryRecord], size: goodSize + raw.length, signature: signature(path) });
  for (const listener of [...listeners]) listener();
}

/** Subscribe to history publications in this process (`_CHANGED.notify_all`). */
export function onHistoryChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** `wait`: resolve on the next publication or after `timeoutMs`. */
export function waitForHistory(timeoutMs = 250): Promise<void> {
  return new Promise((resolve) => {
    const stop = onHistoryChanged(() => {
      clearTimeout(timer);
      stop();
      resolve();
    });
    const timer = setTimeout(() => {
      stop();
      resolve();
    }, timeoutMs);
  });
}

/** Drop cached replays (tests and external rewrites). */
export function clearHistoryCache(): void {
  CACHE.clear();
}
