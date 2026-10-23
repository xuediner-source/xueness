/** Revision-bound message edits. Workspace effects are never implicitly undone. */
import { lstatSync } from "node:fs";
import { createHash } from "node:crypto";
import { isDict, isPyIntValue, pyDecodeUtf8, pyDeepCopy, pyEquals, pyJsonLoads, pyLen, pyStrip, PyValueError, uuid4Hex } from "@xueness/contracts";
import { isLink, isPyOSError, isPyValueError, pyExceptionName, readRegularBytes, type Session, type SessionStore } from "@xueness/sessions";
import { messageRevision } from "./journal-http.ts";
import { MessageQueue } from "./queue.ts";
import { externalRun } from "./queue-http.ts";
import { pendingDenials } from "./public-session.ts";
import { MediaArtifactStore } from "./media-store.ts";
import { messageOwner, messageRefs } from "./media-history.ts";
import { bindMediaMessage, consumeInput, finalizePreparedMedia, reservePreparedMedia, safeInputContext, type PreparedInputOptions } from "./prepared-input.ts";
import type { SessionReply, SessionRequest, SessionsApiOptions } from "./http-api.ts";
type Row = Record<string, any>;
export const MESSAGE_ACTION_ROUTES = ["PATCH /api/sessions/:id/message-actions"];
export class MessageActionError extends PyValueError { override name = "MessageActionError"; readonly status: number; readonly stale: boolean; constructor(message: string, status = 400, stale = false) { super(message); this.status = status; this.stale = stale; } }
function fail(message: string, status = 400): never { throw new MessageActionError(message, status); }
export function validateMessageAction(data: unknown): asserts data is Row {
  if (!isDict(data) || !["revision", "messageIndex", "action"].every((k) => Object.hasOwn(data, k)) || Object.keys(data).some((k) => !["revision", "messageIndex", "action", "text", "feedback", "prepared_token"].includes(k))) fail("invalid message action");
  if (typeof data.revision !== "string" || !/^sha256:[0-9a-f]{64}$/.test(data.revision)) fail("invalid message revision");
  if (!isPyIntValue(data.messageIndex) || Number(data.messageIndex) < 0 || !["edit", "feedback"].includes(String(data.action))) fail("invalid message target");
  if (data.action === "edit") {
    if (Object.hasOwn(data, "feedback") || typeof data.text !== "string" || !pyStrip(data.text) || pyLen(data.text) > 50000 || data.text.includes("\0")) fail("invalid edited message");
    if (Object.hasOwn(data, "prepared_token") && (typeof data.prepared_token !== "string" || !/^[0-9a-f]{32}$/.test(data.prepared_token))) fail("invalid prepared attachment replacement");
  } else if (Object.hasOwn(data, "prepared_token") || Object.hasOwn(data, "text") || !Object.hasOwn(data, "feedback") || ![null, "like", "dislike"].includes(data.feedback as string | null)) fail("invalid message feedback");
}
function attachmentContext(s: Session, index: number): Row | null {
  const messages = s.messages as Row[], message = messages[index]; if (!message || typeof message.content !== "string") return null;
  // Metadata from a discarded or edited message cannot grant attachment scope.
  const digest = createHash("sha256").update(message.content).digest("hex");
  return (Array.isArray(s.input_context) ? s.input_context : []).findLast((c) => isDict(c) && isDict(c.metadata) && (c.message_id != null ? c.message_id === message._message_id && (c.content_sha256 == null || c.content_sha256 === digest) : c.content_sha256 != null ? c.content_sha256 === digest : c.user_turn === messages.slice(0, index + 1).filter((m) => m.role === "user").length)) as Row | undefined ?? null;
}
export function supportsMessageAction(s: Session, data: Row, options: SessionsApiOptions): boolean {
  if (data.action !== "edit") return true;
  if (Object.hasOwn(data, "prepared_token") && !options.consumePrepared) return false;
  const context = attachmentContext(s, Number(data.messageIndex));
  return !context || !["attachments", "files"].some((key) => Array.isArray(context.metadata[key]) && context.metadata[key].length > 0) || !!options.preserveAttachments;
}
function readSnapshot(store: SessionStore, sid: string): Session {
  const path = store.pathFor(sid); if (isLink(path)) fail("session file is a symbolic link");
  let stat; try { stat = lstatSync(path); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") fail("session not found", 404); throw e; }
  if (!stat.isFile()) fail("session file is not regular"); if (stat.size > 16 * 1024 * 1024) fail("session journal exceeds fork size limit", 413);
  let s: unknown; try { s = pyJsonLoads(pyDecodeUtf8(readRegularBytes(path)), { lossless: true }); } catch (e) { if (isPyValueError(e)) fail("session journal is invalid JSON"); throw e; }
  if (!isDict(s) || s.id !== sid) fail("session journal is invalid");
  if (typeof s.task !== "string" || !pyStrip(s.task) || pyLen(s.task) > 5000 || typeof s.root !== "string" || !pyStrip(s.root) || pyLen(s.root) > 4096 || /[\x00-\x1f\x7f]/.test(s.root)) fail("session task or workspace is invalid");
  if (!Array.isArray(s.messages) || s.messages.length > 5000) fail("session message count exceeds fork limit", 413);
  if (s.results != null && !isDict(s.results)) fail("session results are invalid"); return s;
}
async function preserve(options: SessionsApiOptions, s: Session, index: number, text: string): Promise<string> {
  const message = (s.messages as Row[])[index]!, refs = messageRefs(message);
  if (refs.length) { const media = new MediaArtifactStore(options.stateDir), owner = messageOwner(s, message); for (const ref of refs) if (!pyEquals(await media.describe(owner, ref.id), ref)) throw new PyValueError("saved media metadata changed"); }
  if (options.preserveAttachments) return options.preserveAttachments(s, index, text);
  const context = attachmentContext(s, index); if (context) { context.content_sha256 = createHash("sha256").update(text).digest("hex"); if (typeof message._message_id === "string") context.message_id = message._message_id; }
  return text;
}
async function update(options: SessionsApiOptions, preparedOptions: PreparedInputOptions, sid: string, data: Row, command?: SessionRequest["command"]): Promise<Row | null> {
  validateMessageAction(data); if (options.running?.has(sid)) fail("session run already in progress", 409);
  if (await externalRun(options, sid)) fail("session is running in another process", 409);
  const lease = await options.store.lease(sid);
  try { const s = readSnapshot(options.store, sid), stream = s.streaming;
    if (stream != null && !isDict(stream)) fail("saved streaming state is invalid", 409);
    if (s.status === "running" || isDict(stream) && stream.status === "streaming") fail("session run already in progress", 409);
    if (!supportsMessageAction(s, data, options)) return null;
    const queue = new MessageQueue(options.store, { stateDir: options.stateDir, enabled: options.enabled });
    return await queue.locked(sid, async () => {
      if (messageRevision(s) !== data.revision) throw new MessageActionError("conversation changed; refresh before editing this message", 409, true);
      const messages = s.messages as Row[], index = Number(data.messageIndex), message = messages[index];
      if (!message || !isDict(message)) fail("message not found", 404);
      if (message.role !== (data.action === "edit" ? "user" : "assistant")) fail("message role does not support this action");
      let prepared: Row | null = null, target: ReturnType<typeof bindMediaMessage> | null = null;
      if (data.action === "feedback") {
        if (!message.content) fail("message has no answer to rate"); s.message_annotations ??= {}; if (!isDict(s.message_annotations)) fail("invalid saved feedback", 409);
        const annotations = s.message_annotations as Row; annotations[String(index)] ??= {}; if (!isDict(annotations[String(index)])) fail("invalid saved message annotation", 409);
        if (data.feedback === null) delete annotations[String(index)].feedback; else annotations[String(index)].feedback = data.feedback;
      } else {
        if ((queue.snapshotLocked(sid).queued_messages as unknown[]).length) fail("cancel queued messages before editing history", 409);
        if (["reasoning_history", "reasoning_timing", "completion_history", "archived_messages", "history_hidden_message_ids"].some((k) => !Array.isArray(s[k] ?? [])) || !isDict(s.message_annotations ?? {})) fail("saved conversation metadata is invalid", 409);
        const hidden = new Set<string>((s.history_hidden_message_ids ?? []) as string[]); if ([...hidden].some((v) => typeof v !== "string" || !v)) fail("saved conversation metadata is invalid", 409);
        const prefix = messages.slice(0, index); if (prefix.some((m) => !isDict(m) || !Array.isArray(m.tool_calls ?? []))) fail("earlier history is malformed", 409);
        if (pendingDenials({ messages: prefix, results: s.results ?? {} }).length) fail("earlier history has unresolved tool approvals", 409);
        const turn = 1 + prefix.filter((m) => m.role === "user").length, text = data.text as string; if (turn === 1 && pyLen(text) > 5000) fail("initial task exceeds 5000 characters");
        const id = message._message_id, number = typeof message._turn_id === "string" && /^turn-[1-9][0-9]*$/.test(message._turn_id) ? Number(message._turn_id.slice(5)) : turn;
        for (const m of [...messages.slice(index + 1), ...(s.archived_messages ?? []) as Row[]]) if (isDict(m) && typeof m._message_id === "string" && m._message_id && m._message_id !== id && (messages.slice(index + 1).includes(m) || typeof m._turn_id === "string" && /^turn-[1-9][0-9]*$/.test(m._turn_id) && Number(m._turn_id.slice(5)) >= number)) hidden.add(m._message_id);
        if (typeof id === "string") hidden.delete(id); s.history_hidden_message_ids = [...hidden].sort(); const edited = pyDeepCopy(message);
        if (Object.hasOwn(data, "prepared_token")) {
          if (Array.isArray(message.content)) fail("original attachments cannot be fully restored; cancel editing", 409); await preserve(options, s, index, text);
          if (!command) fail("attachment edits require a stable command envelope"); prepared = await consumeInput(preparedOptions, data.prepared_token, String(s.root));
          if (prepared.edit_prefix !== pyStrip(text)) fail("prepared attachment text does not match edited message"); edited.content = prepared.text;
          if (typeof id === "string" && id) s.history_hidden_message_ids = [...new Set([...(s.history_hidden_message_ids as string[]), id])].sort(); edited._message_id = uuid4Hex(); delete edited._media_refs; delete edited._media_admission;
        } else if (Array.isArray(message.content)) edited.content = [{ type: "text", text }, ...(edited.content as unknown[]).filter((p: unknown) => !isDict(p) || p.type !== "text")];
        else edited.content = await preserve(options, s, index, text);
        s.messages = [...prefix, edited];
        if (prepared) { for (const key of ["input_context", "input_attachments"]) s[key] = (Array.isArray(s[key]) ? s[key] : []).filter((r) => isDict(r) && isPyIntValue(r.user_turn) && Number(r.user_turn) < turn); target = bindMediaMessage(s, prepared); await reservePreparedMedia(preparedOptions, prepared, target, command); safeInputContext(s, prepared); }
        if (typeof edited._message_id === "string" && /^[A-Za-z0-9_.:-]{1,160}$/.test(edited._message_id)) s.message_edit_history = [...Array.isArray(s.message_edit_history) ? s.message_edit_history : [], { message_id: edited._message_id, revision: data.revision }].slice(-100);
        if (turn === 1) s.task = text; const calls = new Set(prefix.flatMap((m) => (m.tool_calls ?? []).filter(isDict).map((c: Row) => c.id)));
        s.results = Object.fromEntries(Object.entries(isDict(s.results) ? s.results : {}).filter(([id]) => calls.has(id)));
        for (const key of ["reasoning_history", "reasoning_timing"]) s[key] = ((s[key] ?? []) as Row[]).filter((r) => isDict(r) && isPyIntValue(r.message_index) && Number(r.message_index) < index);
        s.message_annotations = Object.fromEntries(Object.entries(isDict(s.message_annotations) ? s.message_annotations : {}).filter(([key]) => /^\d+$/u.test(key) && Number(key) < index));
        s.completion_history = ((s.completion_history ?? []) as Row[]).filter((r) => isDict(r) && /^turn-[1-9][0-9]*$/.test(String(r.turn_id)) && Number(String(r.turn_id).slice(5)) < turn);
        Object.assign(s, { status: "pending", steps: 0, completion: null, todos: [], pending_question: null, pause_code: null, pause_reason: null, streaming: null, runtime_activity: null, runtime_activity_history: [] }); delete s.current_queue_item_id; delete s.runtime_budget; options.lifecycle?.approvals.delete(sid); options.lifecycle?.liveApprovals?.close(sid);
      }
      await options.store.save(s); if (prepared && target) await finalizePreparedMedia(preparedOptions, prepared, target, target);
      return { id: sid, messageIndex: data.messageIndex, revision: messageRevision(s), action: data.action };
    });
  } finally { await lease.release(); }
}
export function createMessageActionsApi(options: SessionsApiOptions, prepared: PreparedInputOptions) {
  return { routes: MESSAGE_ACTION_ROUTES, owns: (method: string, p: readonly string[]) => method === "PATCH" && p.length === 4 && p[0] === "api" && p[1] === "sessions" && p[3] === "message-actions",
    async dispatch(method: string, p: string[], _query: Row, data: unknown, request: SessionRequest = {}): Promise<SessionReply | null> {
      if (!this.owns(method, p)) return null; if (!options.enabled("sessions")) return [403, { error: "plugin disabled or dependency unavailable: sessions", plugin: "sessions" }];
      try { options.store.pathFor(p[2]!); const result = await update(options, prepared, p[2]!, data as Row, request.command); return result ? [200, result] : null; }
      catch (e) { if (e instanceof MessageActionError) return [e.status, { error: e.message, error_code: e.status === 409 ? "message_action_conflict" : "invalid_message_action", ...(e.stale ? { reasonCode: "history_changed" } : {}) }]; if (pyExceptionName(e) === "BlockingIOError") return [409, { error: "session is in use by another process", error_code: "message_action_conflict" }]; if (isPyOSError(e) || isPyValueError(e)) return [500, { error: "cannot update conversation message" }]; throw e; }
    } };
}
