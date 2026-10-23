/** Durable queue storage and CAS mutations; compatible with Python schema 1. */
import { isDict, pyDeepCopy, pyEquals, pyJsonDumps, pyLen, pyStrip, pySubstring, pyUtcNow, PyValueError } from "@xueness/contracts";
import type { SessionStore } from "@xueness/sessions";
import { Sidecar } from "./queue-fs.ts";
import { QueueMedia, type QueueMediaContext } from "./queue-media.ts";
import { validateQueue, validateWithdrawals } from "./queue-validation.ts";
import { ACTIVE, checkRevision, FINAL, HISTORY_LIMIT, itemSize, MAX_ITEM_BYTES, MAX_PENDING, MAX_PENDING_BYTES, QueueConflict, QueueNotFound, SID, trimHistory, type Row } from "./queue-types.ts";
const MAX_FILE_BYTES = 16 * 1024 * 1024;
export class MessageQueue {
  readonly store: SessionStore;
  readonly files: Sidecar;
  readonly media: QueueMedia;
  constructor(store: SessionStore, media?: QueueMediaContext, folder = "session-message-queues", kind = "queue") {
    this.store = store; this.files = new Sidecar(store.directory, folder); this.media = new QueueMedia(store, kind, media);
  }
  path(sid: string): string { if (!SID.test(sid)) throw new PyValueError("invalid session id"); return this.files.path(sid); }
  locked<T>(sid: string, body: () => T | Promise<T>): Promise<T> { this.path(sid); return this.files.locked(sid, body); }
  read(sid: string): Row {
    this.path(sid);
    return validateQueue(this.files.read(sid, MAX_FILE_BYTES) ?? { schema: 1, revision: 0, accepting: false, items: [] }, sid);
  }
  async atomicSave(sid: string, record: Row): Promise<void> {
    const current = this.read(sid);
    const candidate: Row = { schema: 1, accepting: record.accepting ?? false, items: record.items,
      withdrawals: record.withdrawals ?? current.withdrawals, withdrawalClock: record.withdrawalClock ?? current.withdrawalClock };
    validateWithdrawals(candidate, sid);
    const semantic = (r: Row): Row => ({ accepting: r.accepting ?? false, items: r.items.map((item: Row) => Object.fromEntries(Object.entries(item).filter(([key]) => key !== "updated_at"))) });
    const changed = !pyEquals(semantic(current), semantic(candidate));
    const metadata = !pyEquals(current.withdrawals, candidate.withdrawals) || current.withdrawalClock !== candidate.withdrawalClock;
    if (!changed && !metadata) { record.revision = current.revision; return; }
    if (changed && current.revision === Number.MAX_SAFE_INTEGER) throw new PyValueError("message queue revision exhausted");
    candidate.revision = current.revision + Number(changed);
    this.files.save(sid, candidate, MAX_FILE_BYTES);
    record.revision = candidate.revision;
    await this.media.releaseSettled(sid, current.items, candidate.items);
  }
  editablePrefix(item: Row): string | null {
    const p = item.prepared;
    if (!isDict(p)) return null;
    const prefix = p.edit_prefix ?? (p.text === item.text ? item.text : null);
    return typeof prefix === "string" && !!prefix && pyLen(prefix) <= 5000 && prefix === item.text && typeof p.text === "string" && p.text.startsWith(prefix) ? prefix : null;
  }
  publicItem(item: Row, position?: number): Row {
    const out: Row = Object.fromEntries(["id", "text", "status", "created_at", "updated_at"].filter((k) => k in item).map((k) => [k, item[k]]));
    const metadata = item.prepared?.metadata;
    if (isDict(metadata)) {
      const nonempty = (key: string) => { const v = metadata[key]; return Array.isArray(v) ? v.length > 0 : isDict(v) ? Object.keys(v).length > 0 : !!v; };
      out.has_attachments = ["attachments", "files", "media_refs"].some(nonempty);
      out.has_context = ["attachments", "files", "media_refs", "sessions", "skills", "plugins", "capabilities"].some(nonempty);
    }
    out.editable = ["queued", "paused"].includes(item.status) && (item.prepared == null || this.editablePrefix(item) !== null);
    if (position !== undefined) out.position = position;
    if (typeof item.pause_reason === "string") out.pause_reason = pySubstring(item.pause_reason, 0, 500);
    if (isDict(item.promotion)) {
      out.promotion = Object.fromEntries(["id", "state"].filter((k) => k in item.promotion).map((k) => [k, item.promotion[k]]));
      if (["reserved", "claimed"].includes(String(item.promotion.state))) out.editable = false;
    }
    if (isDict(item.completion)) out.completion = Object.fromEntries(["status", "verified", "tool_execution_status", "delivery_status"].filter((k) => k in item.completion).map((k) => [k, item.completion[k]]));
    return out;
  }
  snapshotLocked(sid: string): Row {
    const r = this.read(sid); let position = 0;
    return { queue_revision: r.revision, queued_messages: r.items.filter((row: Row) => ACTIVE.has(row.status)).map((row: Row) => this.publicItem(row, ["queued", "paused"].includes(row.status) ? ++position : 0)),
      queue_history: r.items.filter((row: Row) => FINAL.has(row.status)).slice(-HISTORY_LIMIT).map((row: Row) => this.publicItem(row)) };
  }
  snapshot(sid: string): Promise<Row> { return this.locked(sid, () => this.snapshotLocked(sid)); }
  async hasPending(sid: string): Promise<boolean> { return (await this.snapshot(sid)).queued_messages.length > 0; }
  async replayLocked(sid: string, requestId?: string | null, fingerprint?: string, session?: Row): Promise<Row | null> {
    if (requestId == null) return null;
    for (const item of this.read(sid).items as Row[]) if (item.submission?.id === requestId) {
      if (item.submission.fingerprint !== fingerprint) throw new QueueConflict("request_id already used for different input");
      if (ACTIVE.has(item.status)) await this.media.finalize(sid, item, session);
      return item.submission.receipt;
    }
    return null;
  }
  enqueue(sid: string, text: string, prepared: Row | null = null, options: { activeRun?: boolean; requestId?: string | null; fingerprint?: string; session?: Row } = {}): Promise<Row> {
    if (typeof text !== "string" || !pyStrip(text)) return Promise.reject(new PyValueError("message must contain text"));
    if (prepared !== null && (!isDict(prepared) || prepared.text != null && typeof prepared.text !== "string")) return Promise.reject(new PyValueError("prepared input is invalid"));
    if (prepared !== null) { try { pyJsonDumps(prepared, { ensureAscii: false }); } catch { return Promise.reject(new PyValueError("prepared input is invalid")); } }
    if (itemSize({ text, prepared }) > MAX_ITEM_BYTES) return Promise.reject(new PyValueError("queued message is too large"));
    return this.locked(sid, () => this.enqueueLocked(sid, text, prepared, options));
  }
  async enqueueLocked(sid: string, text: string, prepared: Row | null = null, options: { activeRun?: boolean; requestId?: string | null; fingerprint?: string; session?: Row } = {}): Promise<Row> {
    const replay = await this.replayLocked(sid, options.requestId, options.fingerprint, options.session); if (replay) return replay;
    const record = this.read(sid), items = trimHistory(record.items), active = items.filter((r) => ACTIVE.has(r.status));
    if (options.activeRun && !record.accepting) throw new QueueConflict("message queue is closing; retry after the run settles");
    if (!record.accepting && !active.length) throw new QueueConflict("message queue is not accepting messages");
    if (active.length >= MAX_PENDING || active.reduce((n, row) => n + itemSize(row), 0) + itemSize({ text, prepared }) > MAX_PENDING_BYTES) throw new PyValueError("message queue is full");
    const item: Row = { id: this.media.itemId(sid, prepared, options.requestId), text, status: record.accepting ? "queued" : "paused", created_at: pyUtcNow() };
    if (prepared !== null) item.prepared = prepared;
    const receipt = this.publicItem(item, 1 + active.filter((r) => ["queued", "paused"].includes(r.status)).length);
    if (options.requestId != null) item.submission = { id: options.requestId, fingerprint: options.fingerprint, receipt };
    await this.media.reserve(sid, item, options.session); items.splice(active.length, 0, item);
    await this.atomicSave(sid, { schema: 1, accepting: record.accepting, items });
    await this.media.finalize(sid, item, options.session); return receipt;
  }
  get(sid: string, id: string): Promise<Row | null> { return this.locked(sid, () => this.read(sid).items.find((r: Row) => r.id === id) ?? null); }
  claimNext(sid: string): Promise<Row | null> { return this.locked(sid, async () => {
    const r = this.read(sid), item = r.items.find((row: Row) => row.status === "queued"); if (!item) return null;
    await this.media.finalize(sid, item); item.status = "running"; item.updated_at = pyUtcNow();
    if (item.promotion?.state === "reserved") item.promotion.state = "claimed";
    await this.atomicSave(sid, r); return pyDeepCopy(item);
  }); }
  async editLocked(sid: string, id: string, text: unknown, expected: unknown, current?: unknown, revision?: unknown): Promise<Row> {
    if (!SID.test(id)) throw new PyValueError("invalid queue id");
    if (typeof text !== "string" || pyLen(pyStrip(text)) < 1 || pyLen(pyStrip(text)) > 5000 || text.includes("\0") || typeof expected !== "string" || pyLen(expected) > 5000) throw new PyValueError("message must be 1..5000 characters");
    text = pyStrip(text); const r = this.read(sid); checkRevision(r, revision);
    const item = r.items.find((row: Row) => row.id === id); if (!item) throw new QueueNotFound("queued message not found");
    if (!["queued", "paused"].includes(item.status) || id === current || ["reserved", "claimed"].includes(item.promotion?.state)) throw new QueueConflict("queued message is already claimed");
    if (item.text !== expected) throw new QueueConflict("queued message changed; refresh before editing");
    let prepared: Row | null = null;
    if (item.prepared != null) { const prefix = this.editablePrefix(item); if (prefix === null) throw new QueueConflict("this message needs fresh context preparation; cancel it and send again"); prepared = { ...item.prepared, text: text + item.prepared.text.slice(prefix.length), edit_prefix: text }; }
    const bytes = itemSize({ text, prepared });
    if (bytes > MAX_ITEM_BYTES || bytes + r.items.filter((row: Row) => row.id !== id && ACTIVE.has(row.status)).reduce((n: number, row: Row) => n + itemSize(row), 0) > MAX_PENDING_BYTES) throw new PyValueError("queued message is too large");
    item.text = text; if (prepared) item.prepared = prepared; item.updated_at = pyUtcNow(); await this.atomicSave(sid, r);
    return { id, item: this.publicItem(item) };
  }
  async reorderLocked(sid: string, ids: unknown, expected: unknown, current?: unknown, revision?: unknown): Promise<Row> {
    for (const list of [ids, expected]) if (!Array.isArray(list) || list.length > MAX_PENDING || list.some((v) => typeof v !== "string" || !SID.test(v)) || new Set(list).size !== list.length) throw new PyValueError("expected unique pending queue ids");
    const wanted = ids as string[], previous = expected as string[];
    if (!pyEquals([...wanted].sort(), [...previous].sort())) throw new PyValueError("reordering must preserve every pending message");
    const r = this.read(sid); checkRevision(r, revision); const pending = r.items.filter((row: Row) => ["queued", "paused"].includes(row.status) && row.id !== current) as Row[];
    if (pending.some((row) => ["reserved", "claimed"].includes(row.promotion?.state))) throw new QueueConflict("a queued message is being sent now");
    if (!pyEquals(pending.map((r) => r.id), expected)) throw new QueueConflict("message queue changed; refresh before reordering");
    if (!pyEquals(ids, expected)) { const byId = new Map(pending.map((r) => [r.id, r])); let index = 0; r.items = r.items.map((row: Row) => byId.has(row.id) ? byId.get(wanted[index++]!) : row); await this.atomicSave(sid, r); }
    return { ids };
  }
  async cancelLocked(sid: string, id: string, current?: unknown, expected?: unknown, revision?: unknown): Promise<Row | "not_found" | "claimed"> {
    const r = this.read(sid); checkRevision(r, revision); const item = r.items.find((row: Row) => row.id === id);
    if (!item) return "not_found";
    if (!["queued", "paused"].includes(item.status) || id === current || ["reserved", "claimed"].includes(item.promotion?.state)) return "claimed";
    if (expected != null && item.text !== expected) throw new QueueConflict("queued message changed; refresh before cancelling");
    item.status = "cancelled"; item.updated_at = pyUtcNow(); delete item.prepared; item.text = pySubstring(item.text, 0, 500);
    await this.atomicSave(sid, { schema: 1, accepting: r.accepting, items: trimHistory(r.items) });
    return { removed: true, id, remaining: r.items.filter((row: Row) => ACTIVE.has(row.status)).length };
  }
  update(sid: string, id: string, status: string, completion?: Row): Promise<Row | null> { return this.locked(sid, async () => {
    if (!ACTIVE.has(status) && !FINAL.has(status)) throw new PyValueError("invalid queue status");
    const r = this.read(sid), item = r.items.find((row: Row) => row.id === id); if (!item) return null;
    item.status = status; item.updated_at = pyUtcNow(); if (completion) item.completion = Object.fromEntries(["status", "verified", "tool_execution_status", "delivery_status"].filter((k) => k in completion).map((k) => [k, completion[k]]));
    if (FINAL.has(status)) { item.text = pySubstring(item.text, 0, 500); delete item.prepared; if (item.promotion) item.promotion.state = "settled"; }
    r.items = trimHistory(r.items); await this.atomicSave(sid, r); return this.publicItem(item);
  }); }
  setAccepting(sid: string, accepting: boolean): Promise<Row> { return this.locked(sid, async () => { const r = this.read(sid); r.accepting = !!accepting; await this.atomicSave(sid, r); return r; }); }
  pausePending(sid: string, reason?: string): Promise<Row> { return this.locked(sid, async () => {
    const r = this.read(sid); for (const item of r.items as Row[]) { if (["queued", "running"].includes(item.status)) { item.status = "paused"; item.updated_at = pyUtcNow(); } if (item.status === "paused" && reason) item.pause_reason = pySubstring(reason, 0, 500); }
    r.accepting = false; await this.atomicSave(sid, r); return r;
  }); }
  resumePending(sid: string, current?: string): Promise<Row> { return this.locked(sid, async () => {
    const r = this.read(sid); for (const item of r.items as Row[]) {
      if (["paused", "running"].includes(item.status) && item.id !== current) { item.status = "queued"; delete item.pause_reason; item.updated_at = pyUtcNow(); }
      else if (item.id === current && item.status === "paused") { await this.media.finalize(sid, item); item.status = "running"; delete item.pause_reason; item.updated_at = pyUtcNow(); }
    }
    r.accepting = true; await this.atomicSave(sid, r); return r;
  }); }
  closeIfEmpty(sid: string): Promise<boolean> { return this.locked(sid, async () => { const r = this.read(sid); const pending = r.items.some((row: Row) => ACTIVE.has(row.status)); if (!pending) { r.accepting = false; await this.atomicSave(sid, r); } return pending; }); }
  discard(sid: string): Promise<void> { return this.locked(sid, () => this.atomicSave(sid, { schema: 1, accepting: false, items: [] })); }
}
