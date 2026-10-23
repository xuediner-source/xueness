/** Durable stream offsets and snapshot-first SSE; both retain their frozen wire. */
import { isDict, pyEquals, pyInt, pyJsonDumps, pyLen, pySlice, pyTruthy, PyValueError } from "@xueness/contracts";
import { difference, isPyOSError, isPyValueError, pyExceptionName, type Session } from "@xueness/sessions";
import { conversationSnapshot } from "./conversation-api.ts";
import { oneQuery } from "./journal-http.ts";
import { externalRun, sessionBusy } from "./queue-http.ts";
import type { SessionReply, SessionRequest, SessionsApiOptions } from "./http-api.ts";
type Row = Record<string, any>;
export const LIVE_ROUTES = ["GET /api/sessions/:id/deltas", "GET /api/sessions/:id/updates"];
export async function waitLive(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => { const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); }; const timer = setTimeout(done, ms); signal?.addEventListener("abort", done, { once: true }); });
}
export function modelDeltaPage(s: Session, streamId: string, cursor: number): Row {
  const records = [...Array.isArray(s.stream_history) ? s.stream_history : [], ...(isDict(s.streaming) ? [s.streaming] : [])], row = records.findLast((r) => isDict(r) && (!streamId || r.id === streamId));
  if (!isDict(row)) { if (streamId) throw Object.assign(new Error("stream not found"), { name: "LookupError" }); return { schema: "xueness.model-delta.v1", streamId: streamId || "", cursor, nextCursor: cursor, text: "", done: !["pending", "running"].includes(String(s.status)), status: "waiting" }; }
  const text = row.text ?? ""; if (typeof text !== "string") throw new PyValueError("invalid stream text"); const head = pyLen(text); if (cursor > head) throw new PyValueError("cursor exceeds stream length");
  const chunk = pySlice(Array.from(text).slice(cursor).join(""), 4096), end = cursor + pyLen(chunk);
  return { schema: "xueness.model-delta.v1", streamId: row.id, cursor, nextCursor: end, head, text: chunk, done: ["completed", "interrupted"].includes(String(row.status)) && end === head, status: row.status ?? "streaming", truncated: pyTruthy(row.truncated) };
}
function overlay(s: Session, o: SessionsApiOptions): Session {
  const live = o.lifecycle?.activeContext.get(String(s.id))?.active_session;
  if (o.running?.has(String(s.id)) && isDict(live) && live.active_turn_id === s.active_turn_id && live.id === s.id) for (const key of ["streaming", "runtime_activity", "tool_activity"]) if (Object.hasOwn(live, key)) s[key] = live[key];
  return s;
}
function send(event: string, revision: unknown, value: unknown): Buffer { return Buffer.from(`id: ${revision}\nevent: ${event}\ndata: ${pyJsonDumps(value, { separators: [",", ":"] })}\n\n`); }
export function createSessionLiveApi(o: SessionsApiOptions, project: (s: Session) => Promise<Row> | Row) {
  const owns = (method: string, p: readonly string[]) => method === "GET" && p.length === 4 && p[0] === "api" && p[1] === "sessions" && ["deltas", "updates"].includes(p[3]!);
  const load = async (sid: string) => overlay(await o.store.load(sid), o);
  return { routes: LIVE_ROUTES, owns,
    async dispatch(method: string, p: string[], query: Row, _data: unknown, request: SessionRequest = {}): Promise<SessionReply | null> {
      if (!owns(method, p)) return null;
      if (!o.enabled("sessions")) return [403, { error: "sessions plugin disabled" }];
      const sid = p[2]!, streaming = request.accept?.includes("text/event-stream");
      if (p[3] === "deltas") {
        try {
          let cursor = pyInt((oneQuery(query, "cursor") ?? "0") as string), streamId = String(oneQuery(query, "stream_id") ?? "");
          if (cursor < 0 || cursor > 2000000 || streamId && !/^[0-9a-f]{32}$/.test(streamId)) throw new PyValueError("invalid cursor");
          const result = modelDeltaPage(await load(sid), streamId, cursor); if (!streaming) return [200, result];
          async function* body(): AsyncGenerator<Uint8Array> {
            const deadline = Date.now() + 30000; let previous: Row | null = null;
            try { while (!request.signal?.aborted && o.enabled("sessions")) {
              const value = modelDeltaPage(await load(sid), streamId, cursor);
              if (!pyEquals(previous, value)) { yield Buffer.from(`id: ${value.streamId}:${value.nextCursor}\nevent: model.delta\ndata: ${pyJsonDumps(value)}\n\n`); previous = value; streamId = value.streamId; cursor = value.nextCursor; }
              if (value.done || Date.now() >= deadline) break; if (cursor < (value.head ?? cursor)) continue; await waitLive(100, request.signal);
            } } catch (e) { if (!isPyOSError(e) && !isPyValueError(e) && pyExceptionName(e) !== "LookupError") throw e; }
          }
          return [200, body(), "text/event-stream"];
        } catch (e) { if (isPyValueError(e) || e instanceof TypeError) return [400, { error: "invalid model stream cursor" }]; if (isPyOSError(e) || ["LookupError", "KeyError"].includes(pyExceptionName(e))) return [404, { error: "session or stream unavailable" }]; throw e; }
      }
      if (await externalRun(o, sid)) return sessionBusy();
      let previous: Row;
      try { previous = await conversationSnapshot(o, sid, streaming ? { tail: true, before: 0, limit: 80 } : null, null, project); }
      catch (e) { if (pyExceptionName(e) === "FileNotFoundError") return [404, { error: "session not found" }]; if (isPyOSError(e) || isPyValueError(e)) return [409, { error: "conversation unavailable" }]; throw e; }
      if (!streaming) return [200, previous];
      async function* updates(): AsyncGenerator<Uint8Array> {
        let revision = previous.journal.history_revision ?? 0; const deadline = Date.now() + 25000; let heartbeat = Date.now();
        if (request.signal?.aborted || !o.enabled("sessions") || await externalRun(o, sid)) return;
        yield send("conversation.snapshot", revision, { revision, snapshot: previous });
        try { while (Date.now() < deadline && !request.signal?.aborted && o.enabled("sessions")) {
          await waitLive(200, request.signal); if (request.signal?.aborted || !o.enabled("sessions") || await externalRun(o, sid)) break;
          const current = await conversationSnapshot(o, sid, { tail: true, before: 0, limit: 80 }, null, project), next = current.journal.history_revision ?? 0, operations = difference(previous, current);
          if (request.signal?.aborted || !o.enabled("sessions") || await externalRun(o, sid)) break;
          if (operations.length) { yield send("conversation.patch", next, { baseRevision: revision, revision: next, operations }); previous = current; revision = next; }
          if (Date.now() - heartbeat > 8000) { yield Buffer.from(": heartbeat\n\n"); heartbeat = Date.now(); }
        } } catch (e) { if (!isPyOSError(e) && !isPyValueError(e)) throw e; }
      }
      return [200, updates(), "text/event-stream; charset=utf-8"];
    } };
}
