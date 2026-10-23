import { createHash } from "node:crypto";
import { deriveEvents, isDict, pageEvents, pyDeepCopy, pyInt, pyRepr, PyValueError } from "@xueness/contracts";
import type { Session } from "@xueness/sessions";
import { isBackgroundTaskNotice, oneQuery } from "./journal-http.ts";
export type Row = Record<string, any>;
export type DisplayRow = [unknown, number | null];
export class SnapshotError extends PyValueError { override name = "SnapshotError"; readonly status: number; constructor(message: string, status = 409) { super(message); this.status = status; } }
const truncated = (m: unknown): boolean => isDict(m) && typeof m.content === "string" && ["[old output masked;", "[truncated in context]", "[truncated in journal", "[output truncated", "… [truncated]"].some((mark) => (m.content as string).toLowerCase().includes(mark));
export function displayRows(s: Session, includeInterrupted = true): DisplayRow[] {
  const active = Array.isArray(s.messages) ? s.messages : [], archive = Array.isArray(s.archived_messages) ? s.archived_messages : [], rawHidden = s.history_hidden_message_ids ?? [];
  if (!Array.isArray(rawHidden) || rawHidden.some((v) => typeof v !== "string" || !v)) throw new SnapshotError("saved conversation history metadata is invalid");
  const hidden = new Set(rawHidden); let rows: DisplayRow[] = [];
  if (!archive.length) rows = active.flatMap((m, i): DisplayRow[] => isBackgroundTaskNotice(m) ? [] : [[m, i]]);
  else {
    rows = archive.filter((m) => !isBackgroundTaskNotice(m) && (!isDict(m) || !hidden.has(m._message_id))).map((m) => [m, null]);
    let start = isDict(active[0]) && active[0].role === "system" ? 1 : 0;
    if (isDict(active[start]) && (active[start]._semantic_summary === true || active[start]._compact_summary === true)) start++;
    rows.push(...active.slice(start).flatMap((m, i): DisplayRow[] => isBackgroundTaskNotice(m) ? [] : [[m, i + start]]));
    const positions = new Map<string, number>(), unique: DisplayRow[] = [];
    for (const [m, i] of rows) {
      const id = isDict(m) ? m._message_id : null;
      if (typeof id !== "string" || !id) { unique.push([m, i]); continue; }
      const existing = positions.get(id);
      if (existing === undefined) { positions.set(id, unique.length); unique.push([m, i]); }
      else { const [old, oi] = unique[existing]!; if (i !== null && !truncated(m) || oi !== null && truncated(old) && i === null) unique[existing] = [m, i]; }
    }
    rows = unique;
  }
  if (!includeInterrupted) return rows;
  const streams: unknown[] = [];
  for (const p of Array.isArray(s.interrupted_transcripts) ? s.interrupted_transcripts : []) if (isDict(p)) streams.push({ id: p.stream_id, status: "interrupted", interrupted: true, transcript_partial: true, transcript_turn_id: p.turn_id, after_message_id: p.after_message_id, text: p.text, reasoning: p.reasoning, reasoning_started_at: p.reasoning_started_at, reasoning_ended_at: p.reasoning_ended_at, interrupted_at: p.interrupted_at });
  streams.push(...Array.isArray(s.stream_history) ? s.stream_history : [], ...(isDict(s.streaming) ? [s.streaming] : []));
  const anchors = new Map(rows.flatMap(([m]) => isDict(m) && typeof m._message_id === "string" ? [[m._message_id, m] as const] : []));
  const ids = new Set(anchors.keys()), seen = new Set<string>(), byAnchor = new Map<string, Row[]>();
  for (const st of streams) {
    if (!isDict(st) || st.transcript_partial !== true || st.status !== "interrupted" || st.interrupted !== true || st.final_message_index != null || typeof st.id !== "string" || !/^[0-9a-f]{32}$/.test(st.id) || seen.has(st.id) || typeof st.transcript_turn_id !== "string" || !/^turn-[1-9][0-9]*$/.test(st.transcript_turn_id) || typeof st.after_message_id !== "string" || !/^[0-9a-f]{32}$/.test(st.after_message_id) || hidden.has(st.after_message_id) || !anchors.has(st.after_message_id) || !(typeof st.text === "string" && st.text || typeof st.reasoning === "string" && st.reasoning)) continue;
    if (anchors.get(st.after_message_id)!._turn_id !== st.transcript_turn_id) continue;
    const id = createHash("sha256").update(`xueness.interrupted-transcript:${s.id ?? ""}:${st.id}`).digest("hex").slice(0, 32);
    if (ids.has(id)) continue; seen.add(st.id); ids.add(id);
    const m = { role: "assistant", content: typeof st.text === "string" ? st.text : "", _turn_id: st.transcript_turn_id, _message_id: id, _transcript_partial: true, _stream_id: st.id, _stream_interrupted: true, _stream_reasoning: typeof st.reasoning === "string" ? st.reasoning : "", _stream_reasoning_started_at: st.reasoning_started_at ?? null, _stream_reasoning_ended_at: st.reasoning_ended_at ?? null, _stream_interrupted_at: st.interrupted_at ?? null };
    byAnchor.set(st.after_message_id, [...byAnchor.get(st.after_message_id) ?? [], m]);
  }
  return rows.flatMap((r) => [r, ...(isDict(r[0]) ? byAnchor.get(String(r[0]._message_id)) ?? [] : []).map((m): DisplayRow => [m, null])]);
}
export interface WindowRequest { tail: boolean; before: number; limit: number; }
export function windowRequest(query: Row): WindowRequest | null {
  const tail = oneQuery(query, "tail"), before = oneQuery(query, "before"), limit = oneQuery(query, "limit");
  if (tail == null && before == null) return null;
  try { let size = limit == null ? 80 : pyInt(limit as string), end = 0;
    if (size < 1 || size > 120 || tail != null && before != null) throw new Error();
    if (tail != null) { size = pyInt(tail as string); if (size < 1 || size > 120) throw new Error(); }
    else { end = pyInt(before as string); if (end < 0) throw new Error(); }
    return { tail: tail != null, before: end, limit: size };
  } catch { throw new PyValueError("invalid conversation window"); }
}
export function windowBounds(rows: DisplayRow[], request: WindowRequest): [number, number] {
  const end = request.tail ? rows.length : request.before;
  if (end > rows.length) throw new PyValueError("invalid conversation window");
  const target = Math.max(0, end - request.limit);
  if (!target || target >= end) return [target, end];
  let aligned = -1; for (let i = target; i < end; i++) { const message = rows[i]![0]; if (isDict(message) && message.role === "user") { aligned = i; break; } }
  return [aligned >= 0 && aligned - target <= request.limit ? aligned : target, end];
}
export function messageIdentity(sid: string, index: number, message: unknown): string {
  if (isDict(message) && typeof message._message_id === "string" && message._message_id) return message._message_id;
  return "legacy-" + createHash("sha256").update(`(${pyRepr(sid)}, ${index}, ${pyRepr(message)})`).digest("hex").slice(0, 32);
}
export function callIds(rows: DisplayRow[]): Set<string> { const ids = new Set<string>(); for (const [m] of rows) if (isDict(m)) { for (const c of Array.isArray(m.tool_calls) ? m.tool_calls : []) if (isDict(c) && typeof c.id === "string") ids.add(c.id); if (typeof m.tool_call_id === "string") ids.add(m.tool_call_id); } return ids; }
export function windowEvents(s: Session, rows: DisplayRow[], start: number): Row {
  const turns = new Set(rows.flatMap(([m]) => isDict(m) && typeof m._turn_id === "string" ? [m._turn_id] : [])), ids = callIds(rows);
  const synthetic: Row = Object.fromEntries(["id", "status", "steps", "mode", "pending_question"].map((k) => [k, s[k] ?? null]));
  synthetic.results = Object.fromEntries(Object.entries(isDict(s.results) ? s.results : {}).filter(([id]) => ids.has(id)));
  synthetic.completion_history = (Array.isArray(s.completion_history) ? s.completion_history : []).filter((r) => isDict(r) && turns.has(String(r.turn_id)));
  synthetic.completion = isDict(s.completion) && turns.has(String(s.completion.turn_id)) ? s.completion : null;
  const messages = rows.map(([m]) => pyDeepCopy(m));
  if (start > 0) { const first = messages.find(isDict) ?? {}; let turn = first._turn_id ?? "turn-1";
    if (first.role === "user" && first._input_kind !== "guide" && typeof turn === "string" && turn.startsWith("turn-")) { try { turn = `turn-${Math.max(1, pyInt(turn.slice(5)) - 1)}`; } catch { turn = "turn-1"; } }
    messages.unshift({ role: "user", content: "", _turn_id: turn });
  }
  synthetic.messages = messages; const derived = deriveEvents(synthetic); return { ...pageEvents(synthetic, derived, 0, 500), events: derived, nextCursor: derived.at(-1)?.seq ?? 0, hasMore: false };
}
