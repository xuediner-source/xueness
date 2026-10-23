import { isDict } from "@xueness/contracts";
import { isPyOSError, isPyValueError, pyExceptionName } from "@xueness/sessions";
import { archiveSession, deleteArchivedSession, restoreSession } from "./archive.ts";
import type { SessionReply, SessionsApiOptions } from "./http-api.ts";
type Row = Record<string, unknown>;
const SID = /^[a-f0-9]{32}$/;
export function ownsManagementRoute(method: string, p: readonly string[]): boolean { return p[0] === "api" && p[1] === "sessions" && (method === "DELETE" && (p.length === 3 && SID.test(p[2]!) || p.length === 4 && p[2] === "archived" && SID.test(p[3]!)) || method === "POST" && p.length === 4 && SID.test(p[2]!) && p[3] === "restore"); }
export function createSessionManagementApi(o: SessionsApiOptions) {
  return { owns: ownsManagementRoute,
    async dispatch(method: string, p: string[], _q: Row, data: unknown): Promise<SessionReply | null> {
      if (!ownsManagementRoute(method, p)) return null;
      if (!o.enabled("sessions")) return [403, { error: "plugin disabled or dependency unavailable: sessions", plugin: "sessions", code: "plugin_disabled" }];
      const permanent = p[2] === "archived", restore = method === "POST", sid = permanent ? p[3]! : p[2]!;
      if (permanent && (!isDict(data) || Object.keys(data).sort().join(",") !== "confirmed,expectedRevision" || data.confirmed !== true || typeof data.expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(data.expectedRevision))) return [400, { error: "explicit confirmation and archived revision required" }];
      if (o.running?.has(sid) || o.lifecycle?.running.has(sid)) return [409, { error: "session run already in progress" }];
      try {
        const lease = await o.store.lease(sid);
        try {
          if (permanent) await deleteArchivedSession(o.store, sid, (data as Row).expectedRevision as string);
          else if (restore) await restoreSession(o.store, sid);
          else await archiveSession(o.store, sid, o.stateDir);
        } finally { await lease.release(); }
        if (!restore) { o.lifecycle?.approvals.delete(sid); o.lifecycle?.liveApprovals?.close(sid); }
        return [200, restore ? { ok: true, id: sid } : { id: sid, deleted: true, ...(permanent ? { permanent: true } : {}) }];
      } catch (e) {
        const name = pyExceptionName(e);
        if (permanent && name === "FileNotFoundError") return [404, { error: "archived session not found" }];
        if (!restore && !permanent && name === "FileNotFoundError") return [404, { error: "session not found" }];
        if (permanent && name === "FileExistsError") return [409, { error: (e as Error).message }];
        if (name === "BlockingIOError") return [409, { error: "session is in use by another process" }];
        if ((permanent || restore) && isPyValueError(e)) return [400, { error: (e as Error).message }];
        if (isPyOSError(e) || isPyValueError(e)) return [500, { error: permanent ? "cannot permanently delete archived session" : restore ? "cannot restore session" : "cannot delete session" }];
        throw e;
      }
    } };
}
