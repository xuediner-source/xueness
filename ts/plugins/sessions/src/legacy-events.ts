/** Legacy summary events and immutable-prefix cursor paging. */
import { createHash, type Hash } from "node:crypto";
import { isDict, pyEncodeUtf8, pyJsonDumps, pyLen, pySlice, pyStr, pyTruthy, toolSubject, PyValueError } from "@xueness/contracts";
import { isBackgroundTaskNotice } from "./journal-http.ts";
type Row = Record<string, any>;
export function legacyEvents(s: Row, limit = 200): Row[] {
  const events: Row[] = [{ type: "status", status: s.status ?? null, steps: s.steps ?? 0 }], results = isDict(s.results) ? s.results : {}, subjects = new Map<string, string>(), messages = Array.isArray(s.messages) ? s.messages : [];
  for (const [index, m] of messages.entries()) {
    if (!isDict(m)) continue;
    if (m.role === "assistant") {
      for (const c of Array.isArray(m.tool_calls) ? m.tool_calls : []) if (isDict(c)) { const f = isDict(c.function) ? c.function : {}, subject = toolSubject(String(f.name ?? ""), f.arguments ?? ""); subjects.set(String(c.id ?? ""), subject); events.push({ type: "tool_call", id: c.id ?? "", name: f.name ?? "", subject }); }
      if (pyTruthy(m.content)) events.push({ type: "assistant", preview: pySlice(pyStr(m.content), 500) });
    } else if (m.role === "tool") { const id = String(m.tool_call_id ?? ""), r = results[id]; events.push({ type: "tool_result", id, subject: subjects.get(id) ?? "", ok: isDict(r) && pyTruthy(r.ok), error: isDict(r) ? pySlice(pyStr(r.error ?? ""), 120) : "" }); }
    else if (isBackgroundTaskNotice(m)) events.push({ type: "runtime_activity", id: m._background_task_notice, message: pyStr(m.content), source: "task_status" });
    else if (m.role === "user" && typeof m.content === "string" && index !== 1) events.push({ type: "user", preview: pySlice(m.content, 500) });
  }
  if (isDict(s.completion) && Object.keys(s.completion).length) { const c = s.completion; events.push({ type: "completion", verified: pyTruthy(c.verified), summary: pySlice(pyStr(c.summary ?? ""), 500), tool_execution_success: pyTruthy(c.tool_execution_success ?? c.verified), delivery_status: c.delivery_status ?? "not_assessed" }); }
  if (pyTruthy(s.pending_question)) events.push({ type: "pending_question", question: pySlice(pyStr(s.pending_question), 1000) });
  return events.slice(-limit);
}
export function eventDigest(s: Row, domain: string): Hash { return createHash("sha256").update(pyEncodeUtf8(pyStr(s.id ?? ""))).update(Buffer.from(`\0${domain}\0`)); }
export function updateEventDigest(hash: Hash, event: Row): void { const raw = pyEncodeUtf8(pyJsonDumps(event, { sortKeys: true, separators: [",", ":"] })), size = Buffer.alloc(8); size.writeBigUInt64BE(BigInt(raw.length)); hash.update(size).update(raw); }
export function prefixHash(s: Row, events: Row[], position: number, domain: string): string { const hash = eventDigest(s, domain); for (const e of events) { if (e.seq <= 1) continue; if (e.seq > position) break; updateEventDigest(hash, e); } return hash.digest("hex"); }
export class CursorError extends PyValueError { override name = "CursorError"; readonly status: number; readonly code: string; readonly resync: boolean; constructor(message: string, resync = false) { super(message); this.resync = resync; this.status = resync ? 409 : 400; this.code = resync ? "sessions.events_cursor.resync_required" : "xueness.error.invalid_argument"; } }
export interface EventCursor { position: number; revision: string | null; }
export function requestedEventCursor(query: Row): EventCursor | null {
  const values: EventCursor[] = [];
  for (const key of ["cursor", "since"]) for (const value of Object.hasOwn(query, key) ? Array.isArray(query[key]) ? query[key] : [query[key]] : []) {
    const text = pyStr(value); if (!text) continue; const match = /^c1\.([0-9]+)\.([0-9a-f]{64})$/.exec(text), raw = match?.[1] ?? text;
    if (!match && !/^[0-9]+$/.test(text)) throw new CursorError("invalid cursor");
    if (pyLen(raw) > 4300 || BigInt(raw) > BigInt(Number.MAX_SAFE_INTEGER)) throw new CursorError("cursor too large"); values.push({ position: Number(raw), revision: match?.[2] ?? null });
  }
  if (values.some((v) => v.position !== values[0]!.position || v.revision !== values[0]!.revision)) throw new CursorError("conflicting cursor values"); return values[0] ?? null;
}
export function requestedEventLimit(query: Row): number {
  if (!Object.hasOwn(query, "limit")) return 200; const value = Array.isArray(query.limit) ? query.limit[0] ?? "" : query.limit, text = pyStr(value);
  if (!/^[0-9]+$/.test(text)) throw new CursorError("invalid limit"); return text.length > 4300 ? 500 : Math.max(1, Number(BigInt(text) > 500n ? 500n : BigInt(text)));
}
export function numberedLegacyEvents(s: Row): Row[] { return legacyEvents(s, Number.MAX_SAFE_INTEGER).map((e, i) => ({ ...e, seq: i + 1 })); }
export function eventCursorPage(s: Row, cursor: EventCursor, limit: number): Row {
  const events = numberedLegacyEvents(s), position = cursor.position;
  if (position > events.length) throw new CursorError("cursor ahead of session head", true);
  if (position && cursor.revision === null) throw new CursorError("cursor revision required", true);
  if (cursor.revision !== null && cursor.revision !== prefixHash(s, events, position, "events-cursor-v1")) throw new CursorError("cursor revision changed", true);
  const window = events.slice(position, position + Math.max(1, limit)), next = window.at(-1)?.seq ?? position;
  return { id: s.id, status: s.status ?? null, steps: s.steps ?? 0, events: window, next_cursor: next, next_cursor_token: `c1.${next}.${prefixHash(s, events, next, "events-cursor-v1")}`, has_more: position + Math.max(1, limit) < events.length };
}
export function legacySse(events: Row[]): Buffer { return Buffer.from(events.flatMap((e) => [`event: ${e.type ?? "message"}`, "data: " + pyJsonDumps(e), ""]).join("\n") + "\n"); }
export function eventCursorSse(s: Row, window: Row[]): Buffer {
  const wanted = new Set(window.map((e) => e.seq)), chunks: string[] = [], hash = eventDigest(s, "events-cursor-v1"), max = Math.max(0, ...wanted);
  for (const e of numberedLegacyEvents(s)) { if (e.seq > max) break; if (e.seq > 1) updateEventDigest(hash, e); if (wanted.has(e.seq)) chunks.push(`id: c1.${e.seq}.${hash.copy().digest("hex")}`, `event: ${e.type ?? "message"}`, "data: " + pyJsonDumps(e), ""); }
  return Buffer.from(chunks.length ? chunks.join("\n") + "\n" : "");
}
