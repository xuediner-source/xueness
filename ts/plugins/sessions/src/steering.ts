/** Current-turn guidance splices only at runner-owned model request boundaries. */
import { existsSync } from "node:fs";
import { isDict, pyLen, pyUtcNow, PyValueError } from "@xueness/contracts";
import type { Session, SessionStore } from "@xueness/sessions";
import { MediaArtifactStore } from "./media-store.ts";
import { Owner } from "./media-owner.ts";
import { mediaRefs, type QueueMediaContext } from "./queue-media.ts";
import { MessageQueue } from "./queue.ts";
import { boundaryAdmissionOrder, guidancePriority, guidanceWaitWindow } from "./steering-priority.ts";
import { ACTIVE, checkRevision, itemSize, MAX_ITEM_BYTES, MAX_PENDING, MAX_PENDING_BYTES, QueueConflict, QueueNotFound, SID, trimHistory, type Row } from "./queue-types.ts";
export class SteeringInbox extends MessageQueue {
  constructor(store: SessionStore, media?: QueueMediaContext) { super(store, media, "session-turn-inputs", "steering"); }
  override read(sid: string): Row {
    const r = super.read(sid);
    for (const item of r.items as Row[]) {
      if (item.target_turn_id != null && (typeof item.target_turn_id !== "string" || !item.target_turn_id || pyLen(item.target_turn_id) > 128 || item.target_turn_id.includes("\0"))) throw new PyValueError("current-turn input target is invalid");
      if (ACTIVE.has(item.status) && item.target_turn_id == null) throw new PyValueError("current-turn input target is missing");
    }
    return r;
  }
  override publicItem(item: Row, position?: number): Row { return { ...super.publicItem(item, position), delivery: "guide", targetTurnId: item.target_turn_id ?? null, priority: guidancePriority(item), editable: false }; }
  async admitLocked(sid: string, text: string, turnId: string, requestId: string, fingerprint: string, prepared: Row | null = null): Promise<[Row, boolean]> {
    const replay = await this.replayLocked(sid, requestId, fingerprint); if (replay) return [replay, true];
    const record = this.read(sid), items = trimHistory(record.items), pending = items.filter((r) => ACTIVE.has(r.status));
    if (pending.length >= MAX_PENDING) throw new PyValueError("current-turn input inbox is full");
    if (itemSize({ text, prepared }) > MAX_ITEM_BYTES || pending.reduce((n, r) => n + itemSize(r), 0) + itemSize({ text, prepared }) > MAX_PENDING_BYTES) throw new PyValueError("current-turn input is too large");
    const item: Row = { id: this.media.itemId(sid, prepared, requestId), text, status: "queued", target_turn_id: turnId, created_at: pyUtcNow() };
    if (prepared !== null) item.prepared = prepared;
    const receipt = this.publicItem(item, pending.length + 1); item.submission = { id: requestId, fingerprint, receipt };
    await this.media.reserve(sid, item); items.splice(pending.length, 0, item);
    await this.atomicSave(sid, { schema: 1, accepting: true, items }); await this.media.finalize(sid, item); return [receipt, false];
  }
}
const seenInputs = (session: Session): Set<unknown> => new Set([session.messages, session.archived_messages].flatMap((messages) => Array.isArray(messages) ? messages.filter(isDict).filter((row) => typeof row._input_id === "string").map((row) => row._input_id) : []));
export async function beforeModelRequest(session: Session, store: SessionStore, stateDir?: string, enabled: (id: string) => boolean = () => true, maxInputs = Infinity, boundary: "model_request" | "final_response" = "model_request"): Promise<number> {
  const sid = session.id, turn = session.active_turn_id;
  if (!enabled("sessions") || typeof sid !== "string" || !SID.test(sid) || typeof turn !== "string" || !turn || !store.directory) return 0;
  const inbox = new SteeringInbox(store, stateDir ? { stateDir, enabled } : undefined); if (!existsSync(inbox.path(sid))) return 0;
  return inbox.locked(sid, async () => {
    const record = inbox.read(sid), messages = session.messages ??= [];
    if (!Array.isArray(messages)) throw new PyValueError("session messages are invalid");
    const seen = seenInputs(session); let count = 0, changed = false;
    // Priority scheduling: a live send-now takeover is admitted before plain guides;
    // equal priorities keep durable FIFO order, so single-guide turns are unchanged.
    for (const item of boundaryAdmissionOrder(record.items as Row[])) {
      if (!["queued", "running"].includes(item.status)) continue;
      if (seen.has(item.id)) { item.status = "completed"; delete item.prepared; item.updated_at = pyUtcNow(); changed = true; continue; }
      if (item.target_turn_id !== turn) { item.status = "paused"; item.pause_reason = "The target turn has ended; withdraw this input before submitting it again."; item.updated_at = pyUtcNow(); changed = true; continue; }
      if (count >= maxInputs) continue;
      const p = item.prepared ?? {}, message: Row = { role: "user", content: p.text ?? item.text, _message_id: item.id, _input_id: item.id, _input_kind: "guide", _turn_id: turn, _request_id: item.submission.id, _input_boundary: boundary };
      if (isDict(p.metadata)) message._composer_metadata = p.metadata;
      await inbox.media.finalize(sid, item, session);
      if (mediaRefs(p).length) {
        if (!stateDir) throw new PyValueError("media queue requires an authorized context");
        message._media_refs = mediaRefs(p);
        await new MediaArtifactStore(stateDir).adopt(new Owner("steering", item.id, String(session.root), sid), new Owner("message", item.id, String(session.root), sid), mediaRefs(p).map((r) => r.id));
      }
      messages.push(message);
      try { await store.save(session); } catch (e) { messages.pop(); throw e; }
      seen.add(item.id); item.status = "completed"; item.updated_at = pyUtcNow(); item.delivered_boundary = boundary; delete item.prepared; changed = true; count += 1;
    }
    if (changed) await inbox.atomicSave(sid, { schema: 1, accepting: true, items: trimHistory(record.items) });
    return count;
  });
}
export async function settleTurn(session: Session, store: SessionStore, stateDir?: string, turnId?: unknown): Promise<void> {
  const sid = session.id; if (typeof sid !== "string" || !SID.test(sid)) return;
  const inbox = new SteeringInbox(store, stateDir ? { stateDir } : undefined); if (!existsSync(inbox.path(sid))) return;
  await inbox.locked(sid, async () => {
    const r = inbox.read(sid), seen = seenInputs(session); let changed = false;
    for (const item of r.items as Row[]) {
      if (!["queued", "running"].includes(item.status) || turnId && item.target_turn_id !== turnId) continue;
      item.status = seen.has(item.id) ? "completed" : "paused";
      if (item.status === "paused") item.pause_reason = "The target turn ended before delivery; withdraw this input to send it again."; else delete item.prepared;
      item.updated_at = pyUtcNow(); changed = true;
    }
    if (changed) await inbox.atomicSave(sid, { schema: 1, accepting: false, items: trimHistory(r.items) });
  });
}
export async function pendingSnapshot(session: Session, store: SessionStore, stateDir?: string): Promise<Row> {
  const sid = session.id;
  if (typeof sid !== "string" || !SID.test(sid)) return { pending_guidance: [], guidance_history: [] };
  const inbox = new SteeringInbox(store, stateDir ? { stateDir } : undefined);
  if (!existsSync(inbox.path(sid))) return { pending_guidance: [], guidance_history: [] };
  if (session.status === "running" && typeof session.active_turn_id === "string") await inbox.locked(sid, async () => {
    const r = inbox.read(sid); let changed = false;
    for (const item of r.items as Row[]) if (["queued", "running"].includes(item.status) && item.target_turn_id !== session.active_turn_id) { item.status = "paused"; item.pause_reason = "The target turn has ended; withdraw this input before submitting it again."; item.updated_at = pyUtcNow(); changed = true; }
    if (changed) await inbox.atomicSave(sid, { schema: 1, accepting: true, items: trimHistory(r.items) });
  }); else await settleTurn(session, store, stateDir);
  const snapshot = await inbox.snapshot(sid), wait = guidanceWaitWindow(session);
  // Inside a compaction or waiting-tool window same-turn inputs stay queued
  // (preserved) and receipts stay trackable; nothing settles mid-window.
  const pending_guidance = wait && (wait.compacting || wait.waiting)
    ? snapshot.queued_messages.map((row: Row) => row.targetTurnId === wait.turnId ? { ...row, preserved: true } : row)
    : snapshot.queued_messages;
  return { pending_guidance, guidance_history: snapshot.queue_history };
}
export async function reservePromotion(queue: MessageQueue, sid: string, id: string, requestId: string, fp: string, turnId: string | null = null, revision?: unknown): Promise<[Row, boolean]> {
  const record = queue.read(sid), item = record.items.find((r: Row) => r.id === id); if (!item) throw new QueueNotFound("queued message not found");
  for (const row of record.items as Row[]) {
    const p = row.promotion; if (!isDict(p)) continue;
    if (p.id === requestId) { if (p.fingerprint !== fp) throw new QueueConflict("request_id already used for different promotion"); if (p.state === "released") throw new QueueConflict("previous send-now reservation was released; try again"); return [p.receipt as Row, true]; }
    if (["reserved", "claimed"].includes(String(p.state))) throw new QueueConflict("a queued message is already being sent now");
  }
  checkRevision(record, revision); if (!["queued", "paused"].includes(item.status)) throw new QueueConflict("queued message is already claimed");
  const receipt = { id, request_id: requestId, delivery: "startNow", state: "reserved", targetTurnId: turnId };
  const pending = (record.items as Row[]).filter((r) => ["queued", "paused"].includes(r.status)), ids = pending.map((r) => r.id);
  item.promotion = { id: requestId, fingerprint: fp, state: "reserved", receipt, previous_ids: ids }; item.updated_at = pyUtcNow();
  const ordered = [item, ...pending.filter((r) => r.id !== id)]; let index = 0;
  record.items = record.items.map((r: Row) => ids.includes(r.id) ? ordered[index++] : r); await queue.atomicSave(sid, record); return [receipt, false];
}
export function releasePromotion(queue: MessageQueue, sid: string, requestId: string): Promise<boolean> { return queue.locked(sid, async () => {
  const r = queue.read(sid), item = r.items.find((row: Row) => row.promotion?.id === requestId);
  if (!item || !["reserved", "claimed"].includes(item.promotion.state) || !["queued", "paused"].includes(item.status)) return false;
  item.promotion.state = "released"; const ids = item.promotion.previous_ids as string[], pending = (r.items as Row[]).filter((row) => ["queued", "paused"].includes(row.status)), byId = new Map(pending.map((r) => [r.id, r]));
  const ordered = [...ids.filter((id) => byId.has(id)).map((id) => byId.get(id)!), ...pending.filter((row) => !ids.includes(row.id))]; let index = 0;
  r.items = r.items.map((row: Row) => byId.has(row.id) ? ordered[index++] : row); await queue.atomicSave(sid, r); return true;
}); }
