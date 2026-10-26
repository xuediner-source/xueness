/**
 * Durable streams and futures for dynamic workflow runs (F10.05): a named
 * stream is an append-only JSONL log under the plugin's private state, so a
 * subscriber can replay what it missed and re-attach after a restart — the
 * log is the source of truth, the in-process listeners are just a fast path.
 *
 * A future is the one-shot dual: `settleFuture` writes one terminal value and
 * `awaitFuture` resolves from disk when the settle already happened, so a
 * restart never loses an answer. Settling twice with the same value is a
 * no-op; settling with a different value is refused.
 */
import { appendFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pyJsonDumps, PyValueError, uuid4Hex } from "@xueness/contracts";
import { ensurePrivateDirectory, isSymlink, readJson, writeJsonAtomic } from "./state-file.ts";
import { resolvePath } from "./plan.ts";

/** A stream payload larger than this must be carried by an artifact ref. */
export const STREAM_MAX_PAYLOAD_CHARS = 32 * 1024;
/** Reads replay at most this many trailing events per stream. */
export const STREAM_READ_MAX_EVENTS = 500;

const RUN_ID = /^[a-f0-9]{32}$/;
const NAME = /^[A-Za-z0-9._-]{1,64}$/;

export interface DynamicStreamEvent {
  seq: number;
  at: string;
  payload: unknown;
}

export interface DynamicStreamRead {
  runId: string;
  name: string;
  events: DynamicStreamEvent[];
  oldestSeq: number;
  lastSeq: number;
  /** The caller asked for events that the retained tail no longer covers. */
  gap: boolean;
}

export interface DynamicStreamSubscription extends DynamicStreamRead {
  unsubscribe(): void;
}

export interface DynamicFutureRecord {
  name: string;
  at: string;
  value: unknown;
}

type Listener = (event: DynamicStreamEvent) => void;
type Waiter = (record: DynamicFutureRecord) => void;

function nowIso(): string { return new Date().toISOString(); }

function requireRunId(runId: string): void {
  if (typeof runId !== "string" || !RUN_ID.test(runId)) throw new PyValueError("stream run id must be 32 hex characters");
}

function requireName(name: string): void {
  if (typeof name !== "string" || !NAME.test(name)) throw new PyValueError("stream name must match [A-Za-z0-9._-]{1,64}");
}

function payloadOf(payload: unknown): unknown {
  let encoded: string | undefined;
  try { encoded = pyJsonDumps(payload); } catch { encoded = undefined; }
  if (encoded === undefined) throw new PyValueError("stream payload must be JSON serializable");
  if (encoded.length > STREAM_MAX_PAYLOAD_CHARS) {
    throw new PyValueError(`stream payload of ${encoded.length} chars exceeds ${STREAM_MAX_PAYLOAD_CHARS}; pass an artifact ref instead`);
  }
  return JSON.parse(encoded) as unknown;
}

/** Durable, named event streams plus one-shot futures, per run. */
export class DynamicStreamBroker {
  readonly stateDir: string;
  readonly directory: string;
  readonly #listeners = new Map<string, Set<Listener>>();
  readonly #waiters = new Map<string, Set<Waiter>>();

  constructor(stateDir: string) {
    if (isSymlink(stateDir)) throw new PyValueError("stream state directory cannot be a symlink");
    this.stateDir = resolvePath(stateDir);
    this.directory = join(this.stateDir, "dynamic-workflows", "streams");
    if (isSymlink(this.directory)) throw new PyValueError("stream directory cannot be a symlink");
    ensurePrivateDirectory(this.directory, "stream directory cannot be a symlink");
  }

  #runDirectory(runId: string): string {
    requireRunId(runId);
    const path = join(this.directory, runId);
    if (isSymlink(path)) throw new PyValueError("stream run directory cannot be a symlink");
    ensurePrivateDirectory(path, "stream run directory cannot be a symlink");
    return path;
  }

  #logPath(runId: string, name: string): string {
    requireName(name);
    return join(this.#runDirectory(runId), `${name}.jsonl`);
  }

  #futurePath(runId: string, name: string): string {
    requireName(name);
    return join(this.#runDirectory(runId), `${name}.future.json`);
  }

  #key(runId: string, name: string): string { return `${runId}/${name}`; }

  /** Append one durable event and deliver it to every live subscriber. */
  publish(runId: string, name: string, payload: unknown): DynamicStreamEvent {
    const clean = payloadOf(payload);
    const path = this.#logPath(runId, name);
    let lastSeq = 0;
    // A torn tail (a write that died mid-line) must not swallow the next event:
    // terminate the partial line before appending.
    let separator = "";
    try {
      const existing = readFileSync(path, "utf8");
      for (const event of this.#parse(existing)) lastSeq = Math.max(lastSeq, event.seq);
      if (existing.length > 0 && !existing.endsWith("\n")) separator = "\n";
    } catch { /* The first publish to a stream has no log to read. */ }
    const event: DynamicStreamEvent = { seq: lastSeq + 1, at: nowIso(), payload: clean };
    appendFileSync(path, `${separator}${pyJsonDumps(event)}\n`, "utf8");
    for (const listener of this.#listeners.get(this.#key(runId, name)) ?? []) listener(event);
    return event;
  }

  /** Parse a JSONL log; malformed lines (a torn tail) are skipped, not fatal. */
  #parse(text: string): DynamicStreamEvent[] {
    const events: DynamicStreamEvent[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as Partial<DynamicStreamEvent>;
        if (typeof parsed.seq === "number" && Number.isInteger(parsed.seq) && parsed.seq > 0 &&
            typeof parsed.at === "string" && "payload" in parsed) {
          events.push({ seq: parsed.seq, at: parsed.at, payload: parsed.payload });
        }
      } catch { /* A torn tail line is ignored; seq gaps stay visible. */ }
    }
    return events;
  }

  /** Durable tail read: events after `afterSeq`, bounded to the last 500. */
  read(runId: string, name: string, afterSeq = 0): DynamicStreamRead {
    if (!Number.isInteger(afterSeq) || afterSeq < 0) throw new PyValueError("afterSeq must be a non-negative integer");
    const path = this.#logPath(runId, name);
    let all: DynamicStreamEvent[] = [];
    try { all = this.#parse(readFileSync(path, "utf8")); } catch { /* A stream nobody published to reads empty. */ }
    const retained = all.slice(-STREAM_READ_MAX_EVENTS);
    const events = retained.filter((event) => event.seq > afterSeq);
    return {
      runId, name, events,
      oldestSeq: retained[0]?.seq ?? 0,
      lastSeq: all.at(-1)?.seq ?? 0,
      gap: afterSeq > 0 && retained.length > 0 && afterSeq < (retained[0]!.seq - 1),
    };
  }

  /**
   * Replay the durable tail past `afterSeq`, then deliver live events. All of
   * it is synchronous, so no event can slip between the replay and the attach.
   */
  subscribe(runId: string, name: string, afterSeq: number, onEvent: Listener): DynamicStreamSubscription {
    const read = this.read(runId, name, afterSeq);
    const key = this.#key(runId, name);
    let delivered = afterSeq;
    let live = onEvent;
    const set = this.#listeners.get(key) ?? new Set<Listener>();
    this.#listeners.set(key, set);
    const wrapped: Listener = (event) => { if (event.seq > delivered) { delivered = event.seq; live(event); } };
    set.add(wrapped);
    for (const event of read.events) wrapped(event);
    const broker = this;
    return {
      ...read,
      get lastSeq(): number { return Math.max(delivered, broker.read(runId, name, 0).lastSeq); },
      unsubscribe(): void { set.delete(wrapped); },
    };
  }

  /** Names of the streams a run has published to (log or settled future). */
  names(runId: string): string[] {
    const directory = this.#runDirectory(runId);
    let entries: string[];
    try { entries = readdirSync(directory); } catch { return []; }
    const found = new Set<string>();
    for (const entry of entries) {
      if (entry.endsWith(".jsonl")) found.add(entry.slice(0, -".jsonl".length));
      else if (entry.endsWith(".future.json")) found.add(entry.slice(0, -".future.json".length));
    }
    return [...found].filter((name) => NAME.test(name)).sort();
  }

  /**
   * Settle a named future. Idempotent for the same canonical value; a
   * different value on an already-settled name is a refusal.
   */
  settleFuture(runId: string, name: string, value: unknown): DynamicFutureRecord {
    const clean = payloadOf(value);
    const path = this.#futurePath(runId, name);
    if (existsSync(path)) {
      const previous = readJson(path) as Partial<DynamicFutureRecord>;
      if (pyJsonDumps(previous.value, { sortKeys: true }) === pyJsonDumps(clean, { sortKeys: true })) {
        return { name, at: previous.at as string, value: previous.value };
      }
      throw new PyValueError(`future '${name}' is already settled with a different value`);
    }
    const record: DynamicFutureRecord = { name, at: nowIso(), value: clean };
    writeJsonAtomic(this.#runDirectory(runId), `.future-${uuid4Hex().slice(0, 8)}-`, path, record);
    for (const waiter of this.#waiters.get(this.#key(runId, name)) ?? []) waiter(record);
    return record;
  }

  /** The settled record, or null when the future is still pending. */
  future(runId: string, name: string): DynamicFutureRecord | null {
    const path = this.#futurePath(runId, name);
    if (!existsSync(path)) return null;
    const record = readJson(path) as Partial<DynamicFutureRecord>;
    if (record.name !== name) throw new PyValueError(`future record '${name}' is corrupt`);
    return { name, at: record.at as string, value: record.value };
  }

  /**
   * Resolve now if the durable record exists, else when this broker settles
   * it. A restart resolves immediately from disk — that is the resumable path.
   */
  awaitFuture(runId: string, name: string, signal?: AbortSignal): Promise<DynamicFutureRecord> {
    const settled = this.future(runId, name);
    if (settled) return Promise.resolve(settled);
    return new Promise<DynamicFutureRecord>((resolve, reject) => {
      const key = this.#key(runId, name);
      const waiter: Waiter = (record) => { cleanup(); resolve(record); };
      const onAbort = (): void => { cleanup(); reject(new PyValueError("future wait aborted")); };
      const cleanup = (): void => {
        this.#waiters.get(key)?.delete(waiter);
        signal?.removeEventListener("abort", onAbort);
      };
      (this.#waiters.get(key) ?? (this.#waiters.set(key, new Set<Waiter>()), this.#waiters.get(key)!)).add(waiter);
      if (signal?.aborted) { onAbort(); return; }
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}
