import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, ftruncateSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { MAX_RUNTIME_EVENTS_PAGE, RuntimeEventHotWindow, XUENESS_SESSION_RUNTIME_SCHEMA, emptyRuntimeProjection, isSessionRuntimeEvent, reduceSessionRuntimeEvents, sanitizeSessionRuntimePayload, type RuntimeEventPage, type RuntimePayload, type SessionRuntimeEvent, type SessionRuntimeEventType } from "@xueness/contracts";
import { withFileLockSync } from "@xueness/sessions";
import { buildEventIndex, loadEventIndex, persistEventIndex, readEventSlice, type RuntimeEventIndex, type IndexedLedger } from "./runtime-event-index.ts";

const SID = /^[0-9a-f]{32}$/;
const EPOCH = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Header = { kind: "header"; schema: typeof XUENESS_SESSION_RUNTIME_SCHEMA; sessionId: string; epoch: string; createdAt: string };
const INDEX_PERSIST_APPENDS = 64;
export interface RuntimeEventInput { type: SessionRuntimeEventType; payload?: RuntimePayload; turnId?: string; traceId?: string; timestamp?: string }
export interface RuntimeEventCursor { after?: number; epoch?: string; limit?: number }
export class RuntimeEventLogError extends Error { override name = "RuntimeEventLogError"; }
export class RuntimeEventConflict extends Error { override name = "RuntimeEventConflict"; }

function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const count = writeSync(fd, bytes, offset, bytes.length - offset, null);
    if (count <= 0) throw new Error("runtime event log write made no progress");
    offset += count;
  }
  fsyncSync(fd);
}

function writeRecord(path: string, value: unknown, append: boolean): void {
  const flags = (append ? constants.O_WRONLY | constants.O_APPEND : constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL)
    | (constants.O_NOFOLLOW ?? 0);
  const fd = openSync(path, flags, 0o600);
  try { writeAll(fd, Buffer.from(JSON.stringify(value) + "\n", "utf8")); } finally { closeSync(fd); }
}

function corrupt(line: number, reason: string): never { throw new RuntimeEventLogError(`corrupt runtime event log at line ${line}: ${reason}`); }

function readBytes(path: string): Buffer {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!fstatSync(fd).isFile()) throw new RuntimeEventLogError("runtime event log is not a regular file");
    return readFileSync(fd);
  } finally { closeSync(fd); }
}

function fileSignature(path: string): { signature: string; size: number } {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile()) throw new RuntimeEventLogError("runtime event log is not a regular file");
    return { signature: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`, size: Number(stat.size) };
  } finally { closeSync(fd); }
}

function truncate(path: string, length: number): void {
  const fd = openSync(path, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
  try { ftruncateSync(fd, length); fsyncSync(fd); } finally { closeSync(fd); }
}

function parseJson(line: string, lineNumber: number): unknown {
  try { return JSON.parse(line); } catch { return corrupt(lineNumber, "invalid JSON"); }
}

function newlinePositions(bytes: Buffer): number[] {
  const positions: number[] = [];
  for (let i = 0; i < bytes.length; i++) if (bytes[i] === 0x0a) positions.push(i);
  return positions;
}

function readLedger(path: string, sessionId: string): IndexedLedger {
  const bytes = readBytes(path);
  const completeEnd = bytes.length && bytes[bytes.length - 1] !== 0x0a ? bytes.lastIndexOf(0x0a) + 1 : bytes.length;
  if (completeEnd !== bytes.length) truncate(path, completeEnd);
  const complete = bytes.subarray(0, completeEnd);
  if (!complete.length) {
    const header: Header = { kind: "header", schema: XUENESS_SESSION_RUNTIME_SCHEMA, sessionId, epoch: randomUUID(), createdAt: new Date().toISOString() };
    truncate(path, 0);
    writeRecord(path, header, true);
    return { header, events: [], newlines: newlinePositions(Buffer.from(JSON.stringify(header) + "\n", "utf8")) };
  }
  let decoded: string;
  try { decoded = new TextDecoder("utf-8", { fatal: true }).decode(complete); } catch { return corrupt(1, "invalid UTF-8"); }
  const lines = decoded.slice(0, -1).split("\n");
  const rawHeader = parseJson(lines[0]!, 1) as Partial<Header>;
  if (rawHeader?.kind !== "header" || rawHeader.schema !== XUENESS_SESSION_RUNTIME_SCHEMA || rawHeader.sessionId !== sessionId
    || typeof rawHeader.epoch !== "string" || !EPOCH.test(rawHeader.epoch) || typeof rawHeader.createdAt !== "string" || !Number.isFinite(Date.parse(rawHeader.createdAt))) corrupt(1, "invalid header");
  const header = rawHeader as Header, events: SessionRuntimeEvent[] = [];
  let expected = 1;
  for (let i = 1; i < lines.length; i++) {
    const value = parseJson(lines[i]!, i + 1);
    if (!isSessionRuntimeEvent(value) || value.sessionId !== sessionId || value.sequenceNumber !== expected) corrupt(i + 1, "invalid event or sequence");
    events.push(value); expected++;
  }
  return { header, events, newlines: newlinePositions(complete) };
}

/**
 * Append-only JSONL ledger with a persisted byte-offset index and a transient hot
 * turn-window. Durable history pages seek through the index; the hot window only
 * serves live tails and never gates what the ledger retains.
 */
export class SessionRuntimeEventLog {
  readonly directory: string;
  readonly path: string;
  readonly lockPath: string;
  readonly indexPath: string;
  readonly sessionId: string;
  readonly hot: RuntimeEventHotWindow;
  #index: RuntimeEventIndex | undefined;
  #dirtyAppends = 0;
  #fullScans = 0;
  constructor(stateDir: string, sessionId: string, hot: RuntimeEventHotWindow = new RuntimeEventHotWindow()) {
    if (!SID.test(sessionId)) throw new TypeError("invalid session id");
    this.sessionId = sessionId;
    this.directory = join(stateDir, "session-events");
    this.path = join(this.directory, `${sessionId}.jsonl`);
    this.indexPath = join(this.directory, `${sessionId}.idx.json`);
    this.lockPath = join(this.directory, `${sessionId}.lock`);
    this.hot = hot;
  }
  #locked<T>(body: () => T): T { mkdirSync(this.directory, { recursive: true, mode: 0o700 }); return withFileLockSync(this.lockPath, { blocking: true, timeoutSeconds: 8 }, body); }
  /** Number of full-ledger scans this instance performed; indexed paging keeps this flat. */
  get fullScans(): number { return this.#fullScans; }
  #rebuildLocked(): RuntimeEventIndex {
    this.#fullScans++;
    const ledger = readLedger(this.path, this.sessionId);
    const index = buildEventIndex(ledger, fileSignature(this.path).signature);
    persistEventIndex(this.indexPath, index);
    this.#index = index;
    this.#dirtyAppends = 0;
    return index;
  }
  #indexLocked(): RuntimeEventIndex {
    let current: { signature: string; size: number };
    try { current = fileSignature(this.path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const header: Header = { kind: "header", schema: XUENESS_SESSION_RUNTIME_SCHEMA, sessionId: this.sessionId, epoch: randomUUID(), createdAt: new Date().toISOString() };
      writeRecord(this.path, header, false);
      const index: RuntimeEventIndex = { schema: 1, epoch: header.epoch, signature: fileSignature(this.path).signature, headerEnd: Buffer.byteLength(JSON.stringify(header) + "\n"), offsets: [], checkpoints: [] };
      persistEventIndex(this.indexPath, index);
      this.#index = index;
      return index;
    }
    if (this.#index && this.#index.signature === current.signature) return this.#index;
    const loaded = loadEventIndex(this.indexPath, this.sessionId, current.signature, current.size);
    if (loaded) { this.#index = loaded; return loaded; }
    return this.#rebuildLocked();
  }
  /** Publish an in-memory index dirtied by local appends so cold readers can seek without a scan. */
  #flushLocked(): void { if (this.#dirtyAppends > 0 && this.#index) { persistEventIndex(this.indexPath, this.#index); this.#dirtyAppends = 0; } }
  append(input: RuntimeEventInput): SessionRuntimeEvent {
    return this.#locked(() => {
      const index = this.#indexLocked();
      const event: SessionRuntimeEvent = {
        schema: XUENESS_SESSION_RUNTIME_SCHEMA, id: randomUUID(), sessionId: this.sessionId,
        ...(input.turnId ? { turnId: input.turnId } : {}), ...(input.traceId ? { traceId: input.traceId } : {}),
        type: input.type, timestamp: input.timestamp ?? new Date().toISOString(), sequenceNumber: index.offsets.length + 1,
        payload: sanitizeSessionRuntimePayload(input.type, input.payload ?? {}),
      };
      if (!isSessionRuntimeEvent(event)) throw new TypeError("invalid runtime event input");
      writeRecord(this.path, event, true);
      const end = (index.offsets.at(-1) ?? index.headerEnd) + Buffer.byteLength(JSON.stringify(event) + "\n", "utf8");
      index.offsets.push(end);
      index.signature = fileSignature(this.path).signature;
      if (++this.#dirtyAppends >= INDEX_PERSIST_APPENDS) { persistEventIndex(this.indexPath, index); this.#dirtyAppends = 0; }
      this.hot.admit(event);
      return event;
    });
  }
  readPage(cursor: RuntimeEventCursor = {}): RuntimeEventPage {
    const after = cursor.after ?? 0, limit = cursor.limit ?? 200;
    if (!Number.isSafeInteger(after) || after < 0) throw new TypeError("after must be a non-negative integer");
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RUNTIME_EVENTS_PAGE) throw new TypeError("limit must be between 1 and 500");
    return this.#locked(() => {
      const index = this.#indexLocked();
      this.#flushLocked();
      if (cursor.epoch !== undefined && cursor.epoch !== index.epoch) throw new RuntimeEventConflict("runtime event epoch changed");
      const head = index.offsets.length;
      if (after > head) throw new RuntimeEventConflict("runtime event cursor is ahead of the log head");
      const events = readEventSlice(this.path, index, this.sessionId, after + 1, Math.min(after + limit, head));
      const checkpoint = index.checkpoints.findLast((row) => row.sequenceNumber <= after);
      const snapshot = reduceSessionRuntimeEvents(
        readEventSlice(this.path, index, this.sessionId, checkpoint ? checkpoint.sequenceNumber + 1 : 1, after),
        checkpoint ? checkpoint.projection : emptyRuntimeProjection(this.sessionId),
      );
      const next = events.at(-1)?.sequenceNumber ?? after;
      return { schema: XUENESS_SESSION_RUNTIME_SCHEMA, sessionId: this.sessionId, epoch: index.epoch, head, events, next, hasMore: next < head, snapshot };
    });
  }
  /** Live tail from the hot window only; null when retention has evicted past the cursor. */
  readTail(after = 0, limit = MAX_RUNTIME_EVENTS_PAGE): SessionRuntimeEvent[] | null {
    if (!Number.isSafeInteger(after) || after < 0) throw new TypeError("after must be a non-negative integer");
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RUNTIME_EVENTS_PAGE) throw new TypeError("limit must be between 1 and 500");
    return this.hot.tail(after, limit);
  }
  metadata(): { epoch: string; lastSequenceNumber: number } {
    return this.#locked(() => { const index = this.#indexLocked(); this.#flushLocked(); return { epoch: index.epoch, lastSequenceNumber: index.offsets.length }; });
  }
}

export function createSessionRuntimeEventLog(stateDir: string, sessionId: string): SessionRuntimeEventLog { return new SessionRuntimeEventLog(stateDir, sessionId); }
