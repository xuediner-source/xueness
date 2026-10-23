/** Measured request activity; estimates and provider-reported counters stay distinct. */
import { isDict, pyLen, pyRound, pySlice } from "@xueness/contracts";
import type { AgentExtension, Row } from "@xueness/agent";
import { finishReason, incompleteReason, tokenCount } from "@xueness/providers";
import { modelFailureMessage, recordModelFailure } from "./model-status.ts";
export const ACTIVITY_PHASES = new Set(["waiting_model", "queued_model", "retrying", "generating", "thinking", "tools", "repairing", "completed", "needs_review", "paused", "stopped", "stalled", "awaiting_user", "provider_error", "interrupted"]);
export class RequestActivity {
  readonly session: Row;
  readonly record: Row;
  readonly #now: () => number;
  readonly #started: number;
  #lastDelta: number;
  constructor(session: Row, now = () => performance.now() / 1000, stamp = () => new Date().toISOString().replace(/Z$/, "+00:00")) {
    this.session = session; this.#now = now; this.#started = now(); this.#lastDelta = this.#started;
    this.record = { phase: "waiting_model", startedAt: stamp(), requestStep: Number(session.steps ?? 0) + 1, outputChars: 0 };
    session.runtime_activity = this.record;
  }
  phase(value: string): void { if (ACTIVITY_PHASES.has(value)) this.record.phase = value; }
  #requestInfo(info: Row): void {
    for (const key of ["requestId", "attemptId"]) if (typeof info[key] === "string" && info[key]) this.record[key] = info[key];
    for (const key of ["attempt", "maxAttempts"]) { const value = info[key]; if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 1e9) this.record[key] = value; }
  }
  start(info: Row): void {
    const now = this.#now(); this.#tick(now); this.#lastDelta = now;
    this.phase("waiting_model"); delete this.record.retry; delete this.record.modelRequestDurationMs; delete this.record.finishReason;
    delete this.record.queuedMs;
    if (typeof info.queuedMs === "number" && Number.isFinite(info.queuedMs) && info.queuedMs >= 0) this.record.queuedMs = info.queuedMs;
    this.#requestInfo(info);
  }
  requestFinished(info: Row): void {
    this.#requestInfo(info);
    if (typeof info.durationMs === "number" && Number.isFinite(info.durationMs) && info.durationMs >= 0 && info.durationMs <= 1e9) this.record.modelRequestDurationMs = info.durationMs;
    if (typeof info.finishReason === "string" && info.finishReason) this.record.finishReason = info.finishReason;
  }
  /** ZCode `model_retry_scheduled`: the retried request keeps its activity record. */
  retry(info: Row, nowMs = Date.now()): void {
    const delayMs = Number(info.delayMs);
    this.#tick(this.#now()); this.#lastDelta = this.#now(); this.phase("retrying");
    this.record.retry = { attempt: info.nextAttempt, maxAttempts: info.maxAttempts, delayMs, reason: info.reason, errorCode: info.errorCode,
      ...typeof info.statusCode === "number" ? { statusCode: info.statusCode } : {}, retryAt: new Date(nowMs + delayMs).toISOString().replace(/Z$/, "+00:00") };
  }
  #tick(now: number): void {
    const key = ({ waiting_model: "waitingSeconds", thinking: "thinkingSeconds", generating: "generatingSeconds" } as Record<string, string>)[String(this.record.phase)];
    if (key) this.record[key] = pyRound(Number(this.record[key] ?? 0) + Math.max(0, now - this.#lastDelta), 4);
  }
  delta(text: string, reasoning = false): void {
    const now = this.#now(); const elapsed = Math.max(0, now - this.#started);
    this.#tick(now); this.#lastDelta = now; this.phase(reasoning ? "thinking" : "generating");
    const countKey = reasoning ? "reasoningChars" : "outputChars"; const firstKey = reasoning ? "firstReasoningSeconds" : "firstOutputSeconds";
    this.record[countKey] = Math.min(1e9, Number(this.record[countKey] ?? 0) + pyLen(text));
    if (!Object.hasOwn(this.record, firstKey)) this.record[firstKey] = pyRound(elapsed, 4);
    this.record.requestSeconds = pyRound(elapsed, 4);
    if (!reasoning && elapsed > 0) this.record.charactersPerSecond = pyRound(Number(this.record.outputChars) / elapsed, 3);
  }
  complete(response: Row, usage: unknown, attempts?: unknown, finish?: string | null, termination?: string | null): void {
    const now = this.#now(); const elapsed = Math.max(0, now - this.#started);
    this.#tick(now); this.record.requestSeconds = pyRound(elapsed, 4);
    if (finish !== undefined && finish !== null) this.record.finishReason = finish;
    if (termination !== undefined && termination !== null) this.record.terminationReason = termination;
    if (!this.record.outputChars && typeof response.content === "string") this.record.outputChars = Math.min(1e9, pyLen(response.content));
    if (elapsed > 0 && this.record.outputChars) this.record.charactersPerSecond = pyRound(Number(this.record.outputChars) / elapsed, 3);
    if (isDict(usage)) {
      const inputs = usage.prompt_tokens ?? usage.input_tokens;
      const details = isDict(usage.prompt_tokens_details) ? usage.prompt_tokens_details : {};
      const cached = usage.cache_read_input_tokens ?? usage.cached_tokens ?? details.cached_tokens;
      if (tokenCount(inputs)) this.record.reportedInputTokens = inputs;
      if (tokenCount(cached)) this.record.reportedCachedTokens = cached;
      const tokens = usage.output_tokens ?? usage.completion_tokens;
      if (tokenCount(tokens)) { this.record.reportedOutputTokens = tokens; if (elapsed > 0) this.record.tokensPerSecond = pyRound(tokens / elapsed, 3); }
      const outputDetails = isDict(usage.completion_tokens_details) ? usage.completion_tokens_details : {};
      const thinking = usage.reasoning_tokens ?? outputDetails.reasoning_tokens;
      if (tokenCount(thinking)) this.record.reportedReasoningTokens = thinking;
    }
    if (typeof attempts === "number" && Number.isInteger(attempts) && attempts >= 1 && attempts <= 100) this.record.retryCount = attempts - 1;
    this.record.toolSeconds = 0; this.phase(Array.isArray(response.tool_calls) && response.tool_calls.length ? "tools" : "generating");
    if (!Array.isArray(this.session.runtime_activity_history)) this.session.runtime_activity_history = [];
    const history = this.session.runtime_activity_history as Row[]; history.push({ ...this.record }); history.splice(0, Math.max(0, history.length - 24));
  }
  tool(name: string, callId: string, seconds: number, ok: boolean): void {
    this.record.toolSeconds = pyRound(Number(this.record.toolSeconds ?? 0) + seconds, 4);
    const history = this.session.runtime_activity_history;
    if (Array.isArray(history) && isDict(history.at(-1)) && history.at(-1).startedAt === this.record.startedAt) history.at(-1).toolSeconds = this.record.toolSeconds;
    if (!Array.isArray(this.session.tool_timings)) this.session.tool_timings = [];
    const tools = this.session.tool_timings as Row[];
    tools.push({ step: this.record.requestStep, name: pySlice(name, 100), tool_call_id: pySlice(callId, 200), seconds: pyRound(seconds, 4), ok });
    tools.splice(0, Math.max(0, tools.length - 200));
  }
}
export function settleActivity(session: Row): void { if (isDict(session.runtime_activity) && ACTIVITY_PHASES.has(String(session.status))) session.runtime_activity.phase = session.status; }
export function providerActivityExtension(): AgentExtension {
  const activities = new WeakMap<Row, RequestActivity>();
  return { id: "providers", capabilities: ["providers.activity"],
    async prepareRequest(context, request) { activities.set(context.session, new RequestActivity(context.session)); await context.save(); return request; },
    observeDelta(context, text, reasoning) { activities.get(context.session)?.delta(text, reasoning); },
    async modelRequestStarted(context, info) {
      if (info.attempt === 1) delete context.session.model_failure;
      activities.get(context.session)?.start(info);
      await context.save();
    },
    async modelRequestQueued(context, info) {
      if (info.attempt === 1) delete context.session.model_failure;
      const activity = activities.get(context.session); activity?.start(info); activity?.phase("queued_model");
      info.messageZh = "等待模型并发名额…"; info.message = "Waiting for model capacity…";
      await context.save();
    },
    async modelRequestAdmitted(context, info) {
      const activity = activities.get(context.session); activity?.start(info);
      if (activity && typeof info.queuedMs === "number") activity.record.queuedMs = info.queuedMs;
      await context.save();
    },
    modelRequestCompleted(context, info) {
      delete context.session.model_failure;
      activities.get(context.session)?.requestFinished(info);
    },
    async modelRequestFailed(context, info) {
      if (info.terminal === true && info.reason !== "cancelled") {
        info.messageZh = modelFailureMessage(info, "zh");
        info.message = modelFailureMessage(info, "en");
      }
      recordModelFailure(context.session, info);
      activities.get(context.session)?.requestFinished(info);
      if (info.terminal === true) await context.save();
    },
    async modelRetryScheduled(context, info) { const activity = activities.get(context.session); if (activity) { activity.retry(info); await context.save(); } },
    afterModelResponse(context, response) {
      const finish = finishReason(response._finish_reason);
      activities.get(context.session)?.complete(response, response._usage, response._request_attempts, finish, incompleteReason(finish, response._usage, context.provider));
      if (response._protocol_error) activities.get(context.session)?.phase("repairing");
      return response;
    },
    toolFinished(context, call, result, seconds) { activities.get(context.session)?.tool(call.name, call.id, seconds, !!result.ok); },
    async settleRun(context) { settleActivity(context.session); await context.save(); }, close(context) { activities.delete(context.session); },
  };
}
