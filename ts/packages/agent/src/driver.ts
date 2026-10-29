import { isDict, pyJsonDumps, PyValueError } from "@xueness/contracts";
import { finishReason, incompleteReason, isStreamStop, PAUSE_MESSAGES, ProviderCallbackError, ProviderRequestError, recordFailure } from "@xueness/providers";
import { AcceptedCallLedger, settleStreamToolCalls } from "./accepted-call-ledger.ts";
import { compact } from "./compaction.ts";
import { currentTurnToolIds, recordCompletionHistory, toolExecutionStatus, turnId } from "./completion.ts";
import { assessFinal, effectiveExtensions, finalize } from "./finalize.ts";
import { isOutputTokenLimit, lastUserMessageId, MAX_OUTPUT_TOKEN_CONTINUATIONS, repeatedToolCallReminders, withContinuationPrompts, type RepeatedCallState } from "./loop-guards.ts";
import { validateMessage } from "./messages.ts";
import { performModelRequest } from "./model-request.ts";
import { applyExecutionSelectionFallback } from "./execution-selection.ts";
import { RequestStream } from "./stream.ts";
import { retainReasoningMetadata } from "@xueness/providers";
import { runTools } from "./tools.ts";
import { internalToolName } from "./tool-contract/names.ts";
import type { AgentContext, AgentRunnerOptions, ModelRequest, Row } from "./types.ts";

/** Shared mechanics only; product behavior enters through effective plugin hooks. */
export async function driveRun(context: AgentContext, runner: AgentRunnerOptions, now: () => number): Promise<void> {
  const session = context.session;
  const options = context.options;
  const extensions = runner.hooks.extensions ?? [];
  // ZCode turn loop: no default step or wall-time cap. A turn ends when the
  // model stops calling tools, the user stops it, or a caller-supplied bound.
  const maxSteps = options.maxSteps ?? Infinity;
  const maxChars = options.maxChars ?? 24000;
  if (options.maxSteps !== undefined && (!Number.isInteger(maxSteps) || maxSteps < 1)) throw new PyValueError("max_steps must be a positive integer");
  if (session.status === "completed" || session.status === "awaiting_user" && session.pending_question) return;
  const stopped = (): boolean => context.signal.aborted || !!options.shouldStop?.();
  const expired = (): boolean => now() >= context.deadline;
  const settle = async (status: string, reason?: string, code?: string): Promise<void> => {
    session.status = status;
    if (reason) session.pause_reason = reason; else delete session.pause_reason;
    if (code) session.pause_code = code; else delete session.pause_code;
    await context.save(); context.emit({ type: "status", status, steps: session.steps, ...(reason ? { reason } : {}), ...(code ? { pause_code: code } : {}) });
  };
  const wallLimit = (): Promise<void> => settle("paused", `本轮达到${options.maxWallSeconds ? ` ${options.maxWallSeconds} 秒` : "运行"}时限，任务尚未完成；继续当前任务可接着处理。`, "wall_time_limit_reached");
  session.runtime_profile = context.provider.runtimeProfile ?? "standard";
  session.tool_calling = context.provider.toolCalling ?? "native";
  if (!isDict(session.results)) session.results = {};
  if (!Array.isArray(session.todos)) session.todos = [];
  session.pending_question ??= null;
  session.status = "running"; delete session.pause_reason; delete session.pause_code;
  session.active_turn_id = turnId(session);
  session.mode = session.mode ?? (runner.toolBridge.permissions?.mode === "plan" ? "plan" : "build");
  if (!Array.isArray(session.mode_history)) session.mode_history = [];
  const modes = session.mode_history as Row[];
  if (modes.at(-1)?.mode !== session.mode) modes.push({ mode: session.mode, steps: session.steps ?? 0 });
  for (const extension of effectiveExtensions(context, extensions)) await extension.runStarted?.(context);
  await context.save();
  let protocolRepairs = 0;
  const repeated: RepeatedCallState = { streak: 0, warnings: 0 };
  // C-MDL-03: one accepted-call ledger per run — accepted stream tool calls settle
  // exactly once across interrupt, execution-selection switch, cancel and resume.
  const ledger = new AcceptedCallLedger();
  const settleDyingStream = (stream: RequestStream | null, cause: "model_interrupt" | "execution_fallback" | "cancelled"): void => {
    if (!stream) return;
    settleStreamToolCalls({
      streamId: typeof stream.record.id === "string" ? stream.record.id : null,
      turnId: String(session.active_turn_id ?? turnId(session)),
      committed: stream.committed,
      acceptedCalls: stream.acceptedToolCalls(),
      preludeFragments: stream.discardedPreludeFragments(),
      cause, ledger, session,
    });
  };
  let human = lastUserMessageId(session.messages as Row[]);
  const continued = new Set<string>();
  let continuations = 0;
  // ZCode-style completion: a turn ends when the model stops calling tools.
  // Evidence references are optional host metadata; an invalid or missing
  // citation never adds a repair round, blocks tools or pauses the session.
  // Older sessions may still carry a pending repair from before this change.
  delete session.completion_reference_repair; delete session.completion_reference_repairs;
  let repair: string | null = null;
  for (let step = 0; step < maxSteps; step += 1) {
    if (stopped()) { await settle("stopped"); return; }
    if (expired()) { await wallLimit(); return; }
    if (!context.enabled("providers")) { await settle("paused", "providers plugin disabled"); return; }
    let stream: RequestStream | null = null;
    let response: Row;
    let request: ModelRequest;
    let finish: string | null = null;
    let incomplete: string | null = null;
    let outputLimited = false;
    let protocolError: unknown;
    let diagnostic: unknown;
    let hostCalls: Row[] = [];
    try {
      for (const extension of effectiveExtensions(context, extensions)) await extension.beforeModelRequest?.(context);
      const guidance: string[] = [];
      for (const extension of effectiveExtensions(context, extensions)) if (extension.completionInstructions) guidance.push(...await extension.completionInstructions(context));
      const active = effectiveExtensions(context, extensions);
      const owned = active.some((extension) => extension.ownsCompaction?.(context) === true);
      if (!owned && !active.some((extension) => typeof extension.preserveJournal === "function" ? extension.preserveJournal(context) : extension.preserveJournal)) compact(session, Math.max(256, maxChars - (guidance.length ? Array.from(pyJsonDumps(guidance)).length : 0)), options.maxTokens);
      await context.save();
      try { options.onStep?.(Number(session.steps ?? 0)); } catch { /* observational progress */ }
      const latestHuman = lastUserMessageId(session.messages as Row[]);
      if (latestHuman !== human) { human = latestHuman; repeated.signature = undefined; repeated.streak = 0; }
      const rebuild = async (journal: Row[]): Promise<ModelRequest> => {
        let messages = withContinuationPrompts(journal, continued);
        if (guidance.length || repair) messages = [{ ...messages[0], content: String(messages[0]?.content ?? "") + "\n" + [...guidance, ...(repair ? [repair] : [])].join("\n") }, ...messages.slice(1)];
        const tools = (await runner.hooks.tools(context)).filter((schema) => {
          const name = isDict(schema.function) ? schema.function.name : null;
          if (typeof name !== "string") return false;
          const owner = runner.hooks.toolOwner(name);
          return owner !== null && context.enabled(owner);
        });
        let built: ModelRequest = { messages, tools: [...tools], options: {}, hostInstructions: guidance, repair };
        for (const extension of effectiveExtensions(context, extensions)) if (extension.prepareRequest) built = await extension.prepareRequest(context, built);
        // Re-filter after plugin prompt preparation: no adapter can resurrect a disabled tool.
        built.tools = built.tools.filter((schema) => {
          // A model-visible ZCode name stands for its Xueness tool (tool-contract/names.ts).
          const owner = isDict(schema.function) && typeof schema.function.name === "string" ? runner.hooks.toolOwner(internalToolName(schema.function.name)) : null;
          return owner !== null && context.enabled(owner);
        });
        return built;
      };
      request = await rebuild(session.messages as Row[]);
      // ZCode auto compaction runs on the prepared request (compact/policy.ts); a compacted journal is rebuilt.
      for (const extension of effectiveExtensions(context, extensions)) {
        if (await extension.compactBeforeRequest?.(context, request, rebuild)) { request = await rebuild(session.messages as Row[]); break; }
      }
      if (!context.enabled("providers")) { await settle("paused", "providers plugin disabled"); return; }
      ({ response, stream, request } = await performModelRequest(context, runner, request, rebuild, now, stopped));
      const modelCallIds = new Set((Array.isArray(response.tool_calls) ? response.tool_calls : []).filter(isDict).map(call => call.id));
      for (const extension of effectiveExtensions(context, extensions)) if (extension.afterModelResponse) response = await extension.afterModelResponse(context, response);
      hostCalls = (Array.isArray(response.tool_calls) ? response.tool_calls : []).filter(isDict).filter(call => !modelCallIds.has(call.id));
      response = { ...response };
      protocolError = response._protocol_error; diagnostic = response._protocol_diagnostic;
      delete response._protocol_error; delete response._protocol_diagnostic;
      const usage = response._usage; const cost = response._cost;
      const rawFinish = response._finish_reason;
      finish = finishReason(rawFinish); incomplete = incompleteReason(finish, usage, context.provider);
      outputLimited = incomplete !== null && isOutputTokenLimit(finish, rawFinish);
      // ZCode: a cut response that still carries tool calls proceeds; each call's own argument check applies.
      if (outputLimited && !protocolError && Array.isArray(response.tool_calls) && response.tool_calls.length) incomplete = null;
      for (const key of ["_usage", "_cost", "_finish_reason", "_request_attempts"]) delete response[key];
      const bounded = (value: unknown): unknown => { try { return isDict(value) && Array.from(pyJsonDumps(value)).length <= 4000 ? value : null; } catch { return null; } };
      const safeUsage = bounded(usage); const safeCost = bounded(cost);
      if (safeUsage || safeCost) {
        const record: Row = { step: Number(session.steps ?? 0) + 1, at: new Date().toISOString().replace(/Z$/, "+00:00") };
        if (context.provider.model?.trim()) record.model = context.provider.model.trim().slice(0, 160);
        if (context.provider.protocol === "openai" || context.provider.protocol === "anthropic") record.protocol = context.provider.protocol;
        if (safeUsage) record.usage = safeUsage; if (safeCost) record.cost = safeCost;
        if (!Array.isArray(session.provider_usage)) session.provider_usage = [];
        const history = session.provider_usage as Row[]; history.push(record); history.splice(0, Math.max(0, history.length - 100)); await context.save();
      }
      if (incomplete) response = { content: typeof response.content === "string" ? response.content : "" };
      else if (protocolError) response = { content: "" };
      try { validateMessage(response, Object.keys(session.results as Row)); }
      catch { throw new ProviderRequestError({ category: "invalid_response", stage: "parse", exceptionType: "ValueError" }); }
    } catch (error) {
      // Execution-selection fallback precedes generic failure handling: with a declared
      // fallback the temporary model gets one physical attempt, settles whatever its
      // stream already accepted, and the turn continues on the original/session model
      // instead of retrying the failed endpoint. A matched failure with no target keeps
      // the original error and terminates below.
      const executionFallback = await applyExecutionSelectionFallback(context, error, {
        stream, stopped: stopped(),
        ledger: { ledger, session, turnId: String(session.active_turn_id ?? turnId(session)) },
      });
      if (executionFallback.applied) { step -= 1; continue; }
      if (!executionFallback.matched && stream) { settleDyingStream(stream, stopped() ? "cancelled" : "model_interrupt"); await stream.interrupt(); }
      if (stopped()) { await settle("stopped"); return; }
      if (!context.enabled("providers")) { await settle("paused", "providers plugin disabled"); return; }
      if (isStreamStop(error) && !expired()) { await settle("stopped"); return; }
      if (expired()) { await wallLimit(); return; }
      if (error instanceof Error && error.name === "ContextBudgetError") { await settle("paused", error.message); return; }
      if (error instanceof Error && error.name === "CompactionError") { await settle("paused", error.message, String((error as Error & { code?: unknown }).code ?? "compaction_failed")); return; }
      if (error instanceof ProviderRequestError) {
        const failure = isDict(session.model_failure) ? session.model_failure : {};
        await settle("provider_error", typeof failure.messageZh === "string" ? failure.messageZh : undefined, typeof failure.errorCode === "string" ? failure.errorCode : undefined);
      }
      else await settle("paused", error instanceof ProviderCallbackError ? "local stream callback failed" : "local run failed");
      throw error;
    }
    if (stopped()) { if (stream) { settleDyingStream(stream, "cancelled"); await stream.interrupt(); } await settle("stopped"); return; }
    if (expired()) { if (stream) { settleDyingStream(stream, "model_interrupt"); await stream.interrupt(); } await wallLimit(); return; }
    if (incomplete) {
      const partial = typeof response.content === "string" ? response.content : "";
      if (outputLimited && continuations < MAX_OUTPUT_TOKEN_CONTINUATIONS) {
        // ZCode output-token recovery: keep the partial, then resume with a turn-local prompt.
        continuations += 1; session.steps = Number(session.steps ?? 0) + 1;
        const journal = session.messages as Row[];
        if (partial) journal.push({ role: "assistant", content: partial });
        await context.save();
        if (stream) await stream.finish(partial ? journal.length - 1 : null, !partial);
        if (partial) context.emit({ type: "assistant", text: partial });
        const anchor = journal.at(-1)?._message_id; if (typeof anchor === "string") continued.add(anchor);
        continue;
      }
      (session.messages as Row[]).push({ role: "assistant", content: partial }); session.steps = Number(session.steps ?? 0) + 1;
      if (stream) await stream.finish((session.messages as Row[]).length - 1, true);
      const summary = PAUSE_MESSAGES[incomplete]!;
      const completion: Row = { status: "incomplete", verified: false, summary, error_code: "generation_" + incomplete, finish_reason: finish,
        evidence: [], evidence_count: 0, tool_execution_status: toolExecutionStatus(session, currentTurnToolIds(session)), tool_execution_success: false,
        delivery_status: "not_assessed", turn_id: turnId(session) };
      session.completion = completion; recordCompletionHistory(session, completion);
      context.emit({ type: "assistant", text: partial }); await settle("paused", summary); return;
    }
    continuations = 0;
    if (protocolError) {
      protocolRepairs += 1; repair = "Your previous response had an invalid tool envelope. " + String(protocolError);
      session.steps = Number(session.steps ?? 0) + 1;
      const row = recordFailure(session, isDict(diagnostic) ? diagnostic : { code: "invalid_envelope" }, { protocol: context.provider.toolCalling ?? "native", attempt: protocolRepairs, finish, turnId: turnId(session) });
      if (stream) await stream.finish(null, true);
      const repairLimit = session.runtime_profile === "lightweight" && isDict(session.lightweight_options) ? Number(session.lightweight_options.jsonRepairAttempts ?? 1) : 1;
      if (protocolRepairs > repairLimit) {
        row.outcome = "exhausted";
        const summary = "模型连续返回了无法解析的工具格式，已停止自动重试。已执行的工具结果保留，可以继续或检查模型协议。";
        session.completion = { status: "unverified", verified: false, summary, evidence: [], evidence_count: 0, error_code: "tool_protocol_error", protocol_error_code: row.code,
          tool_execution_status: toolExecutionStatus(session, currentTurnToolIds(session)), tool_execution_success: toolExecutionStatus(session, currentTurnToolIds(session)) === "succeeded", delivery_status: "not_assessed", turn_id: turnId(session) };
        recordCompletionHistory(session, session.completion as Row); await settle("needs_review", summary, "tool_protocol_error"); return;
      }
      await context.save(); continue;
    }
    if (protocolRepairs) {
      for (const row of [...session.protocol_diagnostics as Row[]].reverse()) { if (row.outcome !== "repairing") break; row.outcome = "recovered"; }
      protocolRepairs = 0;
    }
    repair = null;
    const calls = (response.tool_calls ?? []) as Row[];
    const message: Row = { role: "assistant", content: response.content || "" };
    retainReasoningMetadata(response, message);
    if (calls.length) message.tool_calls = calls;
    if (!calls.length) {
      let guidance: string | null = null;
      for (const extension of effectiveExtensions(context, extensions)) guidance ||= await extension.completionGuidance?.(context) ?? null;
      if (guidance) { repair = guidance; session.steps = Number(session.steps ?? 0) + 1; if (stream) await stream.finish(null, true); await context.save(); continue; }
    }
    const assessment = !calls.length ? assessFinal(context, message.content as string) : null;
    if (assessment) message.content = assessment.summary;
    (session.messages as Row[]).push(message); session.steps = Number(session.steps ?? 0) + 1;
    // Durable intent boundary: accepted calls enter the ledger before publication,
    // so no tool effect precedes their record and later settlement is exactly-once.
    // Without a stream (non-streaming adapter) the accepted response calls themselves.
    if (calls.length) {
      ledger.accept(typeof stream?.record.id === "string" ? stream.record.id : "", String(session.active_turn_id ?? turnId(session)),
        stream ? stream.acceptedToolCalls() : calls);
      // Trusted effective extensions can append calls after a stream completes.
      // Admit only those new IDs here; unaccepted model fragments stay excluded.
      if (stream && hostCalls.length) ledger.accept(typeof stream.record.id === "string" ? stream.record.id : "", String(session.active_turn_id ?? turnId(session)),
        hostCalls.map(call => ({ id: call.id, name: isDict(call.function) ? call.function.name : undefined })));
      ledger.project(session);
    }
    await context.save(); // No tool effect precedes publication.
    if (stream) await stream.finish((session.messages as Row[]).length - 1);
    context.emit({ type: "assistant", text: message.content || "" });
    if (!calls.length) {
      let continued = false;
      for (const extension of effectiveExtensions(context, extensions)) continued = await extension.beforeFinalResponse?.(context, response) === true || continued;
      if (continued) continue;
    } else for (const extension of effectiveExtensions(context, extensions)) await extension.toolsScheduled?.(context, calls);
    for (const call of calls) { const fn = call.function as Row; context.emit({ type: "tool_call", id: call.id, name: fn.name, subject: String(fn.arguments ?? "").slice(0, 160) }); }
    if (assessment) { await finalize(context, extensions, assessment); return; }
    const outcomes = await runTools(context, runner, calls, request.tools);
    // Accepted calls settle exactly once: executed when their result reached the
    // journal, interrupted when the run stopped or paused before execution.
    {
      const results = session.results as Row;
      for (const call of calls) {
        if (typeof call.id !== "string") continue;
        const stored = results[call.id];
        const awaiting = isDict(stored) && (stored.awaiting_approval === true
          || stored.awaiting_user === true
          || isDict(stored.data) && (stored.data.awaitingApproval === true || stored.data.awaiting_user === true)
          || isDict(stored.error) && stored.error.code === "approval_required");
        const executed = isDict(stored) && stored.ok !== false && !awaiting;
        ledger.settle(call.id, executed ? "settled_executed" : "settled_interrupted", stopped() ? "cancelled" : "completed");
      }
      ledger.project(session);
    }
    if (stopped()) { await settle("stopped"); return; }
    if (outcomes.stopTurn) {
      // ZCode turn-control: a denied plan-mode exit ends the turn instead of feeding the model.
      await settle("paused", "计划未获批准，本轮已结束；可以继续讨论或修改计划。", "plan_exit_denied"); return;
    }
    if (outcomes.halt) {
      // Fallback only: approvals wait in process. This is an approval nobody could answer
      // now (no approver, sessions off, host shutting down); a later run replays it.
      const halt = outcomes.halt;
      const error = isDict(halt.error) ? halt.error : {};
      await settle("paused", haltReason(halt, true), String(halt.error_code ?? error.code ?? "approval_required")); return;
    }
    if (outcomes.awaitingUser) { session.pending_question = outcomes.awaitingUser; await settle("awaiting_user"); return; }
    const reminders = repeatedToolCallReminders(calls, repeated);
    if (reminders.length) repair = reminders.join("\n\n");
    if (expired()) { await wallLimit(); return; }
  }
  await settle("paused", `本轮达到 ${maxSteps} 步上限，任务尚未完成；继续当前任务可接着处理。`, "step_limit_reached");
}

/** User-facing pause text for a halting tool result, by its own reason or code (`core.py` halt). */
export function haltReason(halt: Row, approval: boolean): string {
  if (typeof halt.user_reason === "string" && halt.user_reason.trim()) return halt.user_reason;
  if (approval) return "等待你批准工具调用；批准后继续。";
  const error = isDict(halt.error) ? halt.error : {};
  const code = String(halt.error_code || error.code || "");
  if (code === "permission_denied") return "当前权限策略禁止此工具；请调整权限或任务要求。";
  if (code === "plan_mode_denied" && typeof error.message === "string" && error.message.trim()) return error.message;
  return "工具调用未能完成，本轮已停止；请检查后继续当前任务。";
}
