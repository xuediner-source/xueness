/** Session-owned model switching and manual context compaction HTTP controls. */
import type { AgentProvider } from "@xueness/agent";
import { isDict, pyEquals, pyTruthy } from "@xueness/contracts";
import { isPyOSError, isPyValueError, pyExceptionName, type Session, type SessionStore } from "@xueness/sessions";
import type { RuntimeSelection } from "./lifecycle-types.ts";
import { CompactError, compactLeased } from "./manual-compact.ts";
import { currentModelSelection, normalizeModelSwitch, planModelSelection, recordModelSwitch, type SwitchableAgentProvider } from "./model-switch.ts";
import type { SessionReply } from "./http-api.ts";
type Row = Record<string, unknown>;
export interface SessionRuntimeOptions {
  store: SessionStore; stateDir: string; enabled(id: string): boolean;
  running: ReadonlySet<string>; activeContext: Map<string, Row>;
  resolveProvider(selection: RuntimeSelection, sid: string): AgentProvider;
  activeProvider(sid: string): SwitchableAgentProvider | null;
  levels(selection: Row): string[];
  configurationError(error: unknown): string;
  supportsSelection?: (session: Session, selected: Row) => boolean;
  defaultApi?: (method: string, data: Row) => SessionReply | null | Promise<SessionReply | null>;
  now?: () => string;
  /** ZCode manual compaction with the session model (see manual-compact.ts). */
  modelCompact?: (session: Session, instructions: string | null, source: string) => Promise<Row | null>;
}
const SID = /^[0-9a-f]{32}$/;
export function createSessionRuntimeApi(o: SessionRuntimeOptions) {
  const saveDefault = async (selected: Row): Promise<SessionReply | null> => o.defaultApi ? await o.defaultApi("POST", { providerId: selected.provider_id, model: selected.model, reasoningEffort: selected.reasoning_effort ?? null }) : [501, { error: "providers default selection is unavailable" }];
  const apply = async (sid: string, requested: Row): Promise<SessionReply | null> => {
    const [fields, error] = normalizeModelSwitch(requested); if (error) return [400, { error }];
    if (!["provider_id", "model", "reasoning_effort", "selection"].some((key) => fields[key] != null)) return [400, { error: "nothing to change: provider_id, model, selection or reasoning_effort" }];
    let session: Session;
    try { session = await o.store.load(sid); } catch (e) { if (isPyOSError(e) || isPyValueError(e)) return [404, { error: "session not found" }]; throw e; }
    const switcher = o.running.has(sid) ? o.activeProvider(sid) : null;
    if (switcher) session = switcher.session;
    else if (o.running.has(sid)) return [409, { error: "a run is active for this session; stop it before switching models" }];
    const previous = currentModelSelection(session); let selected: Row;
    try { selected = planModelSelection(previous, fields); } catch (e) { return [400, { error: (e as Error).message }]; }
    if (o.supportsSelection && !o.supportsSelection(session, selected)) return null;
    let provider: AgentProvider;
    try { provider = o.resolveProvider({ providerId: selected.provider_id as string | null, model: selected.model as string | null, reasoningEffort: selected.reasoning_effort as string | null, runtimeProfile: fields.runtime_profile as string | null }, sid); }
    catch (e) { return [400, { error: o.configurationError(e) }]; }
    const runtime = provider.runtimeProfile ?? "standard";
    if (fields.save_default) { const result = await saveDefault(selected); if (!result || result[0] >= 400) return result; }
    if (switcher && runtime !== (switcher.runtimeProfile ?? "standard")) return [409, { error: "runtime profile differs from the active run; stop this turn first" }];
    const source = typeof fields.source === "string" ? fields.source : "api";
    let history: unknown;
    if (switcher) {
      if (o.activeProvider(sid) !== switcher || !o.running.has(sid)) return [409, { error: "active run changed while switching; try again" }];
      recordModelSwitch(session, previous, selected, source, "next_request", o.now?.()); session.model_selection = selected; session.runtime_profile = runtime;
      switcher.switchTo(selected, provider); const live = o.activeContext.get(sid); if (live) live.model_selection = { ...selected };
      history = session.model_history;
    } else {
      let lease: Awaited<ReturnType<SessionStore["lease"]>> | null = null;
      try {
        lease = await o.store.lease(sid); const stored = await o.store.load(sid);
        if (!pyEquals(currentModelSelection(stored), previous)) return [409, { error: "model selection changed while switching; try again" }];
        recordModelSwitch(stored, previous, selected, source, "immediate", o.now?.()); stored.model_selection = selected; stored.runtime_profile = runtime; await o.store.save(stored); history = stored.model_history;
      } catch (e) { if (pyExceptionName(e) === "BlockingIOError") return [409, { error: "session is in use by another process" }]; if (isPyOSError(e) || isPyValueError(e)) return [500, { error: "cannot save model selection" }]; throw e; }
      finally { await lease?.release(); }
    }
    return [200, { id: sid, model_selection: selected, applied: switcher ? "next_request" : "immediate", levels: o.levels(selected), model_history: history, default_saved: !!fields.save_default }];
  };
  return {
    routes: ["GET /api/sessions/:id/model", "POST /api/sessions/:id/model", "POST /api/sessions/:id/compact"],
    owns(_method: string, parts: readonly string[]) { return parts.length === 4 && parts[0] === "api" && parts[1] === "sessions" && SID.test(parts[2]!) && ["model", "compact"].includes(parts[3]!); },
    async dispatch(method: string, parts: string[], _query: Row, data: unknown): Promise<SessionReply | null> {
      if (!this.owns(method, parts)) return null;
      if (!o.enabled("sessions")) return [403, { error: "plugin disabled or dependency unavailable: sessions", plugin: "sessions" }];
      const sid = parts[2]!;
      if (parts[3] === "compact") {
        if (method !== "POST") return [405, { error: "method not allowed" }];
        if (!isDict(data) || Object.keys(data).some((key) => key !== "instructions")) return [400, { error: "expected only an instructions string" }];
        if (data.instructions != null && typeof data.instructions !== "string") return [400, { error: "instructions must be text" }];
        if (o.running.has(sid)) return [409, { error: "请先停止运行，再压缩上下文。", reason: "run_in_progress" }];
        try { return [200, await compactLeased(o.store, sid, data.instructions, { enabled: o.enabled, source: "http", ...o.modelCompact ? { modelCompact: o.modelCompact } : {} })]; }
        catch (e) { if (e instanceof CompactError) return [e.status, e.payload()]; if (isPyOSError(e) || isPyValueError(e)) return [400, { error: "cannot compact session" }]; throw e; }
      }
      if (!["GET", "POST"].includes(method)) return [405, { error: "method not allowed" }];
      if (!o.running.has(sid)) { try { const lease = await o.store.lease(sid); await lease.release(); } catch (e) { if (pyExceptionName(e) === "BlockingIOError") return null; throw e; } }
      if (method === "POST") return isDict(data) ? apply(sid, data) : [400, { error: "body must be a JSON object" }];
      let session: Session;
      try { session = await o.store.load(sid); } catch (e) { if (isPyOSError(e) || isPyValueError(e)) return [404, { error: "session not found" }]; throw e; }
      if (o.supportsSelection && !o.supportsSelection(session, currentModelSelection(session))) return null;
      const selection = currentModelSelection(session), saved = await o.defaultApi?.("GET", {});
      return [200, { id: sid, model_selection: selection, levels: o.levels(selection), runtime_profile: session.runtime_profile ?? null, model_history: (Array.isArray(session.model_history) ? session.model_history : []).slice(-50), default: saved?.[0] === 200 && isDict(saved[1]) ? saved[1].default ?? null : null }];
    },
  };
}
