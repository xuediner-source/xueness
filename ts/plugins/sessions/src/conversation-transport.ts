/** Snapshot/resume and multiplexed long-poll transport over observed projections. */
import { isPyOSError, isPyValueError, pyExceptionName, type Session } from "@xueness/sessions";
import { ConversationCache, ExternalConversationRun, type Row } from "./conversation-cache.ts";
import { conversationBase, ConversationWatch, WatchError, watchRequest } from "./conversation-watch.ts";
import { SnapshotError } from "./snapshot-rows.ts";
import { externalRun, sessionBusy } from "./queue-http.ts";
import type { SessionReply, SessionRequest, SessionsApiOptions } from "./http-api.ts";
export const CONVERSATION_TRANSPORT_ROUTES = ["GET /api/sessions/:id/conversation-transport", "GET /api/sessions/conversation-transport/watch"];
export function createConversationTransportApi(o: SessionsApiOptions, project: (s: Session) => Promise<Row> | Row) {
  const cache = new ConversationCache(o, project), watcher = new ConversationWatch(cache);
  const owns = (_method: string, p: readonly string[]) => p[0] === "api" && p[1] === "sessions" && p.length === 4 && (p[3] === "conversation-transport" || p[2] === "conversation-transport" && p[3] === "watch");
  return { routes: CONVERSATION_TRANSPORT_ROUTES, cache, owns,
    async dispatch(method: string, p: string[], query: Row, _data: unknown, request: SessionRequest = {}): Promise<SessionReply | null> {
      if (!owns(method, p)) return null;
      if (!o.enabled("sessions")) { cache.clear(); return [403, { error: "plugin disabled or dependency unavailable: sessions", plugin: "sessions" }]; }
      if (method !== "GET") return [405, { error: "method not allowed" }];
      const watch = p[3] === "watch";
      try {
        if (watch) {
          const selected = watchRequest(query, cache.epoch);
          for (const [sid] of selected.topics) if (await externalRun(o, sid)) return sessionBusy();
          return [200, await watcher.watch(selected, request.signal)];
        }
        const base = conversationBase(query); if (!/^[0-9a-f]{32}$/.test(p[2]!)) return [404, { error: "session not found" }];
        if (await externalRun(o, p[2]!)) return sessionBusy();
        return [200, await cache.observe(p[2]!, base)];
      } catch (e) {
        if (e instanceof ExternalConversationRun) { cache.clear(); return sessionBusy(); }
        const name = pyExceptionName(e);
        if (name === "PermissionError") return [403, { error: "plugin disabled or dependency unavailable: sessions", plugin: "sessions" }];
        if (e instanceof WatchError) return [400, { error: e.message }];
        if (name === "WatchBusy") return [503, { error: (e as Error).message }];
        if (e instanceof SnapshotError) return [e.status, { error: e.message }];
        if (name === "FileNotFoundError") return [404, { error: "session not found" }];
        if (isPyValueError(e) && (e as Error).message === "invalid conversation transport base") return [400, { error: (e as Error).message }];
        if (isPyOSError(e) || isPyValueError(e) || e instanceof TypeError) return [409, { error: "conversation unavailable; request a new snapshot" }];
        throw e;
      }
    } };
}
