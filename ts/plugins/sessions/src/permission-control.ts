import { isDict, pyUtcNow } from "@xueness/contracts";
import { isPyOSError, isPyValueError, pyExceptionName, type Session, type SessionStore } from "@xueness/sessions";
import type { SessionReply } from "./http-api.ts";
import type { RunPolicy } from "./lifecycle-types.ts";

export type SessionPermissionMode = RunPolicy["permissionMode"];
export interface PermissionControl {
  session: Session;
  setMode(mode: SessionPermissionMode): void;
  reconsider(): number;
}
export interface PermissionControlOptions {
  store: SessionStore;
  enabled(id: string): boolean;
  running: ReadonlySet<string>;
  permissionControl(sid: string): PermissionControl | null;
}
const MODES = ["build", "edit", "yolo", "plan", "guarded"];

export function createPermissionControlApi(o: PermissionControlOptions) {
  const owns = (_method: string, p: readonly string[]) => p.length === 4 && p[0] === "api" && p[1] === "sessions" && /^[0-9a-f]{32}$/.test(p[2]!) && p[3] === "permission";
  return { routes: ["POST /api/sessions/:id/permission"], owns,
    async dispatch(method: string, p: string[], _query: Record<string, unknown>, data: unknown): Promise<SessionReply | null> {
      if (!owns(method, p)) return null;
      if (!o.enabled("sessions")) return [403, { error: "sessions plugin disabled", plugin: "sessions" }];
      if (method !== "POST") return [405, { error: "method not allowed" }];
      if (!isDict(data) || Object.keys(data).some(k => !["permission_mode", "acknowledge_yolo", "expected_turn_id"].includes(k)) || !MODES.includes(String(data.permission_mode))) return [400, { error: "invalid permission mode" }];
      const mode = data.permission_mode as SessionPermissionMode, sid = p[2]!;
      if (mode === "guarded" && !o.enabled("planning")) return [403, { error: "guarded mode requires planning", plugin: "planning" }];
      let lease: Awaited<ReturnType<SessionStore["lease"]>> | null = null;
      try {
        const control = o.running.has(sid) ? o.permissionControl(sid) : null;
        if (o.running.has(sid) && !control) return [409, { error: "active permission control unavailable" }];
        if (!control) lease = await o.store.lease(sid);
        const session = control?.session ?? await o.store.load(sid), previous = session.permission_mode ?? "build";
        if (Object.hasOwn(data, "expected_turn_id") && data.expected_turn_id !== (session.active_turn_id ?? null)) return [409, { error: "active turn changed; refresh before changing permissions", reasonCode: "stale_turn" }];
        if (mode === "yolo" && previous !== "yolo" && data.acknowledge_yolo !== true) return [428, { error: "confirm full access before escalating this session", error_code: "yolo_confirmation_required" }];
        if (previous !== mode) {
          session.permission_mode = mode;
          const history = Array.isArray(session.permission_mode_history) ? session.permission_mode_history : [];
          session.permission_mode_history = [...history, { from: previous, to: mode, at: pyUtcNow(), source: "user" }].slice(-50);
          control?.setMode(mode);
          try { await o.store.save(session); }
          catch (error) { session.permission_mode = previous; session.permission_mode_history = history; control?.setMode(previous as SessionPermissionMode); throw error; }
        }
        const resumed = control?.reconsider() ?? 0;
        return [200, { id: sid, permission_mode: mode, resumed, applied: control ? "live" : "immediate" }];
      } catch (e) {
        if (pyExceptionName(e) === "BlockingIOError") return [409, { error: "session is in use by another process" }];
        if (pyExceptionName(e) === "FileNotFoundError") return [404, { error: "session not found" }];
        if (isPyOSError(e) || isPyValueError(e)) return [400, { error: "cannot change session permissions" }];
        throw e;
      } finally { await lease?.release(); }
    } };
}
