/** Bounded observation cache. Frames describe projections, never provider tokens. */
import { statSync } from "node:fs";
import { current, difference, historyPath, KeyedMutex, type Session } from "@xueness/sessions";
import { isDict, isPyIntValue, pyDeepCopy, pyEquals, pyJsonDumps, uuid4Hex } from "@xueness/contracts";
import { conversationSnapshot } from "./conversation-api.ts";
import { markViewed } from "./read-state.ts";
import { externalRun } from "./queue-http.ts";
import type { SessionsApiOptions } from "./http-api.ts";
export type Row = Record<string, any>;
/** A long poll can still relay while no response headers have been sent. */
export class ExternalConversationRun extends Error {}
export interface ConversationBase { epoch: string; seq: number; }
interface Projection { epoch: string; seq: number; snapshot: Row; history: [number, string, string]; frames: Row[]; size: number; at: number; fingerprint: string; checkedAt: number; }
const bytes = (v: unknown) => Buffer.byteLength(pyJsonDumps(v, { separators: [",", ":"] }));
function historyStamp(o: SessionsApiOptions, sid: string, snapshot: Row, previous?: Projection): { stamp: [number, string, string]; broken: boolean } {
  const revision = snapshot.journal.history_revision ?? 0, stateHash = snapshot.session.history_hash;
  if (!isPyIntValue(revision) || Number(revision) < 0) return { stamp: [0, "", ""], broken: true };
  if (!Number(revision)) return { stamp: [0, "", ""], broken: !!previous?.history[0] };
  const records = current(historyPath(o.store, sid)).records, [oldRevision, oldHash, oldRecord] = previous?.history ?? [0, "", ""];
  let found: Row | undefined, oldFound = !oldRevision, reset = false;
  for (const record of [...records].reverse()) {
    if (Number(record.seq) > Number(revision)) continue;
    if (Number(record.seq) === Number(revision)) found = record;
    if (oldRevision && Number(record.seq) === oldRevision) { oldFound = record.recordHash === oldRecord && record.stateHash === oldHash; break; }
    if (Number(record.seq) > oldRevision && previous && record.reset) reset = true;
    if (Number(record.seq) < oldRevision) break;
  }
  const valid = !!found && found.stateHash === stateHash;
  return { stamp: [Number(revision), stateHash || "", valid ? String(found!.recordHash) : ""], broken: !!previous && (Number(revision) < oldRevision || !oldFound || reset) || !valid };
}
function rewritten(before: Row, after: Row): boolean {
  if (!pyEquals(before.session.compactions ?? null, after.session.compactions ?? null)) return true;
  const old = before.window, next = after.window;
  if (next.total < old.total || next.start < old.start) return true;
  for (let i = Math.max(old.start, next.start); i < Math.min(old.end, next.end); i++) {
    const a = before.journal.messages[i - old.start], b = after.journal.messages[i - next.start];
    if (!isDict(a) || !isDict(b)) { if (!pyEquals(a, b)) return true; continue; }
    if (["_message_id", "role", "tool_calls", "tool_call_id"].some((k) => !pyEquals(a[k] ?? null, b[k] ?? null))) return true;
    if (!pyEquals(a.content ?? null, b.content ?? null) && !(a.role === "assistant" && typeof a.content === "string" && typeof b.content === "string" && b.content.startsWith(a.content))) return true;
  }
  return false;
}
export class ConversationCache {
  readonly options: SessionsApiOptions;
  readonly project: (s: Session) => Promise<Row> | Row;
  readonly epoch = uuid4Hex().slice(0, 16);
  readonly entries = new Map<string, Projection>();
  readonly mutex = new KeyedMutex();
  version = 0;
  constructor(options: SessionsApiOptions, project: (s: Session) => Promise<Row> | Row) { this.options = options; this.project = project; }
  clear(): void { this.entries.clear(); this.version++; }
  behind(sid: string, base: ConversationBase | null): boolean { const p = this.entries.get(sid); return !base || !p || p.epoch !== base.epoch || p.seq !== base.seq; }
  async available(sids: Iterable<string>): Promise<void> {
    if (!this.options.enabled("sessions")) { this.clear(); throw Object.assign(new Error("sessions disabled"), { name: "PermissionError" }); }
    for (const sid of sids) if (await externalRun(this.options, sid)) throw new ExternalConversationRun();
  }
  async acknowledge(observed: ReadonlyMap<string, bigint>): Promise<void> {
    await this.available(observed.keys());
    for (const [sid, stamp] of observed) try { await markViewed(this.options.store, sid, stamp); } catch { /* A read must not hide another writer's work. */ }
  }
  async observe(sid: string, base: ConversationBase | null = null, deferred?: Map<string, bigint>): Promise<Row> {
    const release = await this.mutex.acquire("observe");
    try {
      await this.available([sid]);
      const previous = this.entries.get(sid), source = statSync(this.options.store.pathFor(sid), { bigint: true }), observed = source.mtimeNs;
      const live = this.options.lifecycle?.activeContext.get(sid)?.active_session;
      const hot = isDict(live) ? [live.streaming, live.runtime_activity, live.tool_activity, live.permission_mode] : null;
      const fingerprint = `${source.ino}:${source.size}:${source.mtimeNs}:${source.ctimeNs}:` + JSON.stringify([hot, ["files", "planning", "subagents"].map(id => this.options.enabled(id))]);
      let projection: Projection;
      if (previous && previous.fingerprint === fingerprint && Date.now() - previous.checkedAt < 1000) projection = previous;
      else {
      const snapshot = await conversationSnapshot(this.options, sid, { tail: true, before: 0, limit: 80 }, null, this.project), { stamp, broken } = historyStamp(this.options, sid, snapshot, previous);
      await this.available([sid]);
      if (!previous || broken || rewritten(previous.snapshot, snapshot)) { projection = { epoch: uuid4Hex(), seq: 1, snapshot, history: stamp, frames: [], size: 0, at: Date.now(), fingerprint, checkedAt: Date.now() }; this.version++; }
      else {
        projection = previous; const operations = difference(previous.snapshot, snapshot);
        if (operations.length) { projection.frames.push({ kind: "delta", logEpoch: projection.epoch, fromSeq: projection.seq, toSeq: projection.seq + 1, operations }); projection.frames = projection.frames.slice(-64); projection.seq++; projection.snapshot = snapshot; this.version++; }
        projection.history = stamp; projection.at = Date.now();
      }
      projection.fingerprint = fingerprint; projection.checkedAt = Date.now();
      const snapshotBytes = bytes(projection.snapshot); projection.size = snapshotBytes + projection.frames.reduce((n, frame) => n + bytes(frame), 0);
      while (projection.frames.length && projection.size > 2 * 1024 * 1024) projection.size -= bytes(projection.frames.shift()!);
      }
      this.entries.delete(sid);
      if (projection.size <= 2 * 1024 * 1024) this.entries.set(sid, projection);
      while (this.entries.size > 64 || [...this.entries.values()].reduce((n, p) => n + p.size, 0) > 16 * 1024 * 1024) this.entries.delete(this.entries.keys().next().value!);
      let mode = "snapshot", frames: Row[] = [{ kind: "snapshot", logEpoch: projection.epoch, fromSeq: 0, toSeq: projection.seq, snapshot: projection.snapshot }];
      if (base && base.epoch === projection.epoch && base.seq <= projection.seq) { const selected = projection.frames.filter((f) => f.toSeq > base.seq); if (base.seq === projection.seq || selected.length && selected[0]!.fromSeq === base.seq) { mode = "resume"; frames = selected; } }
      const result = pyDeepCopy({ schema: "xueness.conversation-transport.v1", topic: "conversation/" + sid, mode, logEpoch: projection.epoch, seq: projection.seq, frames });
      if (deferred) deferred.set(sid, observed); else await this.acknowledge(new Map([[sid, observed]]));
      return result;
    } finally { release(); }
  }
}
