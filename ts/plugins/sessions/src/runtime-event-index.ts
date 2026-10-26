/** Persistent byte-offset index over the runtime event JSONL: page reads seek instead of rescanning. */
import { closeSync, constants, openSync, readSync, writeSync } from "node:fs";
import { XUENESS_SESSION_RUNTIME_SCHEMA, emptyRuntimeProjection, isSessionRuntimeEvent, reduceSessionRuntimeEvents, type SessionRuntimeEvent, type SessionRuntimeProjection } from "@xueness/contracts";

export const RUNTIME_INDEX_SCHEMA = 1;
export const RUNTIME_INDEX_CHECKPOINT_INTERVAL = 512;
export const RUNTIME_INDEX_MAX_CHECKPOINTS = 8;
export const RUNTIME_INDEX_MAX_BYTES = 8 * 1024 * 1024;
const EPOCH = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface RuntimeEventIndexCheckpoint { sequenceNumber: number; projection: SessionRuntimeProjection }
export interface RuntimeEventIndex { schema: typeof RUNTIME_INDEX_SCHEMA; epoch: string; signature: string; headerEnd: number; offsets: number[]; checkpoints: RuntimeEventIndexCheckpoint[] }
export interface IndexedLedger { header: { epoch: string }; events: SessionRuntimeEvent[]; newlines: number[] }

function fsyncWrite(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const count = writeSync(fd, bytes, offset, bytes.length - offset, null);
    if (count <= 0) throw new Error("runtime event index write made no progress");
    offset += count;
  }
}

/** Build an index from one full scan: event line ends, plus sparse recovery checkpoints. */
export function buildEventIndex(ledger: IndexedLedger, signature: string): RuntimeEventIndex {
  const offsets = ledger.newlines.slice(1).map((position) => position + 1);
  if (offsets.length !== ledger.events.length) throw new Error("runtime event index offsets do not match the ledger");
  const checkpoints: RuntimeEventIndexCheckpoint[] = [];
  let state: SessionRuntimeProjection | undefined, covered = 0;
  for (let sequence = RUNTIME_INDEX_CHECKPOINT_INTERVAL; sequence <= ledger.events.length; sequence += RUNTIME_INDEX_CHECKPOINT_INTERVAL) {
    state = reduceSessionRuntimeEvents(ledger.events.slice(covered, sequence), state ?? emptyRuntimeProjection(ledger.events[0]!.sessionId));
    checkpoints.push({ sequenceNumber: sequence, projection: structuredClone(state) });
    covered = sequence;
    if (checkpoints.length >= RUNTIME_INDEX_MAX_CHECKPOINTS) break;
  }
  return { schema: RUNTIME_INDEX_SCHEMA, epoch: ledger.header.epoch, signature, headerEnd: (ledger.newlines[0] ?? -1) + 1, offsets, checkpoints };
}

export function persistEventIndex(path: string, index: RuntimeEventIndex): void {
  let encoded = JSON.stringify(index);
  while (Buffer.byteLength(encoded) > RUNTIME_INDEX_MAX_BYTES && index.checkpoints.length) {
    index = { ...index, checkpoints: index.checkpoints.slice(0, -1) };
    encoded = JSON.stringify(index);
  }
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0), 0o600);
  try { fsyncWrite(fd, Buffer.from(encoded, "utf8")); } finally { closeSync(fd); }
}

/** Load a persisted index only when it still matches the ledger byte-for-byte; otherwise null. */
export function loadEventIndex(path: string, sessionId: string, signature: string, fileSize: number): RuntimeEventIndex | null {
  let raw: string;
  try {
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const buffer = Buffer.allocUnsafe(Math.min(fileSize, RUNTIME_INDEX_MAX_BYTES));
      const count = readSync(fd, buffer, 0, buffer.length, 0);
      raw = buffer.toString("utf8", 0, count);
    } finally { closeSync(fd); }
  } catch { return null; }
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const index = value as Partial<RuntimeEventIndex> & { schema?: unknown };
  if (index.schema !== RUNTIME_INDEX_SCHEMA || typeof index.epoch !== "string" || !EPOCH.test(index.epoch) || index.epoch === ""
    || index.signature !== signature || typeof index.headerEnd !== "number" || !Number.isSafeInteger(index.headerEnd) || index.headerEnd < 0) return null;
  if (!Array.isArray(index.offsets) || !index.offsets.every((offset) => Number.isSafeInteger(offset) && offset > 0)) return null;
  for (let i = 1; i < index.offsets.length; i++) if (index.offsets[i]! <= index.offsets[i - 1]!) return null;
  if (index.offsets.length && (index.offsets[0]! <= index.headerEnd || index.offsets.at(-1)! > fileSize)) return null;
  if (!Array.isArray(index.checkpoints) || index.checkpoints.length > RUNTIME_INDEX_MAX_CHECKPOINTS) return null;
  let previous = 0;
  for (const checkpoint of index.checkpoints) {
    if (typeof checkpoint !== "object" || checkpoint === null || !Number.isSafeInteger(checkpoint.sequenceNumber)
      || checkpoint.sequenceNumber <= previous || checkpoint.sequenceNumber > index.offsets.length) return null;
    const projection = checkpoint.projection;
    if (typeof projection !== "object" || projection === null || projection.schema !== XUENESS_SESSION_RUNTIME_SCHEMA
      || projection.sessionId !== sessionId || projection.lastSequenceNumber !== checkpoint.sequenceNumber) return null;
    previous = checkpoint.sequenceNumber;
  }
  return { schema: RUNTIME_INDEX_SCHEMA, epoch: index.epoch, signature, headerEnd: index.headerEnd, offsets: index.offsets, checkpoints: index.checkpoints };
}

/** Read events sequenceFrom..sequenceTo (inclusive) by seeking; reads only those line bytes. */
export function readEventSlice(path: string, index: RuntimeEventIndex, sessionId: string, sequenceFrom: number, sequenceTo: number): SessionRuntimeEvent[] {
  if (sequenceTo < sequenceFrom || sequenceFrom < 1) return [];
  const start = sequenceFrom >= 2 ? index.offsets[sequenceFrom - 2]! : index.headerEnd;
  const end = index.offsets[sequenceTo - 1]!;
  if (end <= start) throw new Error("runtime event index slice is empty");
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const buffer = Buffer.allocUnsafe(end - start);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(fd, buffer, offset, buffer.length - offset, start + offset);
      if (count <= 0) throw new Error("runtime event ledger is shorter than the index");
      offset += count;
    }
    const events: SessionRuntimeEvent[] = [];
    const lines = buffer.toString("utf8").split("\n");
    for (let i = 0; i < lines.length - 1; i++) {
      const value = JSON.parse(lines[i]!) as unknown;
      if (!isSessionRuntimeEvent(value) || value.sessionId !== sessionId || value.sequenceNumber !== sequenceFrom + events.length) throw new Error("runtime event index slice is corrupt");
      events.push(value);
    }
    if (events.length !== sequenceTo - sequenceFrom + 1) throw new Error("runtime event index slice is incomplete");
    return events;
  } finally { closeSync(fd); }
}
