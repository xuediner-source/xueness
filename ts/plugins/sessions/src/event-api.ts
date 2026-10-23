import { isDict, pyInt } from "@xueness/contracts";
import { isPyOSError, isPyValueError } from "@xueness/sessions";
import { CursorError, eventCursorPage, eventCursorSse, legacyEvents, legacySse, requestedEventCursor, requestedEventLimit } from "./legacy-events.ts";
import { requestedResumeBase, requestedResumeLimit, requestedResumeProfile, ResumeError, resumePage, resumeSse } from "./event-resume.ts";
import { oneQuery } from "./journal-http.ts";
import type { SessionReply, SessionRequest, SessionsApiOptions } from "./http-api.ts";
type Row = Record<string, any>;
export const EVENT_ROUTES = ["GET /api/sessions/:id/events", "GET /api/sessions/:id/events.resume"];
export function createSessionEventsApi(o: SessionsApiOptions) {
  const owns = (_method: string, p: readonly string[]) => p[0] === "api" && p[1] === "sessions" && p.length === 4 && ["events", "events.resume"].includes(p[3]!);
  const flag = (key: string) => { const general = o.lifecycle?.settings?.().general; return isDict(general) && general[key] === true; };
  return { owns, routes: EVENT_ROUTES,
    async dispatch(method: string, p: string[], query: Row, _data: unknown, request: SessionRequest = {}): Promise<SessionReply | null> {
      if (!owns(method, p)) return null; if (method !== "GET") return [405, { error: "method not allowed" }];
      if (!o.enabled("sessions")) return [403, { error: "plugin disabled or dependency unavailable: sessions", plugin: "sessions" }];
      const resume = p[3] === "events.resume"; if (!/^[0-9a-f]{32}$/.test(p[2]!)) return [404, { error: resume ? "not found" : "session not found" }];
      if (resume && !flag("sessionsEventResumeEnabled")) return [400, { error: "sessions.event_resume not enabled", feature: "sessions.event_resume" }];
      let s: Row; try { s = await o.store.load(p[2]!); } catch (e) { if (isPyOSError(e) || isPyValueError(e)) return [404, { error: "session not found" }]; throw e; }
      const streaming = request.accept?.includes("text/event-stream");
      try {
        if (resume) { const base = requestedResumeBase(query, request.lastEventId), result = resumePage(s, base, requestedResumeLimit(query, base === null), requestedResumeProfile(query)); return streaming ? [200, resumeSse(s, result), "text/event-stream"] : [200, result]; }
        const cursor = requestedEventCursor(query);
        if (cursor) {
          if (!flag("sessionsEventsCursorEnabled")) return [400, { error: "sessions.events_cursor not enabled", feature: "sessions.events_cursor" }];
          const result = eventCursorPage(s, cursor, requestedEventLimit(query)); return streaming ? [200, eventCursorSse(s, result.events), "text/event-stream"] : [200, result];
        }
        let limit: number; try { limit = pyInt((oneQuery(query, "limit") ?? "200") as string); } catch { limit = 200; }
        const events = legacyEvents(s, Math.max(1, Math.min(limit, 500))); return streaming ? [200, legacySse(events), "text/event-stream"] : [200, { id: s.id, status: s.status ?? null, steps: s.steps ?? 0, events }];
      } catch (e) { if (e instanceof ResumeError) return [e.status, e.body]; if (e instanceof CursorError) return [e.status, { error: e.message, errorCode: e.code, ...(e.resync ? { resync_cursor: 0 } : {}) }]; throw e; }
    } };
}
