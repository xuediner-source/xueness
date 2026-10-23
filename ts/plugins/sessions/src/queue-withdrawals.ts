/** Atomic text-only recovery escrow. Metadata changes retain the queue CAS. */
import { isDict, pyEquals, pyLen, pySubstring, pyTruthy, pyUtcNow, PyValueError } from "@xueness/contracts";
import { isPyOSError, isPyValueError, pyExceptionName } from "@xueness/sessions";
import type { SessionReply } from "./http-api.ts";
import { queueFor, validateWorkspace } from "./queue-http.ts";
import { validateWithdrawals } from "./queue-validation.ts";
import { ACTIVE, checkRevision, dict, issuedMs, QueueConflict, RETENTION_MS, trimHistory, type Row, type SessionCommandsOptions } from "./queue-types.ts";
const prune = (record: Row): number => { const now = Math.max(Date.now(), record.withdrawalClock ?? 0); record.withdrawalClock = now; record.withdrawals = (record.withdrawals ?? []).filter((r: Row) => r.expiresAt > now); return now; };
export async function withdrawQueue(o: SessionCommandsOptions, commandId: string, payload: Row, sid: string): Promise<SessionReply> {
  issuedMs(commandId); const queue = queueFor(o);
  try {
    return await queue.locked(sid, async () => {
      const session = await o.store.load(sid); await validateWorkspace(o, session);
      const record = queue.read(sid); checkRevision(record, payload.expectedRevision);
      const item = record.items.find((row: Row) => row.id === payload.queueId);
      if (!item) return [404, { error: "queued message not found" }];
      if (!["queued", "paused"].includes(item.status) || item.id === session.current_queue_item_id || ["reserved", "claimed"].includes(item.promotion?.state)) throw new QueueConflict("queued message is already claimed");
      const text = item.text;
      if (text !== payload.expectedText) throw new QueueConflict("queued message changed; refresh before withdrawing");
      if (pyLen(text) < 1 || pyLen(text) > 5000 || text.includes("\0")) throw new PyValueError("withdrawal text must be 1..5000 characters");
      const now = prune(record);
      if (record.withdrawals.some((row: Row) => row.id === commandId)) throw new QueueConflict("withdrawal recovery identity already exists");
      if (record.withdrawals.length >= 32) return [413, { error: "withdrawal recovery storage full; dismiss a saved withdrawal first" }];
      const prepared = item.prepared;
      const hasContext = prepared != null && (prepared.text !== text || pyTruthy(prepared.metadata) || pyTruthy(prepared.goal));
      record.withdrawals.push({ id: commandId, queueId: item.id, sessionId: sid, root: session.root, text, hasContext: !!hasContext, expectedRevision: payload.expectedRevision, createdAt: now, expiresAt: now + RETENTION_MS });
      validateWithdrawals(record, sid); item.status = "cancelled"; item.updated_at = pyUtcNow(); item.text = pySubstring(text, 0, 500); delete item.prepared;
      record.items = trimHistory(record.items); await queue.atomicSave(sid, record);
      return [200, { removed: true, id: item.id, recoveryId: commandId, remaining: record.items.filter((r: Row) => ACTIVE.has(r.status)).length }];
    });
  } catch (e) {
    if (pyExceptionName(e) === "FileNotFoundError") return [404, { error: "session not found" }];
    if (e instanceof QueueConflict) return [409, { error: e.message }];
    if (isPyValueError(e)) return [/full|too large/.test((e as Error).message) ? 413 : 400, { error: (e as Error).message }];
    throw e;
  }
}
export function ownsWithdrawalRoute(_method: string, p: readonly string[]): boolean { return [4, 5].includes(p.length) && p[0] === "api" && p[1] === "sessions" && p[3] === "queue-withdrawals"; }
export async function dispatchWithdrawals(o: SessionCommandsOptions, method: string, p: string[], data: unknown): Promise<SessionReply | null> {
  if (!ownsWithdrawalRoute(method, p)) return null;
  if (!o.enabled("sessions")) return [403, { error: "plugin disabled or dependency unavailable: sessions", plugin: "sessions" }];
  if (!["GET", "DELETE"].includes(method) || method === "DELETE" && p.length !== 5) return [405, { error: "method not allowed" }];
  if (data != null && !pyEquals(data, {})) return [400, { error: "withdrawal recovery does not accept a request body" }];
  const sid = p[2]!, queue = queueFor(o);
  try {
    queue.path(sid); if (p.length === 5) issuedMs(p[4]);
    return await queue.locked(sid, async () => {
      const session = await o.store.load(sid); await validateWorkspace(o, session);
      const record = queue.read(sid); prune(record);
      const rows = record.withdrawals.filter((row: Row) => row.root === session.root), row = p.length === 5 ? rows.find((r: Row) => r.id === p[4]) : undefined;
      if (method === "DELETE") record.withdrawals = record.withdrawals.filter((r: Row) => r !== row);
      await queue.atomicSave(sid, record);
      if (method === "DELETE") return [200, { dismissed: true, id: p[4] }];
      if (p.length === 4) return [200, { withdrawals: rows.map((r: Row) => Object.fromEntries(Object.entries(r).filter(([key]) => key !== "text"))) }];
      return row ? [200, { withdrawal: row }] : [404, { error: "withdrawal recovery not found" }];
    });
  } catch (e) {
    if (pyExceptionName(e) === "FileNotFoundError") return [404, { error: "session not found" }];
    if (isPyValueError(e)) return [400, { error: (e as Error).message }];
    if (isPyOSError(e)) return [503, { error: "withdrawal recovery storage unavailable" }]; throw e;
  }
}
