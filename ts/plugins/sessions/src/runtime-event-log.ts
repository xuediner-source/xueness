import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, ftruncateSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { MAX_RUNTIME_EVENTS_PAGE, XUENESS_SESSION_RUNTIME_SCHEMA, emptyRuntimeProjection, isSessionRuntimeEvent, reduceSessionRuntimeEvents, sanitizeSessionRuntimePayload, type RuntimeEventPage, type RuntimePayload, type SessionRuntimeEvent, type SessionRuntimeEventType } from "@xueness/contracts";
import { withFileLockSync } from "@xueness/sessions";

const SID = /^[0-9a-f]{32}$/;
const EPOCH = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Header = { kind: "header"; schema: typeof XUENESS_SESSION_RUNTIME_SCHEMA; sessionId: string; epoch: string; createdAt: string };
type Ledger = { header: Header; events: SessionRuntimeEvent[] };
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

function fileSignature(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile()) throw new RuntimeEventLogError("runtime event log is not a regular file");
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  } finally { closeSync(fd); }
}

function truncate(path: string, length: number): void {
  const fd = openSync(path, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
  try { ftruncateSync(fd, length); fsyncSync(fd); } finally { closeSync(fd); }
}

function parseJson(line: string, lineNumber: number): unknown {
  try { return JSON.parse(line); } catch { return corrupt(lineNumber, "invalid JSON"); }
}

function readLedger(path: string, sessionId: string): Ledger {
  let bytes: Buffer;
  try { bytes = readBytes(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error; throw error; }
  const completeEnd = bytes.length && bytes[bytes.length - 1] !== 0x0a ? bytes.lastIndexOf(0x0a) + 1 : bytes.length;
  if (completeEnd !== bytes.length) truncate(path, completeEnd);
  const complete = bytes.subarray(0, completeEnd);
  if (!complete.length) {
    const header: Header = { kind: "header", schema: XUENESS_SESSION_RUNTIME_SCHEMA, sessionId, epoch: randomUUID(), createdAt: new Date().toISOString() };
    truncate(path, 0);
    writeRecord(path, header, true);
    return { header, events: [] };
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
  return { header, events };
}

function appendBytes(path: string, value: unknown): void { writeRecord(path, value, true); }
type LedgerCache = { header: Header; head: number; signature: string };

/** Append-only JSONL ledger. The header epoch changes only when a new ledger is created. */
export class SessionRuntimeEventLog {
  readonly directory: string;
  readonly path: string;
  readonly lockPath: string;
  readonly sessionId: string;
  #cache: LedgerCache | undefined;
  constructor(stateDir: string, sessionId: string) {
    if (!SID.test(sessionId)) throw new TypeError("invalid session id");
    this.sessionId = sessionId;
    this.directory = join(stateDir, "session-events");
    this.path = join(this.directory, `${sessionId}.jsonl`);
    this.lockPath = join(this.directory, `${sessionId}.lock`);
  }
  #locked<T>(body: () => T): T { mkdirSync(this.directory, { recursive: true, mode: 0o700 }); return withFileLockSync(this.lockPath, { blocking: true, timeoutSeconds: 8 }, body); }
  #metadataLocked(): LedgerCache {
    let signature: string;
    try { signature = fileSignature(this.path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const header: Header = { kind: "header", schema: XUENESS_SESSION_RUNTIME_SCHEMA, sessionId: this.sessionId, epoch: randomUUID(), createdAt: new Date().toISOString() };
      writeRecord(this.path, header, false);
      this.#cache = { header, head: 0, signature: fileSignature(this.path) };
      return this.#cache;
    }
    if (this.#cache && this.#cache.signature === signature) return this.#cache;
    const ledger = readLedger(this.path, this.sessionId);
    this.#cache = { header: ledger.header, head: ledger.events.at(-1)?.sequenceNumber ?? 0, signature: fileSignature(this.path) };
    return this.#cache;
  }
  append(input: RuntimeEventInput): SessionRuntimeEvent {
    return this.#locked(() => {
      const state = this.#metadataLocked();
      const event: SessionRuntimeEvent = {
        schema: XUENESS_SESSION_RUNTIME_SCHEMA, id: randomUUID(), sessionId: this.sessionId,
        ...(input.turnId ? { turnId: input.turnId } : {}), ...(input.traceId ? { traceId: input.traceId } : {}),
        type: input.type, timestamp: input.timestamp ?? new Date().toISOString(), sequenceNumber: state.head + 1,
        payload: sanitizeSessionRuntimePayload(input.type, input.payload ?? {}),
      };
      if (!isSessionRuntimeEvent(event)) throw new TypeError("invalid runtime event input");
      appendBytes(this.path, event);
      this.#cache = { header: state.header, head: event.sequenceNumber, signature: fileSignature(this.path) };
      return event;
    });
  }
  readPage(cursor: RuntimeEventCursor = {}): RuntimeEventPage {
    const after = cursor.after ?? 0, limit = cursor.limit ?? 200;
    if (!Number.isSafeInteger(after) || after < 0) throw new TypeError("after must be a non-negative integer");
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RUNTIME_EVENTS_PAGE) throw new TypeError("limit must be between 1 and 500");
    return this.#locked(() => {
      let ledger: Ledger;
      try { ledger = readLedger(this.path, this.sessionId); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        ledger = { header: { kind: "header", schema: XUENESS_SESSION_RUNTIME_SCHEMA, sessionId: this.sessionId, epoch: randomUUID(), createdAt: new Date().toISOString() }, events: [] };
        writeRecord(this.path, ledger.header, false);
      }
      this.#cache = { header: ledger.header, head: ledger.events.at(-1)?.sequenceNumber ?? 0, signature: fileSignature(this.path) };
      if (cursor.epoch !== undefined && cursor.epoch !== ledger.header.epoch) throw new RuntimeEventConflict("runtime event epoch changed");
      const head = ledger.events.at(-1)?.sequenceNumber ?? 0;
      if (after > head) throw new RuntimeEventConflict("runtime event cursor is ahead of the log head");
      const events = ledger.events.filter((event) => event.sequenceNumber > after).slice(0, limit);
      const next = events.at(-1)?.sequenceNumber ?? after;
      const snapshot = reduceSessionRuntimeEvents(ledger.events.filter((event) => event.sequenceNumber <= after), emptyRuntimeProjection(this.sessionId));
      return { schema: XUENESS_SESSION_RUNTIME_SCHEMA, sessionId: this.sessionId, epoch: ledger.header.epoch, head, events, next, hasMore: next < head, snapshot };
    });
  }
  metadata(): { epoch: string; lastSequenceNumber: number } {
    return this.#locked(() => { const state = this.#metadataLocked(); return { epoch: state.header.epoch, lastSequenceNumber: state.head }; });
  }
}

export function createSessionRuntimeEventLog(stateDir: string, sessionId: string): SessionRuntimeEventLog { return new SessionRuntimeEventLog(stateDir, sessionId); }
