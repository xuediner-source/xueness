import { isPyOSError, isPyValueError } from "@xueness/sessions";
import { oneQuery } from "./journal-http.ts";
import type { SessionReply, SessionRequest, SessionsApiOptions } from "./http-api.ts";
import { validateWorkspace } from "./queue-http.ts";
import { RuntimeEventConflict, createSessionRuntimeEventLog } from "./runtime-event-log.ts";

type Dict = Record<string, unknown>;
const SID = /^[0-9a-f]{32}$/;
export const RUNTIME_EVENT_ROUTES = ["GET /api/sessions/:id/events.runtime"];

function integerQuery(query: Dict, key: string, fallback: number): number {
  const raw = oneQuery(query, key);
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== "string" || !/^(0|[1-9][0-9]*)$/.test(raw)) throw new TypeError(`invalid ${key}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new TypeError(`invalid ${key}`);
  return value;
}

export function runtimeEventsSse(epoch: string, events: readonly { type: string; sequenceNumber: number }[]): Buffer {
  return Buffer.from(events.map((event) => `id: re1.${epoch}.${event.sequenceNumber}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), "utf8");
}

/** Separate native runtime event route; legacy events endpoints retain their current wire shape. */
export function createSessionRuntimeEventsApi(o: SessionsApiOptions) {
  const owns = (_method: string, parts: readonly string[]) => parts[0] === "api" && parts[1] === "sessions" && parts.length === 4 && parts[3] === "events.runtime";
  return {
    owns, routes: RUNTIME_EVENT_ROUTES,
    async dispatch(method: string, parts: string[], query: Dict, _data: unknown, request: SessionRequest = {}): Promise<SessionReply | null> {
      if (!owns(method, parts)) return null;
      if (method !== "GET") return [405, { error: "method not allowed" }];
      if (!o.enabled("sessions")) return [403, { error: "plugin disabled or dependency unavailable: sessions", plugin: "sessions" }];
      const sid = parts[2]!;
      if (!SID.test(sid)) return [404, { error: "session not found" }];
      let session;
      try { session = await o.store.load(sid); }
      catch (error) { if (isPyOSError(error) || isPyValueError(error)) return [404, { error: "session not found" }]; throw error; }
      try { await validateWorkspace(o, session); }
      catch (error) { if (isPyValueError(error)) return [403, { error: "workspace root not permitted" }]; throw error; }
      let after: number, limit: number;
      const header = request.lastEventId?.trim();
      if (header) {
        const match = /^re1\.([^.]+)\.([0-9]+)$/.exec(header);
        if (!match || !Number.isSafeInteger(Number(match[2]))) return [400, { error: 'invalid Last-Event-ID' }];
        const requestedAfter = oneQuery(query, 'after'), requestedEpoch = oneQuery(query, 'epoch');
        if (requestedAfter !== undefined && String(requestedAfter) !== match[2] || requestedEpoch !== undefined && requestedEpoch !== match[1]) return [400, { error: 'conflicting runtime event cursor' }];
        query = { ...query, after: match[2], epoch: match[1] };
      }
      try { after = integerQuery(query, "after", 0); limit = integerQuery(query, "limit", 200); }
      catch { return [400, { error: "after must be a non-negative integer and limit must be 1..500" }]; }
      if (limit < 1 || limit > 500) return [400, { error: "limit must be 1..500" }];
      const rawEpoch = oneQuery(query, "epoch");
      if (rawEpoch !== undefined && (typeof rawEpoch !== "string" || !rawEpoch)) return [400, { error: "epoch must be a non-empty string" }];
      if (after > 0 && rawEpoch === undefined) return [400, { error: "after requires epoch" }];
      try {
        const page = createSessionRuntimeEventLog(o.stateDir, sid).readPage({ after, limit, ...(typeof rawEpoch === "string" ? { epoch: rawEpoch } : {}) });
        return request.accept?.includes("text/event-stream") ? [200, runtimeEventsSse(page.epoch, page.events), "text/event-stream"] : [200, page];
      } catch (error) {
        if (error instanceof RuntimeEventConflict) return [409, { error: error.message, errorCode: "runtime_event_cursor_conflict" }];
        throw error;
      }
    },
  };
}
