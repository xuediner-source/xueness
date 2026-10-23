/** FIFO turn lifecycle, kept inside AgentRunner's single operating-system lease. */
import { createHash } from "node:crypto";
import { appendUserTurn, type AgentContext, type AgentExtension } from "@xueness/agent";
import { isDict, pyDeepCopy, pyEquals, pySubstring, pyTruthy, PyValueError, setOwn, uuid4Hex } from "@xueness/contracts";
import type { Session } from "@xueness/sessions";
import { MediaArtifactStore } from "./media-store.ts";
import { Owner } from "./media-owner.ts";
import { mediaRefs } from "./queue-media.ts";
import { MessageQueue } from "./queue.ts";
import { releasePromotion } from "./steering.ts";
import { MAX_PENDING, type Row } from "./queue-types.ts";
export class QueueRunError extends PyValueError { override name = "QueueRunError"; readonly status = 409; }
export interface QueueRunOptions {
  request: Row;
  stateDir: string;
  preparedRemote?: (prepared: Row) => unknown | Promise<unknown>;
  appendQueued?: (session: Session, item: Row) => void | Promise<void>;
  pendingApprovals?: (session: Session) => readonly unknown[];
}
function safeInputContext(session: Session, p: Row, message: Row): void {
  const metadata = p.metadata ?? {}, safe: Row = {};
  for (const name of ["files", "attachments", "sessions", "skills", "plugins"]) if (Array.isArray(metadata[name])) safe[name] = metadata[name].filter(isDict).slice(0, 100).map((r: Row) => Object.fromEntries(Object.entries(r).filter(([key]) => ["id", "label", "path", "bytes", "size", "sha256", "mimeType"].includes(key))));
  if (isDict(metadata.modelSelection)) safe.modelSelection = Object.fromEntries(Object.entries(metadata.modelSelection).filter(([key, value]) => ["provider_id", "model", "protocol", "capabilities", "reasoning_effort"].includes(key) && (typeof value === "string" || value === null || Array.isArray(value))));
  if (isDict(metadata.remote) && typeof metadata.remote.id === "string" && typeof metadata.remote.digest === "string") safe.remote = { id: metadata.remote.id, digest: metadata.remote.digest };
  const record: Row = { user_turn: (session.messages as Row[]).filter((r) => r.role === "user").length, metadata: safe, content_sha256: createHash("sha256").update(message.content).digest("hex"), message_id: message._message_id };
  if (typeof p.goal === "string" && p.goal.trim()) record.goal = pySubstring(p.goal, 0, 5000);
  ((session.input_context ??= []) as Row[]).push(record);
  const files = safe.files ?? safe.attachments ?? []; if (files.length) ((session.input_attachments ??= []) as Row[]).push({ user_turn: record.user_turn, files });
}
export async function appendQueuedTurn(context: AgentContext, queue: MessageQueue, item: Row, options: QueueRunOptions): Promise<void> {
  const s = context.session, saved = pyDeepCopy(s);
  try {
    await queue.media.finalize(String(s.id), item, s);
    if (options.appendQueued) { await options.appendQueued(s, item); return; }
    const p = item.prepared;
    if (p?.goal === true) throw new QueueRunError("queued goal requires its planning plugin before execution");
    await appendUserTurn(s, context.store, item.text, { queueMessageId: item.id, persist: false });
    if (p) {
      const message = (s.messages as Row[]).at(-1)!; message.content = p.text; message._message_id ??= uuid4Hex();
      safeInputContext(s, p, message);
      if (mediaRefs(p).length) {
        message._media_refs = mediaRefs(p); if (p.media_admission) message._media_admission = p.media_admission;
        await new MediaArtifactStore(options.stateDir).adopt(new Owner("queue", item.id, String(s.root), String(s.id)), new Owner("message", message._message_id, String(s.root), String(s.id)), mediaRefs(p).map((r) => r.id));
      }
    }
    await context.save();
  } catch (e) { for (const key of Object.keys(s)) delete s[key]; for (const [key, value] of Object.entries(saved)) setOwn(s, key, value); throw e; }
}
export function queueRunExtension(options: QueueRunOptions): AgentExtension {
  let queue: MessageQueue, selected: Row | null = null, drained = 0, stopped = false, promotionClaimed = false;
  const requestId = options.request.promotion_request_id as string | undefined;
  const matches = async (s: Session, item: Row): Promise<boolean> => {
    const p = item.prepared; if (!isDict(p)) return true;
    const cached = isDict(p.metadata) && isDict(p.metadata.modelSelection) ? p.metadata.modelSelection : {}, current = isDict(s.model_selection) ? s.model_selection : {};
    if (["provider_id", "model", "reasoning_effort"].some((key) => !pyEquals(cached[key] ?? null, current[key] ?? null))) return false;
    try { return pyEquals(options.preparedRemote ? await options.preparedRemote(p) : (p.metadata as Row | undefined)?.remote ?? null, s.remote_connection ?? null); } catch { return false; }
  };
  const refuseContext = async (sid: string, item: Row): Promise<void> => {
    await queue.update(sid, item.id, "paused"); await queue.pausePending(sid, "Prepared model or remote selection changed; prepare this turn again.");
  };
  const append = async (c: AgentContext, item: Row): Promise<void> => { await appendQueuedTurn(c, queue, item, options); };
  return {
    id: "sessions", capabilities: ["sessions.queue"],
    async beforeRun(c) {
      const sid = String(c.session.id), s = c.session;
      queue = new MessageQueue(c.store, { stateDir: options.stateDir, enabled: c.enabled });
      let current = s.current_queue_item_id;
      let promoted: Row | null = null;
      if (requestId) {
        promoted = await queue.locked(sid, () => queue.read(sid).items.find((r: Row) => r.promotion?.id === requestId) ?? null);
        if (!promoted) throw new QueueRunError("send-now reservation is no longer available");
        if (promoted.promotion.state === "settled") return { stop: true };
        if (!["reserved", "claimed"].includes(promoted.promotion.state) || !["queued", "running", "paused"].includes(promoted.status)) throw new QueueRunError("send-now reservation has already been claimed");
        if (current && current !== promoted.id) { await queue.update(sid, String(current), "cancelled", { status: "stopped", delivery_status: "replaced_by_send_now" }); delete s.current_queue_item_id; current = null; await c.save(); }
      }
      if (options.request.continue_queue && !current && !await queue.hasPending(sid)) throw new QueueRunError("no queued messages to continue");
      await queue.resumePending(sid, typeof current === "string" ? current : undefined);
      if (current && ["completed", "needs_review"].includes(String(s.status)) && isDict(s.completion)) { await queue.update(sid, String(current), String(s.status), s.completion); delete s.current_queue_item_id; current = null; await c.save(); }
      if (promoted) {
        if (promoted.promotion.state === "settled") return { stop: true };
        if (!await matches(s, promoted)) { await releasePromotion(queue, sid, requestId!); await queue.pausePending(sid, "Send-now input needs fresh model or remote preparation."); throw new QueueRunError("prepared send-now input no longer matches this session; prepare it again"); }
        promotionClaimed = true;
        if (current !== promoted.id || promoted.promotion.state !== "claimed") {
          const item = await queue.claimNext(sid);
          if (!item || item.id !== promoted.id) { if (item) await queue.update(sid, item.id, "paused"); await releasePromotion(queue, sid, requestId!); promotionClaimed = false; throw new QueueRunError("send-now reservation changed; refresh the queue"); }
          await append(c, item);
        }
      } else if (!current && (s.status === "completed" || s.status === "needs_review" && options.request.continue_queue)) {
        const item = await queue.claimNext(sid);
        if (!item && options.request.continue_queue) throw new QueueRunError("no queued messages to continue");
        if (item) { if (!await matches(s, item)) { await refuseContext(sid, item); return { stop: true }; } await append(c, item); }
      }
    },
    async settleRun(c) { stopped ||= c.signal.aborted || !!c.options.shouldStop?.(); },
    async afterRun(c) {
      const sid = String(c.session.id), s = c.session, current = s.current_queue_item_id;
      if (current && ["completed", "needs_review"].includes(String(s.status))) { await queue.update(sid, String(current), String(s.status), isDict(s.completion) ? s.completion : undefined); delete s.current_queue_item_id; await c.save(); }
      if (s.status !== "completed") { await queue.pausePending(sid, String(s.pause_reason || s.status || "run paused")); return; }
      if (options.pendingApprovals?.(s).length || pyTruthy(s.pending_question) || stopped || !c.enabled("sessions")) { await queue.pausePending(sid, "Waiting for user action or sessions plugin availability."); return; }
      if (requestId) { await queue.pausePending(sid, "Waiting for an explicit queue continuation after send-now."); return; }
      if (drained >= MAX_PENDING) { await queue.pausePending(sid, "Run limit reached; continue to process remaining queued messages."); return; }
      for (let attempt = 0; attempt <= MAX_PENDING; attempt++) {
        if (!await queue.closeIfEmpty(sid)) return;
        const item = await queue.claimNext(sid); if (!item) continue;
        if (!await matches(s, item)) { await refuseContext(sid, item); return; }
        selected = item; drained += 1; return { action: "continue", prompt: item.text };
      }
    },
    async appendTurn(c) { if (!selected) return false; const item = selected; selected = null; await append(c, item); return true; },
    async close(c) {
      if (!queue) return;
      const sid = String(c.session.id);
      if (requestId && !promotionClaimed) await releasePromotion(queue, sid, requestId);
      await queue.pausePending(sid);
    },
  };
}
