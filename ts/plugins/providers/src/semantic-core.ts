/** Transactional handoff structure and journal remapping (`semantic_compaction.py`). */
import { createHash } from "node:crypto";
import { pyEncodeUtf8, pyJsonDumps } from "@xueness/contracts";
type Row = Record<string, unknown>;
export const semanticEncoded = (value: unknown): string => pyJsonDumps(value, { separators: [",", ":"] });
export const semanticFingerprint = (value: unknown): string => createHash("sha256").update(pyEncodeUtf8(semanticEncoded(value))).digest("hex");
export function semanticIdentity(message: Row, index: number, sessionId: unknown): string {
  return typeof message._message_id === "string" && message._message_id ? message._message_id : "legacy-" + semanticFingerprint([sessionId, index, message]).slice(0, 32);
}
export function sumHandoffUsage(records: Row[]): Row {
  const totals: Row = {};
  for (const record of records) for (const key of ["prompt_tokens", "completion_tokens", "total_tokens"]) if (typeof record[key] === "number") totals[key] = Number(totals[key] ?? 0) + record[key];
  return totals;
}
