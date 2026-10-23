import { isDict, pyEquals, pyJsonDumps, pyLen, PyValueError } from "@xueness/contracts";
import { ACTIVE, FINAL, HASH, HISTORY_LIMIT, issuedMs, MAX_ITEM_BYTES, MAX_PENDING, RETENTION_MS, SID, size, validateRevision, type Row } from "./queue-types.ts";
export function validateWithdrawals(record: Row, sid: string): void {
  const rows = Object.hasOwn(record, "withdrawals") ? record.withdrawals : [], clock = Object.hasOwn(record, "withdrawalClock") ? record.withdrawalClock : 0;
  if (!Array.isArray(rows) || rows.length > 32 || !Number.isInteger(clock) || clock < 0) throw new PyValueError("invalid withdrawal recovery storage");
  const ids = new Set();
  const fields = "createdAt,expectedRevision,expiresAt,hasContext,id,queueId,root,sessionId,text";
  for (const row of rows) {
    if (!isDict(row) || Object.keys(row).sort().join(",") !== fields || typeof row.id !== "string" || ids.has(row.id) || row.sessionId !== sid
      || typeof row.queueId !== "string" || !SID.test(row.queueId) || typeof row.root !== "string" || !row.root || row.root.includes("\0")
      || typeof row.text !== "string" || pyLen(row.text) < 1 || pyLen(row.text) > 5000 || row.text.includes("\0") || typeof row.hasContext !== "boolean"
      || typeof row.createdAt !== "number" || !Number.isInteger(row.createdAt) || row.createdAt < 0 || row.expiresAt !== row.createdAt + RETENTION_MS || row.createdAt > clock) throw new PyValueError("invalid withdrawal recovery record");
    issuedMs(row.id); validateRevision(row.expectedRevision); ids.add(row.id);
    if (size(pyJsonDumps(row, { separators: [",", ":"] })) > 65536) throw new PyValueError("withdrawal recovery record too large");
  }
  if (size(pyJsonDumps(rows, { separators: [",", ":"] })) > 1048576) throw new PyValueError("withdrawal recovery storage full");
}
export function validateQueue(value: unknown, sid: string): Row {
  if (!isDict(value) || !pyEquals(value.schema, 1) || typeof (Object.hasOwn(value, "accepting") ? value.accepting : false) !== "boolean" || !Array.isArray(value.items)) throw new PyValueError("message queue file is invalid");
  try { validateRevision(Object.hasOwn(value, "revision") ? value.revision : 0); } catch { throw new PyValueError("message queue revision is invalid"); }
  if (value.items.length > MAX_PENDING + HISTORY_LIMIT) throw new PyValueError("message queue has too many records");
  const ids = new Set();
  for (const item of value.items as Row[]) {
    if (!isDict(item) || typeof item.id !== "string" || !SID.test(item.id) || ids.has(item.id) || !ACTIVE.has(item.status as string) && !FINAL.has(item.status as string) || typeof item.text !== "string") throw new PyValueError("message queue item is invalid");
    ids.add(item.id);
    if (size(item.text) > MAX_ITEM_BYTES) throw new PyValueError("message queue item is too large");
    if (item.prepared != null && !isDict(item.prepared)) throw new PyValueError("message queue context is invalid");
    const p = item.promotion;
    if (p != null && (!isDict(p) || typeof p.id !== "string" || !SID.test(p.id) || typeof p.fingerprint !== "string" || !HASH.test(p.fingerprint)
      || !["reserved", "claimed", "released", "settled"].includes(p.state as string) || !isDict(p.receipt) || p.receipt.id !== item.id || p.receipt.request_id !== p.id || p.receipt.delivery !== "startNow" || p.receipt.state !== "reserved"
      || p.receipt.targetTurnId != null && (typeof p.receipt.targetTurnId !== "string" || !p.receipt.targetTurnId || pyLen(p.receipt.targetTurnId) > 128)
      || !Array.isArray(p.previous_ids) || p.previous_ids.length > MAX_PENDING || p.previous_ids.some((id) => typeof id !== "string" || !SID.test(id)) || new Set(p.previous_ids).size !== p.previous_ids.length || !p.previous_ids.includes(item.id))) throw new PyValueError("message queue promotion is invalid");
    const s = item.submission;
    if (s != null && (!isDict(s) || typeof s.id !== "string" || !SID.test(s.id) || typeof s.fingerprint !== "string" || !HASH.test(s.fingerprint) || !isDict(s.receipt) || s.receipt.id !== item.id || !["queued", "paused"].includes(s.receipt.status as string) || typeof s.receipt.text !== "string" || typeof s.receipt.position !== "number" || !Number.isInteger(s.receipt.position) || s.receipt.position < 0)) throw new PyValueError("message queue receipt is invalid");
  }
  validateWithdrawals(value, sid);
  return { schema: 1, revision: value.revision ?? 0, accepting: value.accepting ?? false, items: value.items, withdrawals: value.withdrawals ?? [], withdrawalClock: value.withdrawalClock ?? 0 };
}
