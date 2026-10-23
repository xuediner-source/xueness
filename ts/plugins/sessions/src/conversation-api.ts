/** One loaded journal owns mutation revisions, page rows and timeline outcomes. */
import { statSync } from "node:fs";
import { deriveEvents, isDict, isPyIntValue, pageEvents, pyDeepCopy, pySlice } from "@xueness/contracts";
import { isPyOSError, isPyValueError, pyExceptionName, type Session } from "@xueness/sessions";
import { messageRevision, oneQuery, projectSessionMessages } from "./journal-http.ts";
import { externalRun, sessionBusy } from "./queue-http.ts";
import { markViewed } from "./read-state.ts";
import { callIds, displayRows, messageIdentity, SnapshotError, windowBounds, windowEvents, windowRequest, type DisplayRow, type Row, type WindowRequest } from "./snapshot-rows.ts";
import { projectReferences } from "./reference-rows.ts";
import { projectSubagents } from "./subagent-rows.ts";
import type { SessionReply, SessionsApiOptions } from "./http-api.ts";
export const CONVERSATION_ROUTES = ["GET /api/sessions/:id/conversation"];
export function ownsConversationRoute(method: string, p: readonly string[]): boolean { return method === "GET" && p.length === 4 && p[0] === "api" && p[1] === "sessions" && p[3] === "conversation"; }
function overlay(s: Session, options: SessionsApiOptions): void {
  const context = options.lifecycle?.activeContext.get(String(s.id)), live = context?.active_session;
  if (!options.running?.has(String(s.id)) || !isDict(live) || live.id !== s.id || live.active_turn_id !== s.active_turn_id) return;
  for (const key of ["streaming", "runtime_activity", "tool_activity"]) if (Object.hasOwn(live, key)) s[key] = pyDeepCopy(live[key]);
}
function attachSidecars(options: SessionsApiOptions, s: Session, journal: Row): void {
  const references = projectReferences(journal.messages, { root: typeof s.root === "string" ? s.root : undefined, filesEffective: options.enabled("files"), stat: options.referenceStat });
  if (references.length) journal.message_references = references;
  delete journal.message_subagents;
  if (!options.enabled("sessions")) return;
  const subagents = options.enabled("subagents"), tasks = subagents ? options.lifecycle?.tasks?.(String(s.id)) : undefined;
  const rows = projectSubagents(s, journal.messages, subagents, tasks);
  if (rows.length) journal.message_subagents = rows;
}
async function paged(options: SessionsApiOptions, s: Session, rows: DisplayRow[], start: number, end: number, project: (s: Session) => Promise<Row> | Row): Promise<Row> {
  const display: unknown[] = [], indexes: (number | null)[] = [], annotations: Row = {}, reasoning: Row[] = [], timing: Row[] = [], local = new Map<number, number>();
  const savedAnnotations = isDict(s.message_annotations) ? s.message_annotations : {};
  for (const [index, [original, activeIndex]] of rows.slice(start, end).entries()) {
    const message = pyDeepCopy(original); if (isDict(message) && !Object.hasOwn(message, "_message_id")) message._message_id = messageIdentity(String(s.id), start + index, message);
    display.push(message); indexes.push(activeIndex);
    if (activeIndex !== null) { local.set(activeIndex, index); const value = savedAnnotations[String(activeIndex)]; if (value != null) annotations[String(index)] = pyDeepCopy(value); }
  }
  for (const r of Array.isArray(s.reasoning_history) ? s.reasoning_history : []) if (isDict(r) && isPyIntValue(r.message_index) && local.has(Number(r.message_index)) && typeof r.text === "string") reasoning.push({ message_index: local.get(Number(r.message_index)), text: r.text });
  for (const r of Array.isArray(s.reasoning_timing) ? s.reasoning_timing : []) if (isDict(r) && isPyIntValue(r.message_index) && local.has(Number(r.message_index)) && typeof r.started_at === "string" && r.started_at && typeof r.ended_at === "string" && r.ended_at) timing.push({ message_index: local.get(Number(r.message_index)), started_at: pySlice(r.started_at, 40), ended_at: pySlice(r.ended_at, 40) });
  const revision = messageRevision(s), window = { start, end, total: rows.length, hasOlder: start > 0, olderCursor: start > 0 ? start : null, messageRevision: revision, historyRevision: s.history_revision ?? 0 }, turns = new Set(display.flatMap((m) => isDict(m) && typeof m._turn_id === "string" ? [m._turn_id] : []));
  const ids = callIds(rows.slice(start, end)), journal: Row = { id: s.id, status: s.status ?? null, task: s.task ?? null, messages: display, message_revision: revision, history_revision: s.history_revision ?? 0, message_window: { ...window, messageIndices: indexes }, message_annotations: annotations, reasoning_history: reasoning, reasoning_timing: timing, completion_history: (Array.isArray(s.completion_history) ? s.completion_history : []).filter((r) => isDict(r) && turns.has(String(r.turn_id))).map(pyDeepCopy), results: Object.fromEntries(Object.entries(isDict(s.results) ? s.results : {}).filter(([id]) => ids.has(id))) };
  if (isDict(s.completion) && turns.has(String(s.completion.turn_id))) journal.completion = pyDeepCopy(s.completion);
  attachSidecars(options, s, journal);
  return { session: await project(s), journal, timeline: windowEvents(s, rows.slice(start, end), start), window };
}
export async function conversationSnapshot(options: SessionsApiOptions, sid: string, request: WindowRequest | null, guard: unknown, project: (s: Session) => Promise<Row> | Row): Promise<Row> {
  const s = await options.store.load(sid);
  if (!isDict(s) || s.id !== sid || !Array.isArray(s.messages)) throw new SnapshotError("saved conversation is invalid");
  overlay(s, options); const revision = messageRevision(s);
  if (guard != null && guard !== revision) throw new SnapshotError("conversation changed; reload the transcript window");
  if (request) { const rows = displayRows(s), [start, end] = windowBounds(rows, request); return paged(options, s, rows, start, end, project); }
  const projected = projectSessionMessages(s), events = deriveEvents(projected), timeline = { ...pageEvents(projected, events, 0, 500), events, nextCursor: events.at(-1)?.seq ?? 0, hasMore: false }, journal = { ...projected, message_revision: revision };
  delete (journal as Row).active_run_command_id; attachSidecars(options, s, journal);
  return { session: await project(s), journal, timeline };
}
export function createConversationApi(options: SessionsApiOptions, project: (s: Session) => Promise<Row> | Row) {
  return { routes: CONVERSATION_ROUTES, owns: ownsConversationRoute,
    async dispatch(method: string, p: string[], query: Row): Promise<SessionReply | null> {
      if (!ownsConversationRoute(method, p)) return null;
      if (!options.enabled("sessions")) return [403, { error: "plugin disabled or dependency unavailable: sessions", plugin: "sessions" }];
      if (await externalRun(options, p[2]!)) return sessionBusy();
      try {
        const source = options.store.pathFor(p[2]!), request = windowRequest(query), acknowledge = request === null || request.tail, observed = acknowledge ? statSync(source, { bigint: true }).mtimeNs : null;
        const result = await conversationSnapshot(options, p[2]!, request, oneQuery(query, "revision"), project);
        if (observed !== null) try { await markViewed(options.store, p[2]!, observed); } catch (e) { if (!isPyOSError(e) && !isPyValueError(e)) throw e; }
        return [200, result];
      } catch (e) { if (e instanceof SnapshotError) return [e.status, { error: e.message }]; if (pyExceptionName(e) === "FileNotFoundError") return [404, { error: "session not found" }]; if (isPyValueError(e) && (e as Error).message === "invalid conversation window") return [400, { error: (e as Error).message }]; if (isPyOSError(e) || isPyValueError(e)) return [500, { error: "cannot read conversation snapshot" }]; throw e; }
    } };
}
