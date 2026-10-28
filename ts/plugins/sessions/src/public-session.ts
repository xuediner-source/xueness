/** Whitelisted session detail projection, shared by HTTP and snapshot transports. */
import { isDict, isPyIntValue, numericValue, pyJsonDumps, pyJsonLoads, pyLen, pySlice } from "@xueness/contracts";
import { FINISH_REASONS, publicDiagnostics } from "@xueness/providers";
import { publicSegments, type Session } from "@xueness/sessions";
import { timelineMarkers } from "./timeline-markers.ts";
import { publicToolActivity } from "./tool-activity.ts";
import { publicTurnState, publicBackgroundTasks } from "./public-turn.ts";

const ONE_SHOT = new Set(["always_ask", "ask_rule", "remote_exec", "plan_exit", "guarded"]);
type Dict = Record<string, unknown>;
export type ApprovalBuckets = Map<string, Map<string, Map<string, string>>>;
export interface ToolInfo { kind?: string; subject: string; preview?: string; }
export interface PublicSessionOptions {
  enabled: (id: string) => boolean;
  approvals: ApprovalBuckets;
  toolInfo?: (name: string, args: Dict) => ToolInfo | null;
  toolOwner?: (name: string) => string | null;
  queueSnapshot?: (sid: string) => Promise<Dict>;
  guidanceSnapshot?: (session: Session) => Promise<Dict>;
  goalView?: (session: Session) => unknown;
  running?: ReadonlySet<string>;
  activeContext?: ReadonlyMap<string, Dict>;
}
export function defaultToolInfo(name: string, args: Dict): ToolInfo | null {
  if (name === "edit") {
    const part = (value: unknown, marker: string) => {
      const text = String(value ?? "").slice(0, 200);
      return text ? text.replace(/\r?\n$/, "").split(/\r?\n/).map(line => marker + line) : [];
    };
    return { kind: name, subject: String(args.path ?? ""), preview: ["--- a", "+++ b", ...part(args.old_string ?? args.old, "-"), ...part(args.new_string ?? args.new, "+")].join("\n") };
  }
  if (["read", "list", "write"].includes(name)) return { kind: name, subject: String(args.path ?? ""), preview: "" };
  if (["glob", "grep"].includes(name)) return { kind: name, subject: String(args.path ?? ".") };
  if (name === "exec") return { kind: "exec", subject: Array.isArray(args.argv) && args.argv.every((v) => typeof v === "string") ? pyJsonDumps(args.argv, { separators: [",", ":"] }) : typeof args.command === "string" ? args.command : "" };
  return null;
}
export function pendingDenials(session: Session, options: Pick<PublicSessionOptions, "toolInfo"> = {}): Dict[] {
  const calls = new Map<string, Dict>();
  const results = isDict(session.results) ? session.results : {};
  for (const m of Array.isArray(session.messages) ? session.messages : []) {
    if (!isDict(m)) continue;
    for (const c of Array.isArray(m.tool_calls) ? m.tool_calls : []) {
      if (!isDict(c) || typeof c.id !== "string" || !c.id) continue;
      const f = isDict(c.function) ? c.function : {}, name = String(f.name ?? "");
      let args: unknown = {}; try { args = pyJsonLoads(String(f.arguments ?? "{}")); } catch { /* Invalid arguments cannot confer approval. */ }
      const info = (options.toolInfo ?? defaultToolInfo)(name, isDict(args) ? args : {}) ?? { subject: "" };
      const result = results[c.id];
      if (isDict(result) && isDict(result.error) && result.error.code === "approval_required" && isDict(result.data) && typeof result.data.subject === "string") {
        info.subject = result.data.subject;
        if (typeof result.data.kind === "string") info.kind = result.data.kind;
      }
      const data = isDict(result) && isDict(result.data) ? result.data : {}, remember = isDict(data.remember) ? data.remember : {};
      const projectRules = data.reason === "approval_required" && Array.isArray(remember.exact) ? remember.exact.filter((v): v is string => typeof v === "string") : [];
      calls.set(c.id, { ...(projectRules.length ? { projectRules } : {}), tool_call_id: c.id, name, subject: info.subject, preview: info.preview ?? "", ...(info.kind && !["read", "list", "glob", "grep"].includes(name) ? { kind: info.kind } : {}),
        // The call waits in process: an answer continues the same turn (no rerun).
        ...(isDict(result) && isDict(result.data) && result.data.waiting === true && session.status === "running" ? { waiting: true } : {}),
        // alwaysAsk / ask rules / remote exec: "allow for this session" does not apply.
        ...(isDict(result) && isDict(result.data) && ONE_SHOT.has(String(result.data.reason)) ? { oneShot: true } : {}) });
    }
  }
  const succeeded = new Map<string, number>(), rows = [...calls.values()];
  for (const [i, info] of rows.entries()) { const r = results[String(info.tool_call_id)]; if (isDict(r) && r.ok) succeeded.set(pyJsonDumps([info.name, info.subject]), i); }
  return rows.filter((info, i) => {
    const result = results[String(info.tool_call_id)];
    if (!isDict(result)) return false;
    const tsError = isDict(result.error) ? result.error : null;
    return (result.error === "denied" && (result.error_code == null || result.error_code === "approval_required") || tsError?.code === "approval_required") && (succeeded.get(pyJsonDumps([info.name, info.subject])) ?? -1) < i;
  });
}
function publicRuntimeBudget(value: unknown): Dict | null {
  if (!isDict(value)) return null;
  const result: Dict = {};
  for (const key of ["contextWindow", "reservedOutputTokens", "safetyReserveTokens", "inputBudgetTokens", "estimatedInputTokens", "previousEstimatedTokens", "baseEstimatedInputTokens", "checkpointChars", "omittedMessages", "activeTools"]) if (isPyIntValue(value[key]) && Number(value[key]) >= 0 && Number(value[key]) <= 100000000) result[key] = value[key];
  if (value.profile === "lightweight") result.profile = "lightweight";
  if (value.estimateMethod === "utf8-bytes/2") result.estimateMethod = value.estimateMethod;
  const factor = numericValue(value.calibrationFactor);
  if (factor !== null && typeof value.calibrationFactor !== "boolean" && factor >= 1 && factor <= 8) result.calibrationFactor = value.calibrationFactor;
  if (typeof value.overflowRetry === "boolean") result.overflowRetry = value.overflowRetry;
  return result;
}
export function publicRuntimeActivity(raw: unknown): Dict | null {
  const phases = ["waiting_model", "queued_model", "retrying", "generating", "thinking", "tools", "repairing", "completed", "needs_review", "paused", "stopped", "stalled", "awaiting_user", "provider_error", "interrupted"];
  if (!isDict(raw) || !phases.includes(String(raw.phase))) return null;
  const result: Dict = { phase: raw.phase };
  if (typeof raw.finishReason === "string" && FINISH_REASONS.has(raw.finishReason)) result.finishReason = raw.finishReason;
  if (["output_limit", "context_limit", "generation_limit", "provider_filtered", "provider_paused", "unknown_termination"].includes(String(raw.terminationReason))) result.terminationReason = raw.terminationReason;
  for (const key of ["requestStep", "outputChars", "reasoningChars", "reportedOutputTokens", "reportedInputTokens", "reportedCachedTokens", "reportedReasoningTokens", "retryCount"]) if (isPyIntValue(raw[key]) && Number(raw[key]) >= 0 && Number(raw[key]) <= 1e9) result[key] = raw[key];
  for (const key of ["firstOutputSeconds", "firstReasoningSeconds", "requestSeconds", "charactersPerSecond", "tokensPerSecond", "waitingSeconds", "thinkingSeconds", "generatingSeconds", "toolSeconds", "queuedMs"]) { const n = numericValue(raw[key]); if (n !== null && typeof raw[key] !== "boolean" && Number.isFinite(n) && n >= 0 && n <= 1e9) result[key] = raw[key]; }
  for (const key of ["requestId", "attemptId"]) if (typeof raw[key] === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(raw[key])) result[key] = raw[key];
  for (const key of ["attempt", "maxAttempts"]) if (isPyIntValue(raw[key]) && Number(raw[key]) >= (key === "attempt" ? 1 : 0) && Number(raw[key]) <= 1e9) result[key] = raw[key];
  const modelRequestDurationMs = numericValue(raw.modelRequestDurationMs);
  if (modelRequestDurationMs !== null && typeof raw.modelRequestDurationMs !== "boolean" && Number.isFinite(modelRequestDurationMs) && modelRequestDurationMs >= 0 && modelRequestDurationMs <= 1e9) result.modelRequestDurationMs = raw.modelRequestDurationMs;
  if (typeof raw.startedAt === "string" && pyLen(raw.startedAt) <= 40 && Number.isFinite(Date.parse(raw.startedAt))) result.startedAt = raw.startedAt;
  const retry = publicModelRetry(raw.retry); if (retry) result.retry = retry;
  return result;
}
/** Local allowlist keeps session projection independent from the providers plugin. */
function publicModelFailure(raw: unknown): Dict | null {
  if (!isDict(raw)) return null;
  const reasons = ["auth_failed", "rate_limited", "provider_overloaded", "server_error", "timeout", "stream_idle_timeout", "network_error", "proxy_error", "tls_error", "context_exceeded", "invalid_request", "provider_not_configured", "unknown"];
  if (!reasons.includes(String(raw.reason))) return null;
  const result: Dict = { reason: raw.reason };
  for (const key of ["requestId", "attemptId"]) if (typeof raw[key] === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(raw[key])) result[key] = raw[key];
  for (const key of ["attempt", "maxAttempts"]) if (isPyIntValue(raw[key]) && Number(raw[key]) >= (key === "attempt" ? 1 : 0) && Number(raw[key]) <= 1e9) result[key] = raw[key];
  if (typeof raw.timestamp === "string" && pyLen(raw.timestamp) <= 40 && Number.isFinite(Date.parse(raw.timestamp))) result.timestamp = raw.timestamp;
  const duration = numericValue(raw.durationMs);
  if (duration !== null && typeof raw.durationMs !== "boolean" && Number.isFinite(duration) && duration >= 0 && duration <= 1e9) result.durationMs = raw.durationMs;
  if (typeof raw.modelId === "string" && pyLen(raw.modelId) <= 160 && !/[\u0000-\u001f\u007f]/.test(raw.modelId)) result.modelId = raw.modelId;
  if (typeof raw.providerKind === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(raw.providerKind)) result.providerKind = raw.providerKind;
  if (typeof raw.errorCode === "string" && /^[a-z_]{1,40}$/.test(raw.errorCode)) result.errorCode = raw.errorCode;
  if (typeof raw.retryable === "boolean") result.retryable = raw.retryable;
  if (["connect", "read", "parse", "deadline", "response"].includes(String(raw.phase))) result.phase = raw.phase;
  if (isPyIntValue(raw.statusCode) && Number(raw.statusCode) >= 100 && Number(raw.statusCode) <= 599) result.statusCode = raw.statusCode;
  if (typeof raw.providerErrorCode === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(raw.providerErrorCode)) result.providerErrorCode = raw.providerErrorCode;
  if (typeof raw.finishReason === "string" && FINISH_REASONS.has(raw.finishReason)) result.finishReason = raw.finishReason;
  if (raw.terminal === true) result.terminal = true;
  for (const key of ["messageZh", "message"]) if (typeof raw[key] === "string" && pyLen(raw[key]) <= 400 && !/[\u0000-\u001f\u007f]/.test(raw[key])) result[key] = raw[key];
  return result;
}
const RETRY_REASONS = new Set(["rate_limited", "provider_overloaded", "server_error", "network_error", "timeout", "stream_idle_timeout", "stale_connection", "auth_refresh", "reasoning_signature_repair", "offpeak_queued"]);
/** ZCode `model_retry_scheduled` facts recorded on the request activity (providers `activity.ts`). */
function publicModelRetry(raw: unknown): Dict | null {
  if (!isDict(raw) || !RETRY_REASONS.has(String(raw.reason))) return null;
  const result: Dict = { reason: raw.reason };
  for (const key of ["attempt", "maxAttempts", "delayMs"]) if (isPyIntValue(raw[key]) && Number(raw[key]) >= 0 && Number(raw[key]) <= 1e9) result[key] = raw[key];
  if (typeof raw.errorCode === "string" && /^[a-z_]{1,40}$/.test(raw.errorCode)) result.errorCode = raw.errorCode;
  if (isPyIntValue(raw.statusCode) && Number(raw.statusCode) >= 100 && Number(raw.statusCode) <= 599) result.statusCode = raw.statusCode;
  if (typeof raw.retryAt === "string" && pyLen(raw.retryAt) <= 40 && Number.isFinite(Date.parse(raw.retryAt))) result.retryAt = raw.retryAt;
  return result;
}
export function publicForkParent(session: Session): Dict | null {
  const p = session.fork_parent;
  if (!isDict(p) || typeof p.sourceId !== "string" || !/^[0-9a-f]{32}$/.test(p.sourceId) || typeof p.sourceRevision !== "string" || !/^sha256:[0-9a-f]{64}$/.test(p.sourceRevision) || !isPyIntValue(p.turn) || Number(p.turn) < 1 || !isPyIntValue(p.endIndex) || Number(p.endIndex) < 0 || typeof p.historyTruncated !== "boolean" || !(p.truncationReason == null || typeof p.truncationReason === "string" && pyLen(p.truncationReason) <= 500)) return null;
  const result: Dict = Object.fromEntries(["sourceId", "sourceRevision", "turn", "endIndex", "historyTruncated", "truncationReason"].map((k) => [k, p[k] ?? null]));
  if (typeof p.checkpointId === "string" && /^[0-9a-f]{32}$/.test(p.checkpointId) && isPyIntValue(p.checkpointTurn) && Number(p.checkpointTurn) >= 1) { result.checkpointId = p.checkpointId; result.checkpointTurn = p.checkpointTurn; }
  return result;
}
export async function publicSessionPayload(s: Session, options: PublicSessionOptions): Promise<Dict> {
  const buckets = options.approvals.get(String(s.id)), approved: Dict = {};
  for (const kind of ["write", "edit", "exec", "mcp"]) approved[kind] = [...(buckets?.get(kind)?.values() ?? [])].sort();
  const pending: Dict[] = pendingDenials(s, options).map((p) => ({ ...p, granted: buckets?.get(String(p.kind || p.name))?.get(String(p.tool_call_id)) === p.subject }));
  const compacting = ['started', 'retrying'].includes(String((Array.isArray(s.compact_timeline) ? s.compact_timeline.filter(isDict) : []).at(-1)?.status));
  const result: Dict = { id: s.id, task: s.task, title: s.title || s.task, root: s.root, status: s.status ?? null, steps: s.steps ?? 0, active_turn_id: s.active_turn_id ?? null, work_segments: publicSegments(s), tool_activity: [], history_revision: s.history_revision ?? 0, history_hash: s.history_hash ?? null, current_queue_item_id: s.current_queue_item_id ?? null, mode: s.mode ?? "build", mode_history: s.mode_history ?? [], permission_mode: s.permission_mode ?? "build", permission_mode_history: s.permission_mode_history ?? [], model_selection: {}, model_history: s.model_history ?? [], runtime_profile: s.runtime_profile ?? null, runtime_budget: publicRuntimeBudget(s.runtime_budget), runtime_activity: publicRuntimeActivity(s.runtime_activity), runtime_activity_history: Array.isArray(s.runtime_activity_history) ? s.runtime_activity_history.slice(-24).map(publicRuntimeActivity).filter((v) => v !== null) : [], model_failure: publicModelFailure(s.model_failure), protocol_diagnostics: publicDiagnostics(s.protocol_diagnostics), pause_reason: s.pause_reason ?? null, pause_code: s.pause_code ?? null, remote_connection: null, browser_enabled: s.browser_enabled ?? null, compactions: s.compactions ?? [], streaming: s.streaming ?? null, reasoning_history: [], reasoning_timing: [], provider_usage: s.provider_usage ?? [], completion: s.completion ?? null, todos: s.todos ?? [], delivery_requirements: s.delivery_requirements ?? [], goal: options.enabled("planning") ? options.goalView?.(s) ?? null : null, tool_timings: Array.isArray(s.tool_timings) ? s.tool_timings.slice(-200) : [], pending_question: s.pending_question ?? null, pending, approved, changed_files: [], forkParent: publicForkParent(s) };
  result.compacting = compacting;
  if (options.running && !options.running.has(String(s.id)) && pending.some(p => p.waiting)) {
    for (const item of pending) delete item.waiting;
    result.status = "paused"; result.pause_code = "approval_required"; result.pause_reason = "运行已中断，待审批操作已保留；确认后继续。";
  }
  if (isDict(s.model_selection)) { const selection: Dict = {}; for (const key of ["provider_id", "model", "reasoning_effort"]) if (Object.hasOwn(s.model_selection, key) && (typeof s.model_selection[key] === "string" || s.model_selection[key] === null)) selection[key] = s.model_selection[key]; if (["native", "json"].includes(String(s.tool_calling))) selection.tool_calling = s.tool_calling; result.model_selection = selection; }
  if (isDict(s.remote_connection) && typeof s.remote_connection.id === "string" && typeof s.remote_connection.digest === "string" && s.remote_connection.digest.length === 64) result.remote_connection = { id: s.remote_connection.id, digest: s.remote_connection.digest };
  const messages = Array.isArray(s.messages) ? s.messages : [];
  result.tool_activity = publicToolActivity(s, options);
  result.runtime_turn = options.enabled('sessions') ? publicTurnState(s.runtime_turn) : null;
  result.runtime_turn_history = options.enabled('sessions') && Array.isArray(s.runtime_turn_history) ? s.runtime_turn_history.slice(-24).map(publicTurnState).filter(Boolean) : [];
  result.background_tasks = options.enabled('shell') ? publicBackgroundTasks(s.background_tasks) : [];
  const current = options.activeContext?.get(String(s.id)), live = current?.active_session, command = current?.run_command_id;
  if (options.running?.has(String(s.id)) && s.status === "running" && typeof s.active_turn_id === "string" && s.active_turn_id && pyLen(s.active_turn_id) <= 128 && isDict(live) && live.id === s.id && live.status === "running" && live.active_turn_id === s.active_turn_id && typeof command === "string" && /^c_[0-9]{13}_([0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.test(command)) result.active_run_command_id = command;
  const validIndex = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v < messages.length && isDict(messages[v]) && messages[v].role === "assistant";
  result.reasoning_history = Array.isArray(s.reasoning_history) ? s.reasoning_history.slice(-20).filter((r) => isDict(r) && validIndex(r.message_index) && typeof r.text === "string" && r.text).map((r) => ({ message_index: r.message_index, text: pySlice(r.text, 32000) })) : [];
  result.reasoning_timing = Array.isArray(s.reasoning_timing) ? s.reasoning_timing.slice(-20).filter((r) => isDict(r) && validIndex(r.message_index) && [r.started_at, r.ended_at].every((v) => typeof v === "string" && v && pyLen(v) <= 40)).map((r) => ({ message_index: r.message_index, started_at: r.started_at, ended_at: r.ended_at })) : [];
  result.timeline_markers = timelineMarkers(s, result.forkParent as Dict | null);
  const paths: string[] = [], results = isDict(s.results) ? s.results : {};
  for (const m of messages.filter(isDict)) for (const c of (Array.isArray(m.tool_calls) ? m.tool_calls : []).filter(isDict)) { const f = isDict(c.function) ? c.function : {}, r = results[String(c.id)]; if (!isDict(r) || !r.ok) continue; try { const args = pyJsonLoads(String(f.arguments ?? "{}")); const info = isDict(args) ? (options.toolInfo ?? defaultToolInfo)(String(f.name), args) : null; if (info && ["write", "edit"].includes(info.kind ?? "") && info.subject && !paths.includes(info.subject)) paths.push(info.subject); } catch { /* Invalid historical calls have no path. */ } }
  result.changed_files = paths.slice(0, 200);
  try { Object.assign(result, await options.queueSnapshot?.(String(s.id)) ?? { queue_revision: 0, queued_messages: [], queue_history: [] }); } catch { Object.assign(result, { queued_messages: [], queue_history: [], queue_error: "cannot read message queue" }); }
  try { Object.assign(result, await options.guidanceSnapshot?.(s) ?? { pending_guidance: [], guidance_history: [] }); } catch { Object.assign(result, { pending_guidance: [], guidance_history: [], guidance_error: "cannot read current-turn input" }); }
  return result;
}
