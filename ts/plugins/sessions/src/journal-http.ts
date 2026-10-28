import { createHash } from "node:crypto";
import { pyInt, pyJsonDumps, PyValueError, type DerivedEnvelope, deriveEvents, ERROR_CODES, pageEvents, sseBody } from "@xueness/contracts";
import type { Session } from "@xueness/sessions";
type Dict = Record<string, unknown>;
export class StaleJournalCursor extends PyValueError { override name = "StaleJournalCursor"; }
export function messageRevision(session: Session): string {
  return "sha256:" + createHash("sha256").update(JSON.stringify(session, (_key, value: unknown) => typeof value === "bigint" ? (JSON as typeof JSON & { rawJSON(text: string): unknown }).rawJSON(value.toString()) : value)).digest("hex");
}
export function oneQuery(query: Dict, key: string): unknown { const v = query[key]; return Array.isArray(v) ? v[0] : v; }
export function isBackgroundTaskNotice(message: unknown): boolean {
  return typeof message === "object" && message !== null && !Array.isArray(message)
    && (message as Dict).role === "user" && (message as Dict)._input_kind === "background_notice"
    && (message as Dict)._meta_source === "task_status"
    && typeof (message as Dict)._background_task_notice === "string" && !!(message as Dict)._background_task_notice;
}
export function projectSessionMessages<T extends { messages?: unknown; archived_messages?: unknown }>(session: T): T {
  let projected: Record<string, unknown> | undefined;
  for (const key of ["messages", "archived_messages"] as const) {
    const rows = session[key];
    if (Array.isArray(rows) && rows.some(isBackgroundTaskNotice)) {
      projected ??= { ...session };
      projected[key] = rows.filter((message) => !isBackgroundTaskNotice(message));
    }
  }
  return projected ? projected as T : session;
}
export function journalPage(session: Session, query: Dict, revision = messageRevision(session)): Dict {
  const projected = projectSessionMessages(session), messages = Array.isArray(projected.messages) ? projected.messages : [], total = messages.length;
  const bounded = (raw: unknown, field: string, min: number, max: number): number => {
    let v: number;
    try { v = typeof raw === "boolean" ? Number(raw) : typeof raw === "number" ? Math.trunc(raw) : pyInt(raw as string); } catch { throw new PyValueError("invalid journal " + field); }
    if (v < min || v > max) throw new PyValueError("invalid journal " + field);
    return v;
  };
  const rawLimit = oneQuery(query, "limit"), rawCursor = oneQuery(query, "cursor");
  const limit = rawLimit === undefined || rawLimit === null ? 200 : bounded(rawLimit, "limit", 1, 500);
  let end = total;
  if (rawCursor !== undefined && rawCursor !== null) {
    const requested = oneQuery(query, "message_revision");
    if (typeof requested !== "string" || !requested) throw new PyValueError("journal cursor requires message_revision");
    if (requested !== revision) throw new StaleJournalCursor("journal changed; restart paging from the newest page");
    end = bounded(rawCursor, "cursor", 0, total);
  }
  const start = Math.max(0, end - limit);
  return { ...projected, messages: messages.slice(start, end), truncated: start > 0 || end < total, next_cursor: start > 0 ? String(start) : null, total_messages: total, message_revision: revision };
}
export function eventsPage(session: Session, query: Dict): [number, Dict | DerivedEnvelope] {
  let cursor: number, limit: number;
  try { cursor = pyInt((oneQuery(query, "cursor") ?? "0") as string); }
  catch { return [400, { error: "invalid cursor", errorCode: ERROR_CODES.invalidArgument }]; }
  try { limit = pyInt((oneQuery(query, "limit") ?? "200") as string); }
  catch { return [400, { error: "invalid limit", errorCode: ERROR_CODES.invalidArgument }]; }
  const projected = projectSessionMessages(session);
  return [200, pageEvents(projected, deriveEvents(projected), Math.max(0, cursor), Math.max(1, Math.min(limit, 500)))];
}
export { sseBody };
