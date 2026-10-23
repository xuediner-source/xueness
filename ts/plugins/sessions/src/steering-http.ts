import { isDict, pyLen, pyStrip, pyTruthy } from "@xueness/contracts";
import { isPyOSError, isPyValueError, pyExceptionName } from "@xueness/sessions";
import type { SessionReply } from "./http-api.ts";
import { consumePrepared, externalRun, queueFor, sessionBusy, validateWorkspace } from "./queue-http.ts";
import { MessageQueue } from "./queue.ts";
import { SteeringInbox, reservePromotion } from "./steering.ts";
import { dict, fingerprint, keysAre, onlyKeys, QueueConflict, SID, validateRevision, type Row, type SessionCommandsOptions } from "./queue-types.ts";
const inboxFor = (o: SessionCommandsOptions) => new SteeringInbox(o.store, { stateDir: o.stateDir, enabled: o.enabled, command: o.mediaCommand });
export function ownsSteeringRoute(_method: string, p: readonly string[]): boolean { return p[0] === "api" && p[1] === "sessions" && (p[3] === "steer-query" && p.length === 4 || p[3] === "steer" && [4, 5].includes(p.length) || p[3] === "queue" && p[5] === "send-now" && p.length === 6); }
async function queryOperation(o: SessionCommandsOptions, sid: string, data: unknown): Promise<SessionReply> {
  if (!o.enabled("sessions")) return [403, { error: "sessions plugin unavailable" }];
  if (!SID.test(sid)) return [404, { error: "session not found" }];
  if (!isDict(data)) return [400, { error: "invalid guidance query" }];
  const operation = data.operation;
  if (!["send", "promote", "cancel"].includes(String(operation))) return [400, { error: "invalid guidance operation" }];
  const body = dict(data.payload); let identity: string, fp = "";
  if (operation === "cancel") {
    if (!keysAre(data, ["operation", "guidanceId"]) || typeof data.guidanceId !== "string" || !SID.test(data.guidanceId)) return [400, { error: "invalid guidance identity" }];
    identity = data.guidanceId;
  } else {
    if (!keysAre(data, ["operation", "payload", ...(operation === "promote" ? ["queueId"] : [])]) || !isDict(data.payload) || !onlyKeys(body, ["request_id", "expected_turn_id", ...(operation === "send" ? ["text", "prepared_token"] : ["expectedRevision"])]) || typeof body.request_id !== "string" || !SID.test(body.request_id)) return [400, { error: "invalid original guidance envelope" }];
    identity = body.request_id;
    if (operation === "promote" && (typeof data.queueId !== "string" || !SID.test(data.queueId))) return [400, { error: "invalid queue identity" }];
    fp = fingerprint({ ...body, ...(operation === "promote" ? { queue_id: data.queueId } : {}) });
  }
  const inbox = operation === "promote" ? queueFor(o) : inboxFor(o);
  try {
    return await inbox.locked(sid, async () => {
      const session = await o.store.load(sid); await validateWorkspace(o, session);
      for (const item of inbox.read(sid).items as Row[]) {
        if (operation === "cancel") { if (item.id === identity && item.status === "cancelled") return [200, { requestId: identity, result: "accepted", receipt: { id: identity, removed: true } }]; continue; }
        const saved = item[operation === "promote" ? "promotion" : "submission"];
        if (!isDict(saved) || saved.id !== identity) continue;
        if (saved.fingerprint !== fp || operation === "promote" && item.id !== data.queueId) return [409, { error: "original guidance envelope does not match" }];
        if (!isDict(saved.receipt)) return [503, { error: "guidance receipt unavailable" }];
        return [200, { requestId: identity, result: operation === "promote" && saved.state === "released" ? "released" : "accepted", receipt: operation === "send" ? { id: saved.receipt.id, item: saved.receipt } : saved.receipt }];
      }
      return [200, { requestId: identity, result: "unknown" }];
    });
  } catch (e) {
    if (pyExceptionName(e) === "FileNotFoundError") return [404, { error: "session not found" }];
    if (isPyValueError(e) || pyExceptionName(e) === "KeyError") return [409, { error: "guidance state unavailable" }];
    if (isPyOSError(e)) return [503, { error: "guidance storage unavailable" }]; throw e;
  }
}
export async function dispatchSteering(o: SessionCommandsOptions, method: string, p: string[], data: unknown): Promise<SessionReply | null> {
  if (!ownsSteeringRoute(method, p)) return null;
  const sid = p[2]!;
  if (p[3] === "steer-query") return method === "POST" ? queryOperation(o, sid, data) : [405, { error: "method not allowed" }];
  if (!o.enabled("sessions")) return [403, { error: "plugin disabled or dependency unavailable: sessions", plugin: "sessions" }];
  if (!SID.test(sid)) return [404, { error: "session not found" }];
  const guide = p[3] === "steer", body = dict(data), inbox: MessageQueue = guide ? inboxFor(o) : queueFor(o);
  if (method !== "GET" && await externalRun(o, sid)) return sessionBusy();
  try {
    return await inbox.locked(sid, async (): Promise<SessionReply> => {
      const session = await o.store.load(sid); await validateWorkspace(o, session);
      if (guide && method === "GET" && p.length === 4) { const snapshot = inbox.snapshotLocked(sid); return [200, { pending_guidance: snapshot.queued_messages, guidance_history: snapshot.queue_history }]; }
      if (guide && method === "DELETE" && p.length === 5) {
        const r = await inbox.cancelLocked(sid, p[4]!); return r === "not_found" ? [404, { error: "current-turn input not found" }] : r === "claimed" ? [409, { error: "current-turn input is already delivered" }] : [200, r];
      }
      if (method !== "POST" || guide && p.length !== 4) return [405, { error: "method not allowed" }];
      if (!onlyKeys(body, ["request_id", "expected_turn_id", ...(guide ? ["text", "prepared_token"] : ["expectedRevision"])]) || typeof body.request_id !== "string" || !SID.test(body.request_id)) return [400, { error: "expected request_id and expected_turn_id" }];
      if (!guide && "expectedRevision" in body) validateRevision(body.expectedRevision);
      const turn = body.expected_turn_id;
      if (typeof turn !== "string" || !turn || pyLen(turn) > 128) return [400, { error: "expected_turn_id is required" }];
      const fp = fingerprint({ ...body, ...(!guide ? { queue_id: p[4] } : {}) });
      if (guide) { const replay = await inbox.replayLocked(sid, body.request_id, fp, session); if (replay) return [202, { id: replay.id, item: replay, replayed: true }]; }
      else for (const row of inbox.read(sid).items as Row[]) if (row.promotion?.id === body.request_id) {
        if (row.promotion.fingerprint !== fp) throw new QueueConflict("request_id already used for different promotion");
        if (row.promotion.state === "released") throw new QueueConflict("previous send-now reservation was released; try again");
        return [202, { ...row.promotion.receipt, replayed: true }];
      }
      if (!o.running?.has(sid) || session.active_turn_id !== turn) throw new QueueConflict("active turn changed; refresh before submitting input");
      if (pyTruthy(session.pending_question) || session.status === "awaiting_user") throw new QueueConflict("answer the pending question before submitting input");
      if (!guide) { const [receipt, replayed] = await reservePromotion(inbox, sid, p[4]!, body.request_id, fp, turn, body.expectedRevision); o.requestStop?.(sid, turn); return [202, { ...receipt, replayed }]; }
      const text = body.text, token = body.prepared_token;
      if (typeof text !== "string" || pyLen(pyStrip(text)) < 1 || pyLen(pyStrip(text)) > 5000 || text.includes("\0")) return [400, { error: "message must be 1..5000 characters" }];
      if (token != null && (typeof token !== "string" || !token || pyLen(token) > 128)) return [400, { error: "prepared input invalid or expired" }];
      const prepared = await consumePrepared(o, session, token, true);
      const [receipt, replayed] = await (inbox as SteeringInbox).admitLocked(sid, text, turn, body.request_id, fp, prepared);
      return [202, { id: receipt.id, item: receipt, replayed }];
    });
  } catch (e) {
    if (pyExceptionName(e) === "FileNotFoundError") return [404, { error: "session or queued message not found" }];
    if (e instanceof QueueConflict) return [409, { error: e.message }];
    if (isPyValueError(e) || ["KeyError", "TypeError"].includes(pyExceptionName(e))) return [400, { error: (e as Error).message }];
    if (isPyOSError(e)) return [503, { error: "cannot persist current-turn input" }]; throw e;
  }
}
