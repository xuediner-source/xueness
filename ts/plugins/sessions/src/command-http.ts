/** Durable admission claims prevent retries from executing uncertain writes twice. */
import { isDict, pyTruthy, PyValueError } from "@xueness/contracts";
import { isPyOSError, isPyValueError } from "@xueness/sessions";
import type { SessionReply } from "./http-api.ts";
import { CommandReceipts, acknowledgement, MAX_COMMANDS } from "./command-receipts.ts";
import { validateCommand, validateNewCommand } from "./command-validation.ts";
import { dispatchQueue, externalRun } from "./queue-http.ts";
import { dispatchWithdrawals, ownsWithdrawalRoute, withdrawQueue } from "./queue-withdrawals.ts";
import { dispatchSteering, ownsSteeringRoute } from "./steering-http.ts";
import { ownsQueueRoute } from "./queue-http.ts";
import { dict, fingerprint, issuedMs, RETENTION_MS, SID, type Row, type SessionCommandsOptions } from "./queue-types.ts";
const UNKNOWN = (id: unknown): SessionReply => [503, { error: "command outcome unknown; query the command without resubmitting", commandId: id, reasonCode: "command_unknown" }];
export function ownsCommandRoute(_method: string, p: readonly string[]): boolean { return p[0] === "api" && p[1] === "sessions" && (p[2] === "commands" && [3, 4].includes(p.length) || p[3] === "commands" && [4, 5].includes(p.length)); }
async function execute(o: SessionCommandsOptions, sid: string, data: Row, fp: string): Promise<SessionReply> {
  const options = { ...o, mediaCommand: { id: data.commandId, fingerprint: fp } }, type = data.type, payload = data.payload as Row;
  if (!o.enabled("sessions")) return [403, { error: "plugin disabled or dependency unavailable: sessions", plugin: "sessions" }];
  if (type === "withdraw_queue") return withdrawQueue(options, data.commandId, payload, sid);
  if (["queue", "edit_queue", "cancel_queue", "reorder_queue"].includes(type)) {
    const p = ["api", "sessions", sid, "queue"], body = { ...payload };
    if (type === "edit_queue" || type === "cancel_queue") { p.push(body.queueId); delete body.queueId; }
    return (await dispatchQueue(options, type === "queue" ? "POST" : type === "cancel_queue" ? "DELETE" : "PATCH", p, body))!;
  }
  if (!o.executeCommand) throw new Error("session command writer unavailable");
  return o.executeCommand(type, payload, sid, { id: data.commandId, fingerprint: fp });
}
async function perform(o: SessionCommandsOptions, sid: string, data: Row, receipts: CommandReceipts, record?: Row): Promise<SessionReply> {
  const commandId = data.commandId, fp = fingerprint({ type: data.type, payload: data.payload });
  let status: number, result: unknown;
  try { [status, result] = await execute(o, sid, data, fp); } catch { return UNKNOWN(commandId); }
  const body = dict(result); let ack: Row;
  if (status >= 200 && status < 300) ack = acknowledgement(commandId, data.type === "stop" && !pyTruthy(body.stopping) && !pyTruthy(body.cancelled_tasks) ? "noop" : "accepted", { result });
  else {
    const reason = body.reasonCode || body.error_code || ([401, 403].includes(status) ? "forbidden" : status === 409 ? "state_conflict" : status < 500 ? "invalid_input" : "write_failed");
    ack = acknowledgement(commandId, ["stale_turn", "history_changed"].includes(reason) ? "stale" : status >= 500 ? "failed" : "rejected", { result, reason, message: body.error });
  }
  const settle = (current: Row): SessionReply => {
    const row = current.commands.find((r: Row) => r.commandId === commandId);
    if (!row) return [503, { error: "command acknowledgement window has expired", commandId, reasonCode: "command_unknown" }];
    row.ack = ack; receipts.saveRecord(sid, current);
    return [401, 403].includes(status) ? [status, result] : [200, ack];
  };
  return record ? settle(record) : receipts.locked(sid, () => settle(receipts.readRecord(sid)));
}
export async function dispatchCommand(o: SessionCommandsOptions, method: string, p: string[], data: unknown): Promise<SessionReply | null> {
  if (!ownsCommandRoute(method, p)) return null;
  if (!o.enabled("sessions")) return [403, { error: "plugin disabled or dependency unavailable: sessions", plugin: "sessions" }];
  const collection = p[2] === "commands", sid = collection ? "create_session" : p[2]!, base = collection ? 3 : 4;
  if (!collection && !SID.test(sid)) return [404, { error: "session not found" }];
  let envelope: Row = {}, commandId: unknown;
  if (method === "GET" && p.length === base + 1) commandId = p.at(-1);
  else if (method === "POST" && p.length === base) {
    try { envelope = validateCommand(data, collection); commandId = envelope.commandId; }
    catch (e) { if (isPyValueError(e)) return [400, { error: (e as Error).message }]; throw e; }
  } else return [405, { error: "method not allowed" }];
  let issued: number;
  try { issued = issuedMs(commandId); } catch (e) { return [400, { error: (e as Error).message }]; }
  if (!collection) try { await o.store.load(sid); } catch (e) { if (isPyOSError(e) || isPyValueError(e)) return [404, { error: "session not found" }]; throw e; }
  const now = Date.now(), expired = issued <= now - RETENTION_MS;
  if (expired || issued > now + 300000) return method === "GET" ? [200, { result: "unknown" }] : [200, acknowledgement(commandId, "stale", { reason: expired ? "command_expired" : "command_clock_skew", message: "Command timestamp is outside the retained acknowledgement window" })];
  if (method === "POST") {
    if (!collection && await externalRun(o, sid)) return [200, acknowledgement(commandId, "rejected", { reason: "session_busy", message: "The session is running in another process" })];
    if (o.supportsCommand && !await o.supportsCommand(envelope.type, envelope.payload, sid, String(commandId))) return [200, acknowledgement(commandId, "rejected", { reason: "unsupported_command", message: "This host cannot accept this command" })];
  }
  const receipts = new CommandReceipts(o.store.directory);
  try {
    const result = await receipts.locked(sid, async (): Promise<SessionReply | null> => {
      const currentNow = Date.now();
      const stale = (): SessionReply => method === "GET" ? [200, { result: "unknown" }] : [200, acknowledgement(commandId, "stale", { reason: "command_expired", message: "Command acknowledgement window has expired" })];
      if (issued <= currentNow - RETENTION_MS) return stale();
      const record = receipts.readRecord(sid), floor = Math.max(record.retiredBefore ?? 0, currentNow - RETENTION_MS);
      if (issued <= floor) return stale();
      if (method === "GET") { const row = record.commands.find((r: Row) => r.commandId === commandId); return [200, { result: row?.ack ?? "unknown" }]; }
      const fp = fingerprint({ type: envelope.type, payload: envelope.payload }); record.commands = record.commands.filter((r: Row) => issuedMs(r.commandId) > floor); record.retiredBefore = floor;
      const prior = record.commands.find((r: Row) => r.commandId === commandId);
      if (prior) {
        if (prior.fingerprint !== fp) return [200, acknowledgement(commandId, "rejected", { reason: "command_id_conflict", message: "commandId was already used for another payload" })];
        if (prior.ack == null) return UNKNOWN(commandId);
        return [200, { ...prior.ack, originalStatus: prior.ack.status, status: "duplicate" }];
      }
      try { validateNewCommand(envelope); } catch (e) { if (isPyValueError(e)) return [400, { error: (e as Error).message }]; throw e; }
      if (record.commands.length >= MAX_COMMANDS) return [200, acknowledgement(commandId, "rejected", { reason: "command_capacity", message: "The session acknowledgement window is full; refresh or wait for expiry" })];
      record.commands.push({ commandId, fingerprint: fp, ack: null }); receipts.saveRecord(sid, record);
      return envelope.type === "run" ? null : perform(o, sid, envelope, receipts, record);
    });
    return result ?? await perform(o, sid, envelope, receipts);
  } catch (e) {
    if (isPyOSError(e) || isPyValueError(e)) return [503, { error: "command acknowledgement storage unavailable", commandId, reasonCode: "command_storage_unavailable" }]; throw e;
  }
}
export function createSessionCommandsApi(options: SessionCommandsOptions) {
  return {
    owns(method: string, parts: readonly string[]): boolean { return ownsCommandRoute(method, parts) || ownsQueueRoute(method, parts) || ownsWithdrawalRoute(method, parts) || ownsSteeringRoute(method, parts); },
    async dispatch(method: string, parts: string[], _query: Row, data: unknown): Promise<SessionReply | null> {
      return await dispatchCommand(options, method, parts, data) ?? await dispatchSteering(options, method, parts, data) ?? await dispatchWithdrawals(options, method, parts, data) ?? await dispatchQueue(options, method, parts, data);
    },
  };
}
