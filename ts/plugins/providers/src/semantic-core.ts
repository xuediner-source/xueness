/** Transactional handoff structure and journal remapping (`semantic_compaction.py`). */
import { createHash } from "node:crypto";
import { isDict, pyDeepCopy, pyEncodeUtf8, pyJsonDumps, pyLen, PyValueError } from "@xueness/contracts";
type Row = Record<string, unknown>;
export const HANDOFF_SECTIONS = ["requirements", "constraints", "decisions", "artifacts", "pending", "verification"] as const;
export const semanticEncoded = (value: unknown): string => pyJsonDumps(value, { separators: [",", ":"] });
export const semanticFingerprint = (value: unknown): string => createHash("sha256").update(pyEncodeUtf8(semanticEncoded(value))).digest("hex");
export function semanticIdentity(message: Row, index: number, sessionId: unknown): string {
  return typeof message._message_id === "string" && message._message_id ? message._message_id : "legacy-" + semanticFingerprint([sessionId, index, message]).slice(0, 32);
}
export function safeHistoryGroups(messages: unknown[]): Row[][] {
  const groups: Row[][] = []; let group: Row[] = []; const pending = new Set<string>();
  for (const message of messages) {
    if (!isDict(message)) throw new PyValueError("invalid history message");
    const role = message.role;
    if (role !== "tool" && pending.size) throw new PyValueError("history prefix contains unresolved tool exchange");
    group.push(message);
    for (const call of (Array.isArray(message.tool_calls) ? message.tool_calls : [])) {
      const cid = isDict(call) ? call.id : null;
      if (typeof cid !== "string" || !cid || pending.has(cid)) throw new PyValueError("invalid history tool call identity");
      pending.add(cid);
    }
    if (role === "tool") {
      if (typeof message.tool_call_id !== "string" || !pending.has(message.tool_call_id)) throw new PyValueError("history prefix contains orphan tool result");
      pending.delete(message.tool_call_id);
    }
    if (!pending.size) { groups.push(group); group = []; }
  }
  if (pending.size || group.length) throw new PyValueError("history prefix is not closed");
  return groups;
}
export function validateHandoff(raw: Row, required: string[], limit: number): Row {
  if (Object.keys(raw).sort().join(",") !== [...HANDOFF_SECTIONS, "coveredMessageIds"].sort().join(",")) throw new PyValueError("handoff sections are incomplete");
  const result: Row = {};
  for (const section of HANDOFF_SECTIONS) {
    const items = raw[section];
    if (!Array.isArray(items) || items.length > 48 || items.some((value) => typeof value !== "string" || !value.trim() || pyLen(value) > 2000)) throw new PyValueError("invalid handoff section: " + section);
    result[section] = items.map((value: string) => value.trim());
  }
  const coverage = raw.coveredMessageIds;
  if (!Array.isArray(coverage) || coverage.length > 1000 || coverage.some((value) => typeof value !== "string") || new Set(coverage).size !== coverage.length || new Set(required).size !== new Set(coverage).size || required.some((id) => !coverage.includes(id))) throw new PyValueError("handoff omitted a human-message coverage anchor");
  if (required.length && !(result.requirements as string[]).length) throw new PyValueError("handoff omitted human requirements");
  result.coveredMessageIds = coverage;
  if (pyLen(semanticEncoded(result)) > limit) throw new PyValueError("handoff exceeds the target summary budget");
  return result;
}
export function sumHandoffUsage(records: Row[]): Row {
  const totals: Row = {};
  for (const record of records) for (const key of ["prompt_tokens", "completion_tokens", "total_tokens"]) if (typeof record[key] === "number") totals[key] = Number(totals[key] ?? 0) + record[key];
  return totals;
}
export function stageHandoff(session: Row, checkpoint: Row, newMessages: Row[], cut: number, activity: Row, finishedAt: string): Row {
  const staged = pyDeepCopy(session) as Row;
  const messages = session.messages as Row[];
  if (!Array.isArray(staged.context_checkpoints)) staged.context_checkpoints = [];
  (staged.context_checkpoints as Row[]).push(checkpoint);
  if (!Array.isArray(staged.archived_messages)) staged.archived_messages = [];
  (staged.archived_messages as Row[]).push(...checkpoint.messages as Row[]);
  staged.messages = pyDeepCopy(newMessages);
  const retainedPosition = (index: number): number | null => index === 0 ? 0 : index >= cut ? index - cut + 2 : null;
  if (isDict(staged.message_annotations)) {
    const kept: Row = {};
    for (const [key, value] of Object.entries(staged.message_annotations)) {
      if (!/^\p{Decimal_Number}+$/u.test(key)) continue;
      const oldIndex = Number(key); const next = oldIndex < messages.length ? retainedPosition(oldIndex) : null;
      if (next !== null) Object.defineProperty(kept, String(next), { value, writable: true, enumerable: true, configurable: true });
    }
    staged.message_annotations = kept;
  }
  if (Array.isArray(staged.reasoning_history)) staged.reasoning_history = staged.reasoning_history.filter(isDict).flatMap((row) => {
    const old = row.message_index;
    const next = typeof old === "number" && Number.isInteger(old) && old >= 0 && old < messages.length ? retainedPosition(old) : null;
    return next === null ? [] : [{ ...row, message_index: next }];
  });
  if (!Array.isArray(staged.compactions)) staged.compactions = [];
  (staged.compactions as Row[]).push({ kind: "semantic", checkpointId: checkpoint.id, removed: cut - 1, previous_chars: checkpoint.previousChars, requestChars: checkpoint.requestChars, reportedUsage: checkpoint.reportedUsage });
  staged.semantic_compaction_activity = { ...activity, status: "completed", finishedAt, checkpointId: checkpoint.id };
  delete staged.semantic_compaction_attempt;
  return staged;
}
