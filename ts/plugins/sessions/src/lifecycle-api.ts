import { appendUserTurn, answerSession } from "@xueness/agent";
import { isDict, pyLen, pyStrip, pyUtcNow, PyValueError, uuid4Hex } from "@xueness/contracts";
import { isPyOSError, isPyValueError, pyExceptionName, type Session } from "@xueness/sessions";
import { pendingDenials } from "./public-session.ts";
import { requestedSelection, selectionRecord, validateRun } from "./run-validation.ts";
import { runErrorResponse } from "./run-errors.ts";
import { approveSession } from "./approvals.ts";
import { sessionBusy } from "./queue-http.ts";
import { PreparedRefusal } from "./prepared-input.ts";
import type { SessionReply } from "./http-api.ts";
import type { LifecycleOptions, Row, RunPolicy } from "./lifecycle-types.ts";
const SID = /^[0-9a-f]{32}$/;
const GUIDANCE = "Configure a model with `xueness providers save ID --base-url URL --model MODEL --key-env ENV`, or set XUENESS_API_BASE, XUENESS_MODEL, and XUENESS_API_KEY (Anthropic also accepts ANTHROPIC_API_KEY with XUENESS_PROVIDER=anthropic).";
function configurationError(error: unknown): string { const message = (error as Error).message || "model provider is not configured"; return message.includes(GUIDANCE) ? message : `${message.includes("XUENESS_MODEL and XUENESS_API_KEY must be set") ? "no model provider is configured" : message}. ${GUIDANCE}`; }
export function rejectLegacyFake(session: Session): void {
  const selection = isDict(session.model_selection) ? session.model_selection : {};
  const messages = Array.isArray(session.messages) ? session.messages : [];
  const demo = (id: unknown) => typeof id === "string" && (id === "demo-write" || id.startsWith("demo-read"));
  if (["fake", "demo", "offline"].includes(String(session.provider_mode)) || ["fake", "demo"].includes(String(selection.provider_id)) || messages.some((m) => isDict(m) && (demo(m.tool_call_id) || (Array.isArray(m.tool_calls) && m.tool_calls.some((c) => isDict(c) && demo(c.id)))))) throw new PyValueError("This session was run with the retired offline demo provider and cannot be resumed with a real model. Start a new session to continue with a configured model.");
}
export function ownsLifecycleRoute(method: string, parts: readonly string[]): boolean { return method === "POST" && parts.length === 4 && parts[0] === "api" && parts[1] === "sessions" && SID.test(parts[2]!) && ["run", "stop", "messages", "answer", "approvals"].includes(parts[3]!); }
export function createSessionLifecycleApi(options: LifecycleOptions) {
  const stopRequested = new Set<string>(), stopTargets = new Map<string, string>();
  const runners = new Map<string, ReturnType<LifecycleOptions["createRunner"]>>();
  const store = options.store;
  const externalRun = async (sid: string): Promise<boolean> => {
    if (options.running.has(sid)) return false;
    try { const lease = await store.lease(sid); await lease.release(); return false; }
    catch (e) { if (pyExceptionName(e) === "BlockingIOError") return true; throw e; }
  };
  const requestStop = (sid: string, turnId?: string) => { if (turnId) stopTargets.set(sid, turnId); else stopRequested.add(sid); };
  const stop = async (sid: string, expectedTurn?: string | null): Promise<SessionReply> => {
    const busy = options.running.has(sid), fenced = expectedTurn !== undefined;
    let lease: Awaited<ReturnType<typeof store.lease>> | null = null;
    let session: Session;
    try { if (fenced && !busy) lease = await store.lease(sid); session = await store.load(sid); }
    catch (e) { if (pyExceptionName(e) === "BlockingIOError") return [409, { error: "session is in use by another process", reasonCode: "stale_turn" }]; if (isPyOSError(e) || isPyValueError(e)) return [404, { error: "session not found" }]; throw e; }
    finally { await lease?.release(); }
    if (fenced && (expectedTurn === null && busy || expectedTurn !== null && (!busy || session.active_turn_id !== expectedTurn))) return [409, { error: "active turn changed; refresh before stopping", reasonCode: "stale_turn" }];
    if (busy) {
      requestStop(sid, fenced && expectedTurn ? expectedTurn : undefined);
      const general = options.settings?.().general;
      if (isDict(general) && general.sessionsCancelPropagateEnabled === true) runners.get(sid)?.cancel(sid);
    }
    const taskWorks = options.cancelTasks?.(sid) ?? [];
    const cancelled = taskWorks.filter((r) => r.outcome === "cancelled").map((r) => r.workId);
    const payload: Row = { id: sid, stopping: busy, status: session.status ?? null, cancelled_tasks: cancelled };
    const general = options.settings?.().general;
    if (isDict(general) && general.sessionsCancelReceiptEnabled === true) {
      const works = [{ workId: sid.slice(0, 80), kind: "session", outcome: busy ? "stop_requested" : "idle" }, ...taskWorks];
      const outcome = busy ? "stop_requested" : cancelled.length ? "cancelled" : taskWorks.some((r) => r.outcome === "rejected") ? "rejected" : "idle";
      Object.assign(payload, { schema: "xueness.cancel-receipt.v1", feature: "sessions.cancel_receipt", outcome, works, ...(!busy && !cancelled.length ? { reason: outcome === "rejected" ? "not_running" : "nothing_running" } : {}) });
    }
    return [200, payload];
  };
  const run = async (sid: string, data: Row, command?: { id: string; fingerprint: string }): Promise<SessionReply | null> => {
    let validated: ReturnType<typeof validateRun>, selected: Row;
    try { validated = validateRun(data, options.knownTools?.() ?? ["read", "write", "edit", "list", "grep", "glob", "exec", "mcp", "task", "ask_user"]); selected = requestedSelection(data); }
    catch (e) { if (isPyValueError(e)) return [400, { error: (e as Error).message }]; throw e; }
    const providerName = data.provider ?? "real";
    if (providerName === "fake") return [400, { error: "the offline fake provider has been removed; configure a model provider" }];
    if (providerName === "real" && !options.enabled("providers")) return [403, { error: "plugin disabled or dependency unavailable: providers", plugin: "providers" }];
    if (providerName === "real" && !options.allowReal) return [403, { error: "real provider disabled by the host; set XUENESS_ALLOW_REAL=1 to enable it" }];
    if (providerName !== "real") return [400, { error: "provider must be 'real' when specified" }];
    if (options.running.has(sid)) return [409, { error: "session run already in progress" }];
    let session: Session;
    try { session = await store.load(sid); } catch (e) { if (isPyOSError(e) || isPyValueError(e)) return [404, { error: "session not found" }]; throw e; }
    try { rejectLegacyFake(session); } catch (e) { return [409, { error: (e as Error).message }]; }
    const permissionMode = validated.permissionMode ?? session.permission_mode ?? "build";
    if (!["build", "edit", "yolo", "plan", "guarded"].includes(String(permissionMode))) return [400, { error: "saved permission mode is invalid" }];
    if (permissionMode === "yolo" && (session.permission_mode ?? "build") !== "yolo" && !validated.acknowledgeYolo) return [428, { error: "confirm full access before escalating this session to yolo", error_code: "yolo_confirmation_required" }];
    if (options.supports && !options.supports(session, data)) return [409, { error: "this session needs a capability this host does not provide", code: "unsupported_run" }];
    if ((data.continue_queue || data.promotion_request_id || session.current_queue_item_id) && !options.runQueue) return [409, { error: "queued runs are unavailable in this host", code: "unsupported_run" }];
    const savedRemote = session.remote_connection;
    if (savedRemote !== undefined && savedRemote !== null) {
      if (!isDict(savedRemote) || typeof savedRemote.id !== "string" || typeof savedRemote.digest !== "string") return [409, { error: "saved remote session selection is invalid; start a new session" }];
      if (data.remote !== savedRemote.id) return [409, { error: "select the same remote connection bound to this session" }];
      try { if (!options.checkRemote) throw new PyValueError("remote plugin disabled or unavailable"); await options.checkRemote(savedRemote); }
      catch (e) { if (isPyValueError(e)) return [409, { error: (e as Error).message }]; throw e; }
    } else if (data.remote !== undefined && data.remote !== null) return [409, { error: "prepare this turn with the selected remote connection before running" }];
    const prior = isDict(session.model_selection) ? session.model_selection : {};
    const effective: Row = { provider_id: selected.provider_id ?? prior.provider_id ?? null, model: selected.model ?? prior.model ?? null, reasoning_effort: Object.hasOwn(selected, "reasoning_effort") ? selected.reasoning_effort : prior.reasoning_effort ?? null };
    const policy: RunPolicy = { ...validated.policy, permissionMode: permissionMode as RunPolicy["permissionMode"], selection: { providerId: effective.provider_id as string | null, model: effective.model as string | null, reasoningEffort: effective.reasoning_effort as string | null, runtimeProfile: data.runtime_profile as string | null } };
    const traceId = uuid4Hex().slice(0, 16);
    let provider: ReturnType<LifecycleOptions["resolveProvider"]>;
    try { provider = options.resolveProvider(policy.selection, sid); }
    catch (e) { return [400, { error: configurationError(e), error_code: "provider_configuration_error", trace_id: traceId }]; }
    const before = await options.beforeRun?.(session, data); if (before) return before;
    if (options.running.has(sid)) return [409, { error: "session run already in progress" }];
    options.running.add(sid); options.activeContext.set(sid, { model_selection: selectionRecord(effective), remote_connection: session.remote_connection ?? null, active_session: session, run_command_id: command?.id ?? null });
    try {
      const oldMode = session.permission_mode ?? "build";
      if (oldMode !== permissionMode) { const history = (session.permission_mode_history ??= []) as Row[]; history.push({ from: oldMode, to: permissionMode, at: pyUtcNow() }); session.permission_mode_history = history.slice(-50); }
      session.permission_mode = permissionMode;
      session.model_selection = selectionRecord(effective);
      if (policy.browser !== undefined) session.browser_enabled = policy.browser;
      const runner = options.createRunner(session, provider, policy); runners.set(sid, runner);
      const invoke = (current: Session) => runner.run(current, { ...validated.options, shouldStop: () => stopRequested.has(sid) || stopTargets.has(sid) && stopTargets.get(sid) === current.active_turn_id });
      const out = options.runQueue ? await options.runQueue(session, policy, invoke) : await invoke(session);
      await options.afterRun?.(out);
      return [200, { id: out.id, status: out.status, steps: out.steps, mode: out.mode ?? policy.mode, completion: out.completion, pending: pendingDenials(out, options), pending_question: out.pending_question ?? null, todos: out.todos ?? [], hook_log: out.hook_log ?? [], plugin_refused: [], tasks: options.tasks?.(sid) ?? [] }];
    } catch (e) { if (pyExceptionName(e) === "BlockingIOError") return [409, { error: "session is in use by another process" }]; return runErrorResponse(e, traceId); }
    finally { runners.delete(sid); options.running.delete(sid); options.activeContext.delete(sid); stopRequested.delete(sid); stopTargets.delete(sid); }
  };
  const send = async (sid: string, data: Row, answer = false, command?: { id: string; fingerprint: string }): Promise<SessionReply | null> => {
    const text = answer ? data.answer ?? data.text ?? "" : data.text;
    if (!answer && (typeof text !== "string" || !pyStrip(text) || pyLen(text) > 5000)) return [400, { error: "message must be 1..5000 characters" }];
    if (!answer && Object.hasOwn(data, "prepared_token") && typeof data.prepared_token !== "string") return [400, { error: "prepared input invalid or expired" }];
    if (!answer) { try { requestedSelection(data); } catch (e) { return [400, { error: (e as Error).message }]; } }
    if (!answer && options.running.has(sid)) return [409, { error: "session run already in progress" }];
    let session: Session;
    try { session = await store.load(sid); } catch (e) { if (isPyOSError(e) || isPyValueError(e)) return [404, { error: "session not found" }]; throw e; }
    if (!answer && pendingDenials(session, options).length) return [409, { error: "resolve pending approvals before a new turn" }];
    if (!answer && options.queueSnapshot) { try { const q = await options.queueSnapshot(sid); if (Array.isArray(q.queued_messages) && q.queued_messages.length) return [409, { error: "run queued messages before sending a new turn" }]; } catch { return [500, { error: "cannot read message queue" }]; } }
    if (!answer && Object.hasOwn(data, "prepared_token") && !options.appendUserTurn) return [409, { error: "prepared input is unavailable in this host", code: "unsupported" }];
    try {
      const lease = await store.lease(sid);
      try {
        session = await store.load(sid);
        if (answer) { session = options.answerSession ? await options.answerSession(session, String(text)) : await answerSession(session, store, text as string); return [200, { id: session.id, status: session.status, pending_question: session.pending_question ?? null }]; }
        rejectLegacyFake(session);
        session = options.appendUserTurn ? await options.appendUserTurn(session, text as string, data, command) : await appendUserTurn(session, store, text as string);
        return [200, { id: session.id, status: session.status, steps: session.steps }];
      } finally { await lease.release(); }
    } catch (e) {
      if (e instanceof PreparedRefusal) return [e.status, e.body];
      const name = pyExceptionName(e);
      if (name === "BlockingIOError") return [409, { error: "session is in use by another process" }];
      if (name === "LookupError") return [409, { error: answer ? "session is not awaiting a user answer" : "session is not ready for a new turn" }];
      if (isPyValueError(e)) return [answer ? 400 : String((e as Error).message).includes("retired offline demo") ? 409 : 400, { error: answer ? "answer must be 1..5000 characters" : String((e as Error).message).toLowerCase().includes("prepared") || String((e as Error).message).includes("retired offline demo") ? (e as Error).message : configurationError(e) }];
      if (isPyOSError(e)) return [500, { error: answer ? "cannot save answer" : "cannot save message" }];
      throw e;
    }
  };
  return {
    owns: ownsLifecycleRoute, requestStop, stop, run, send,
    async dispatch(method: string, parts: string[], _query: Row, data: unknown): Promise<SessionReply | null> {
      if (!ownsLifecycleRoute(method, parts)) return null;
      if (!options.enabled("sessions")) return [403, { error: "plugin disabled or dependency unavailable: sessions", plugin: "sessions", code: "plugin_disabled" }];
      if (!isDict(data)) return [400, { error: "invalid json body", code: "invalid_json" }];
      // Live state belongs to the process holding the operating-system lease.
      if (await externalRun(parts[2]!)) return sessionBusy();
      if (parts[3] === "stop") return stop(parts[2]!);
      if (parts[3] === "run") return run(parts[2]!, data);
      if (parts[3] === "messages" || parts[3] === "answer") return send(parts[2]!, data, parts[3] === "answer");
      if (parts[3] === "approvals") return approveSession(options, parts[2]!, data);
      return null;
    },
  };
}
