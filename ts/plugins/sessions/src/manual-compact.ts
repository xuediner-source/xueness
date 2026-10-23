/** Operator-requested deterministic compaction, using the same core invariants. */
import { compact } from "@xueness/agent";
import { isDict, isPyIntValue, pyJsonDumps, pyLen, pySlice, pyStrip, PyValueError } from "@xueness/contracts";
import { beginCompactTimeline, finishCompactTimeline, pyExceptionName, type Session, type SessionStore } from "@xueness/sessions";
type Row = Record<string, unknown>;
export class CompactError extends PyValueError {
  override name = "CompactError"; readonly reason: string; readonly detail: string; readonly status: number;
  constructor(reason: string, detail: string, status = 400) { super(`${reason}: ${detail}`); this.reason = reason; this.detail = detail; this.status = status; }
  payload(): Row { return { ok: false, status: this.status, refusal: { reason: this.reason, detail: this.detail } }; }
}
export function normalizeCompactInstructions(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new CompactError("invalid_instructions", "压缩说明必须是文本。");
  const text = pyStrip(value); if (!text) return null;
  if (/[\x00-\x1f\x7f]/.test(text)) throw new CompactError("invalid_instructions", "压缩说明不能包含控制字符。");
  if (pyLen(text) > 2000) throw new CompactError("instructions_too_long", `压缩说明最长 2000 个字符（当前 ${pyLen(text)}）。`);
  return text;
}
export function compactBudgetChars(session: Row, current: number, override: unknown = null): number {
  if (override !== null && (!isPyIntValue(override) || Number(override) < 256)) throw new CompactError("invalid_budget", "压缩预算需要是不小于 256 的整数。");
  let base = override === null ? 24000 : Math.min(Number(override), 24000);
  const stored = session.runtime_budget;
  if (session.runtime_profile === "lightweight" && isDict(stored) && isPyIntValue(stored.inputBudgetTokens) && Number(stored.inputBudgetTokens) > 0) base = Math.min(base, Number(stored.inputBudgetTokens) * 2);
  return Math.max(256, Math.min(base, Math.trunc(current * 0.6)));
}
function validSid(sid: unknown): asserts sid is string { if (typeof sid !== "string" || !/^[0-9a-f]{32}$/.test(sid)) throw new CompactError("invalid_session", "需要 32 位十六进制的会话 id。"); }
const size = (value: unknown): number => pyLen(pyJsonDumps(value, { ensureAscii: false }));
function totals(records: unknown[]): [number, number] {
  let dropped = 0, masked = 0;
  for (const record of records.filter(isDict)) { if (isPyIntValue(record.removed) && Number(record.removed) > 0) dropped += Number(record.removed); if (isPyIntValue(record.masked) && Number(record.masked) > 0) masked += Number(record.masked); }
  return [dropped, masked];
}
export interface CompactOptions {
  enabled(id: string): boolean; source?: string; budget?: unknown;
  /** ZCode model compaction; null (lightweight runtime, no usable provider) keeps the deterministic path. */
  modelCompact?: (session: Session, instructions: string | null, source: string) => Promise<Row | null>;
}
export async function compactNow(store: Pick<SessionStore, "load" | "save">, sid: string, instructions: unknown, options: CompactOptions): Promise<Row> {
  if (!options.enabled("sessions")) throw new CompactError("plugin_disabled", "插件已禁用或依赖不可用: sessions", 403);
  const source = options.source ?? "cli";
  if (!["chat", "cli", "http"].includes(source)) throw new CompactError("invalid_source", "未知的压缩入口。");
  validSid(sid); const note = normalizeCompactInstructions(instructions);
  let session: Session; try { session = await store.load(sid); } catch { throw new CompactError("session_not_found", `未知会话: ${sid}`, 404); }
  if (!isDict(session) || session.id !== sid) throw new CompactError("session_not_found", `未知会话: ${sid}`, 404);
  if (!Array.isArray(session.messages)) throw new CompactError("invalid_session", "该会话没有可压缩的消息记录。", 409);
  if (options.modelCompact) {
    let modeled: Row | null;
    try { modeled = await options.modelCompact(session, note, source); }
    catch (e) { throw new CompactError("compaction_failed", pySlice(e instanceof Error ? e.message : String(e), 300), 502); }
    if (modeled) return modeled;
  }
  const before = size(session.messages), count = session.messages.length, target = compactBudgetChars(session, before, options.budget ?? null);
  const small = count <= 3 || before <= Math.max(1024, target);
  const recorded = Array.isArray(session.compactions) ? session.compactions.length : 0;
  const timeline = !small ? beginCompactTimeline(session, { trigger: 'manual', phase: 'manual', kind: 'deterministic' }) : null;
  if (timeline) await store.save(session);
  try { if (!small) compact(session, target, undefined, note); }
  catch (error) { if (timeline) { finishCompactTimeline(session, timeline.id, { status: 'failed', finishedAt: new Date().toISOString() }); await store.save(session); } throw error; }
  const records = !small && Array.isArray(session.compactions) ? session.compactions.slice(recorded) : [];
  for (const record of records.filter(isDict)) Object.assign(record, { manual: true, source, targetChars: target, instructions: note ? pySlice(note, 200) : null, instructionsChars: pyLen(note ?? "") });
  const [dropped, masked] = totals(records), after = size(session.messages);
  if (timeline) {
    const checkpointId = 'deterministic-' + String(timeline.id);
    for (const record of records.filter(isDict)) record.operationId = timeline.id;
    if (!Array.isArray(session.context_checkpoints)) session.context_checkpoints = [];
    (session.context_checkpoints as Row[]).push({ id: checkpointId, operationId: timeline.id, kind: 'deterministic', at: new Date().toISOString() });
    finishCompactTimeline(session, timeline.id, { status: 'completed', checkpointId, finishedAt: new Date().toISOString() });
  }
  if (timeline || records.length || dropped || masked || after !== before) await store.save(session);
  return { ok: true, session: sid, manual: true, source, compacted: !!(dropped || masked || after < before), ...(small ? { reason: "nothing_to_compact" } : { withinBudget: after <= target }), budget: target,
    before: { chars: before, estimatedTokens: Math.floor(before / 4), messages: count }, after: { chars: after, estimatedTokens: Math.floor(after / 4), messages: session.messages.length },
    dropped, masked, archived: Array.isArray(session.archived_messages) ? session.archived_messages.length : 0,
    instructions: { provided: note !== null, chars: pyLen(note ?? ""), digest: note ? pySlice(note, 200) : null }, compactions: records };
}
export async function compactLeased(store: SessionStore, sid: string, instructions: unknown, options: CompactOptions): Promise<Row> {
  validSid(sid); let lease: Awaited<ReturnType<SessionStore["lease"]>> | null = null;
  try { lease = await store.lease(sid); return await compactNow(store, sid, instructions, options); }
  catch (e) { if (pyExceptionName(e) === "BlockingIOError") throw new CompactError("session_busy", "会话正在被写入，请停止运行后再压缩。", 409); throw e; }
  finally { await lease?.release(); }
}
