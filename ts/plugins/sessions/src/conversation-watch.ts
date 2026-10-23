import { PyValueError } from "@xueness/contracts";
import { pyExceptionName } from "@xueness/sessions";
import { ConversationCache, ExternalConversationRun, type ConversationBase, type Row } from "./conversation-cache.ts";
import { waitLive } from "./live-api.ts";
import { SnapshotError } from "./snapshot-rows.ts";
export class WatchError extends PyValueError { override name = "WatchError"; }
const fail = () => { throw new WatchError("invalid conversation watch"); };
function one(query: Row, key: string): unknown { const v = query[key]; if (Array.isArray(v)) { if (v.length !== 1) fail(); return v[0]; } return v; }
export function conversationBase(query: Row): ConversationBase | null {
  const raw = (key: string) => { const v = query[key]; if (Array.isArray(v)) { if (v.length !== 1) throw new PyValueError("invalid conversation transport base"); return v[0]; } return v; };
  const epoch = raw("logEpoch"), seq = raw("seq"); if (epoch == null && seq == null) return null;
  if (typeof epoch !== "string" || !/^[0-9a-f]{32}$/.test(epoch) || typeof seq !== "string" || !/^(?:0|[1-9][0-9]{0,15})$/.test(seq) || BigInt(seq) > BigInt(Number.MAX_SAFE_INTEGER)) throw new PyValueError("invalid conversation transport base");
  return { epoch, seq: Number(seq) };
}
export interface WatchRequest { client: string; topics: [string, ConversationBase | null][]; since: string | null; wait: number; pace: number; }
export function watchRequest(query: Row, epoch: string): WatchRequest {
  const client = one(query, "client"); if (typeof client !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(client)) fail();
  const raw = typeof query.topic === "string" ? [query.topic] : query.topic ?? []; if (!Array.isArray(raw) || raw.length < 1 || raw.length > 16) fail();
  const topics: [string, ConversationBase | null][] = [], seen = new Set<string>();
  for (const item of raw) { const parts = typeof item === "string" ? item.split(".") : []; if (![1, 3].includes(parts.length) || !/^[0-9a-f]{32}$/.test(parts[0] ?? "")) fail();
    let base: ConversationBase | null; try { base = parts.length === 3 ? conversationBase({ logEpoch: parts[1], seq: parts[2] }) : null; } catch { fail(); }
    const key = JSON.stringify([parts[0], base!]); if (seen.has(key)) fail(); seen.add(key); topics.push([parts[0]!, base!]);
  }
  const since = one(query, "since"); if (since != null && (typeof since !== "string" || !/^[0-9a-f]{16}\.(?:0|[1-9][0-9]{0,15})$/.test(since))) fail();
  const number = (key: string, fallback: number, max: number): number => { const value = one(query, key); if (value == null) return fallback; if (typeof value !== "string" || !/^(?:0|[1-9][0-9]{0,15})$/.test(value) || BigInt(value) > BigInt(max)) fail(); return Number(value); };
  return { client: client as string, topics, since: typeof since === "string" && since.startsWith(epoch + ".") ? since : null, wait: number("wait", 20000, 25000), pace: number("pace", 33, 5000) };
}
export class ConversationWatch {
  readonly cache: ConversationCache;
  readonly waiters = new Map<string, { superseded: boolean }>();
  readonly lastPush = new Map<string, number>();
  constructor(cache: ConversationCache) { this.cache = cache; }
  async watch(request: WatchRequest, signal?: AbortSignal): Promise<Row> {
    const previous = this.waiters.get(request.client); if (!previous && this.waiters.size >= 32) throw Object.assign(new Error("too many conversation watchers"), { name: "WatchBusy" });
    if (previous) previous.superseded = true;
    const waiter = { superseded: false }; this.waiters.set(request.client, waiter); const deadline = Date.now() + request.wait;
    const observed = new Map<string, bigint>();
    let cursor = request.since; const answer = (updates: Row[] = [], errors: Row[] = []) => ({ schema: "xueness.conversation-watch.v1", cursor: waiter.superseded && cursor === null ? null : cursor ?? `${this.cache.epoch}.${this.cache.version}`, superseded: waiter.superseded, updates, errors });
    const finish = async (updates: Row[] = [], errors: Row[] = []) => { if (!signal?.aborted && !waiter.superseded) await this.cache.acknowledge(observed); return answer(updates, errors); };
    try { while (!signal?.aborted) {
      if (waiter.superseded) return answer();
      if (!this.cache.options.enabled("sessions")) { this.cache.clear(); throw Object.assign(new Error("sessions disabled"), { name: "PermissionError" }); }
      const hold = (this.lastPush.get(request.client) ?? 0) + request.pace - Date.now(); if (hold > 0 && Date.now() + hold < deadline) { await waitLive(hold, signal); continue; }
      const updates: Row[] = [], errors: Row[] = [];
      for (const [index, [sid, base]] of request.topics.entries()) {
        try { const envelope = await this.cache.observe(sid, base, observed); if (!base || envelope.mode !== "resume" || envelope.logEpoch !== base.epoch || envelope.seq !== base.seq) updates.push({ index, envelope }); }
        catch (e) { const name = pyExceptionName(e); if (name === "PermissionError" || e instanceof ExternalConversationRun) throw e; errors.push({ index, topic: "conversation/" + sid, status: e instanceof SnapshotError ? e.status : name === "FileNotFoundError" ? 404 : 409, error: e instanceof SnapshotError ? e.message : name === "FileNotFoundError" ? "session not found" : "conversation unavailable; request a new snapshot" }); }
      }
      cursor = `${this.cache.epoch}.${this.cache.version}`;
      if (updates.length || errors.length) { const result = await finish(updates, errors); this.lastPush.delete(request.client); this.lastPush.set(request.client, Date.now()); while (this.lastPush.size > 256) this.lastPush.delete(this.lastPush.keys().next().value!); return result; }
      if (Date.now() >= deadline) return await finish(); await waitLive(Math.min(200, Math.max(5, deadline - Date.now())), signal);
    } return answer(); }
    finally { if (this.waiters.get(request.client) === waiter) this.waiters.delete(request.client); }
  }
}
