import { isAbsolute, relative } from "node:path";
import { isDict, pyEquals, pyLen, pyStrip, pyTruthy, PyValueError } from "@xueness/contracts";
import { isPyOSError, isPyValueError, pyExceptionName, realish } from "@xueness/sessions";
import type { SessionReply } from "./http-api.ts";
import { MessageQueue } from "./queue.ts";
import { dict, fingerprint, keysAre, onlyKeys, QueueConflict, SID, validateExpectedTurn, validateRevision, type Row, type SessionCommandsOptions } from "./queue-types.ts";
export function queueFor(o: SessionCommandsOptions): MessageQueue { return new MessageQueue(o.store, { stateDir: o.stateDir, enabled: o.enabled, command: o.mediaCommand }); }
/** The lease is authoritative when another backend owns a run absent from our live map. */
/** Another process holds the session lease; round 10 has no backend to relay to. */
export function sessionBusy(): [number, Row] { return [409, { error: "session is running in another process", code: "session_busy" }]; }
export async function externalRun(o: SessionCommandsOptions, sid: string): Promise<boolean> {
  if (o.running?.has(sid)) return false;
  try { const held = await o.store.lease(sid); await held.release(); return false; }
  catch (e) { if (pyExceptionName(e) === "BlockingIOError") return true; throw e; }
}
export async function validateWorkspace(o: SessionCommandsOptions, session: Row): Promise<void> {
  if (o.validateWorkspace) { await o.validateWorkspace(session); return; }
  if (typeof session.root !== "string" || !session.root) throw new PyValueError("workspace root not permitted");
  const target = realish(session.root), roots = [o.webRuns, o.projectDir, ...(o.allowedRoots?.() ?? [])].map(realish);
  if (!roots.some((root) => { const p = relative(root, target); return p === "" || !p.startsWith("..") && !isAbsolute(p); })) throw new PyValueError("workspace root not permitted");
}
export async function consumePrepared(o: SessionCommandsOptions, session: Row, token: unknown, guide = false): Promise<Row | null> {
  if (token == null) return null;
  if (!o.consumePrepared) throw new PyValueError("prepared input invalid or expired");
  const prepared = await o.consumePrepared(token as string, session.root), context = o.activeContext?.get(session.id) ?? {};
  const selection = context.model_selection || session.model_selection || {}, chosen = prepared.metadata?.modelSelection || {};
  if (["provider_id", "model", "reasoning_effort"].some((key) => !pyEquals(chosen[key] ?? null, selection[key] ?? null))) throw new QueueConflict(guide ? "current-turn input must use the active model selection" : "queued turn must use the active model selection");
  const remote = "remote_connection" in context ? context.remote_connection : session.remote_connection;
  if (!pyEquals(o.preparedRemote ? await o.preparedRemote(prepared) : prepared.remote_connection ?? prepared.metadata?.remote ?? null, remote ?? null)) throw new QueueConflict(guide ? "current-turn input must use the active remote connection" : "queued turn must use the active remote connection");
  if (guide && pyTruthy(prepared.goal)) throw new QueueConflict("goal changes must start a new turn");
  return Object.fromEntries(["text", "metadata", ...(!guide ? ["goal", "edit_prefix"] : []), "media_sources"].filter((key) => key in prepared).map((key) => [key, prepared[key]]));
}
export async function reconcileInactive(o: SessionCommandsOptions, queue: MessageQueue, sid: string): Promise<boolean> {
  if (o.running?.has(sid)) return true;
  try {
    const lease = await o.store.lease(sid);
    try { try { await o.store.load(sid); } catch (e) { if (isPyOSError(e) || isPyValueError(e)) return false; throw e; } if (!o.running?.has(sid)) await queue.pausePending(sid); }
    finally { await lease.release(); }
  } catch (e) { if (pyExceptionName(e) !== "BlockingIOError") throw e; }
  return true;
}
export function ownsQueueRoute(_method: string, parts: readonly string[]): boolean { return [4, 5].includes(parts.length) && parts[0] === "api" && parts[1] === "sessions" && parts[3] === "queue"; }
export async function dispatchQueue(o: SessionCommandsOptions, method: string, parts: string[], data: unknown): Promise<SessionReply | null> {
  if (!ownsQueueRoute(method, parts)) return null;
  if (!o.enabled("sessions")) return [403, { error: "plugin disabled or dependency unavailable: sessions", plugin: "sessions" }];
  const sid = parts[2]!, store = o.store, queue = queueFor(o), body = dict(data);
  if (!SID.test(sid)) return [404, { error: "session not found" }];
  let session: Row;
  try { session = await store.load(sid); } catch (e) { if (isPyOSError(e) || isPyValueError(e)) return [404, { error: "session not found" }]; throw e; }
  if (method !== "GET" && await externalRun(o, sid)) return o.mediaCommand ? [409, { error: "session is in use by another process" }] : sessionBusy();
  try { if (isDict(data) && "expectedRevision" in data) validateRevision(data.expectedRevision); } catch (e) { return [400, { error: (e as Error).message }]; }
  const errorResult = (e: unknown, operation: string, deleting = false): SessionReply => {
    if (pyExceptionName(e) === "FileNotFoundError") return [404, { error: deleting ? "session not found" : parts.length === 5 ? "queued message not found" : "session not found" }];
    if (e instanceof QueueConflict) return [409, { error: e.message }];
    if (isPyValueError(e)) return deleting ? [500, { error: "cannot update message queue" }] : [400, { error: (e as Error).message }];
    if (isPyOSError(e)) return [deleting ? 500 : 503, { error: `cannot ${operation} message queue` }];
    throw e;
  };
  if (parts.length === 5) {
    const id = parts[4]!;
    if (method === "PATCH") {
      if (!isDict(data) || !keysAre(Object.fromEntries(Object.entries(data).filter(([k]) => k !== "expectedRevision")), ["text", "expectedText"])) return [400, { error: "expected text and expectedText" }];
      try { return await queue.locked(sid, async () => { session = await store.load(sid); await validateWorkspace(o, session); return [200, await queue.editLocked(sid, id, body.text, body.expectedText, session.current_queue_item_id, body.expectedRevision)]; }); }
      catch (e) { return errorResult(e, "update"); }
    }
    if (method !== "DELETE") return [405, { error: "method not allowed" }];
    if (data != null && (!isDict(data) || !onlyKeys(data, ["expectedText", "expectedRevision"]))) return [400, { error: "queue deletion accepts only optional expectedText and expectedRevision" }];
    if ("expectedText" in body && (typeof body.expectedText !== "string" || pyLen(body.expectedText) > 5000)) return [400, { error: "expectedText must be a string of at most 5000 characters" }];
    try {
      const result = await queue.locked(sid, async () => { session = await store.load(sid); return queue.cancelLocked(sid, id, session.current_queue_item_id, body.expectedText, body.expectedRevision); });
      return result === "not_found" ? [404, { error: "queued message not found" }] : result === "claimed" ? [409, { error: "queued message is already claimed" }] : [200, result];
    } catch (e) { return errorResult(e, "update", true); }
  }
  if (method === "PATCH") {
    if (!isDict(data) || !keysAre(Object.fromEntries(Object.entries(data).filter(([k]) => k !== "expectedRevision")), ["ids", "expectedIds"])) return [400, { error: "expected ids and expectedIds" }];
    try { return await queue.locked(sid, async () => { session = await store.load(sid); await validateWorkspace(o, session); return [200, await queue.reorderLocked(sid, body.ids, body.expectedIds, session.current_queue_item_id, body.expectedRevision)]; }); }
    catch (e) { return errorResult(e, "update"); }
  }
  if (method === "GET") {
    try { if (!await reconcileInactive(o, queue, sid)) return [404, { error: "session not found" }]; return await queue.locked(sid, async () => { await store.load(sid); return [200, queue.snapshotLocked(sid)]; }); }
    catch (e) { if (pyExceptionName(e) === "FileNotFoundError") return [404, { error: "session not found" }]; if (isPyOSError(e) || isPyValueError(e)) return [500, { error: "cannot read message queue" }]; throw e; }
  }
  if (method !== "POST") return [405, { error: "method not allowed" }];
  if (!onlyKeys(body, ["text", "prepared_token", "request_id", "expected_turn_id"])) return [400, { error: "expected text and optional prepared_token/request_id/expected_turn_id only" }];
  const fenced = "expected_turn_id" in body;
  try { if (fenced) validateExpectedTurn(body.expected_turn_id); } catch (e) { return [400, { error: (e as Error).message }]; }
  if ("request_id" in body && (typeof body.request_id !== "string" || !SID.test(body.request_id))) return [400, { error: "request_id must be 32 lowercase hexadecimal characters" }];
  if (typeof body.text !== "string" || !pyStrip(body.text) || pyLen(body.text) > 5000) return [400, { error: "message must be 1..5000 characters" }];
  if (body.prepared_token != null && (typeof body.prepared_token !== "string" || pyLen(body.prepared_token) > 128)) return [400, { error: "prepared input invalid or expired" }];
  const fp = fingerprint({ text: body.text, prepared_token: body.prepared_token ?? null, ...(fenced ? { expected_turn_id: body.expected_turn_id } : {}) });
  try { if (!fenced && !await reconcileInactive(o, queue, sid)) return [404, { error: "session not found" }]; }
  catch (e) { if (isPyOSError(e) || isPyValueError(e)) return [500, { error: "cannot reconcile message queue" }]; throw e; }
  return queue.locked(sid, async () => {
    const admit = async (current: Row): Promise<SessionReply> => {
      const active = !!o.running?.has(sid); let snapshot: Row;
      try {
        const replay = await queue.replayLocked(sid, body.request_id, fp, current); if (replay) return [202, { id: replay.id, item: replay, replayed: true }];
        snapshot = queue.snapshotLocked(sid);
        if (fenced && (!active || current.status !== "running" || current.active_turn_id !== body.expected_turn_id || pyTruthy(current.pending_question) || !queue.read(sid).accepting)) return [409, { error: "the observed turn is no longer accepting queued messages", reasonCode: "stale_turn" }];
      } catch (e) { if (e instanceof QueueConflict) return [409, { error: e.message }]; if (isPyOSError(e) || isPyValueError(e)) return [500, { error: "cannot read message queue" }]; throw e; }
      if (!active && !snapshot.queued_messages.length) return [409, { error: "message queue is available only during an active run or while queued turns remain" }];
      if (pyTruthy(current.pending_question) || current.status === "awaiting_user") return [409, { error: "answer the pending question before queueing another message" }];
      let prepared: Row | null;
      try { prepared = await consumePrepared(o, current, body.prepared_token); }
      catch (e) { if (e instanceof QueueConflict) return [409, { error: e.message }]; if (isPyValueError(e)) return [400, { error: /prepared/i.test((e as Error).message) ? "prepared input invalid or expired" : (e as Error).message }]; throw e; }
      try { const item = await queue.enqueueLocked(sid, body.text, prepared, { activeRun: active, requestId: body.request_id, fingerprint: fp, session: current }); return [202, { id: item.id, item }]; }
      catch (e) { if (e instanceof QueueConflict) return [409, { error: e.message }]; if (isPyOSError(e) || isPyValueError(e)) return [/too large|full/i.test((e as Error).message) ? 413 : 400, { error: (e as Error).message }]; throw e; }
    };
    try { return fenced ? await store.withJournalLock(sid, () => admit(store.readJournal(sid))) : await admit(await store.load(sid)); }
    catch (e) { if (isPyOSError(e) || isPyValueError(e)) return [404, { error: "session not found" }]; throw e; }
  });
}
