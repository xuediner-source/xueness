import { isDict, pyJsonDumps } from "@xueness/contracts";
import { argumentsObject } from "@xueness/providers";
import { awaitingApprovalResult, turnControlOf, type ApprovalRequest, type ToolCall } from "@xueness/tool-bridge";
import { evidenceAliases } from "./completion.ts";
import { internalToolName } from "./tool-contract/names.ts";
import { effectiveExtensions } from "./finalize.ts";
import { saveToolMedia } from "./tool-media.ts";
import type { AgentContext, AgentRunnerOptions, Row } from "./types.ts";

/**
 * `halt`: a call came back approval_required (no in-process approver, or it was
 * deferred) and the run pauses for a replay. `stopTurn`: a result asked to end
 * the turn (ZCode turn-control, a denied plan-mode exit).
 */
export interface ToolStepResult { awaitingUser: string | null; halt: Row | null; stopTurn: Row | null }
/**
 * Persist intent precedes this call; every call settles to one paired result.
 * An approval waits in place (ZCode permission-flow): while it waits the
 * journal holds an approval_required placeholder and its tool message, the
 * same state a paused run leaves, so a restart can still replay it.
 */
export async function runTools(context: AgentContext, runner: AgentRunnerOptions, calls: Row[], activeTools: Row[], blockEffects = false): Promise<ToolStepResult> {
  const session = context.session;
  const results = session.results as Row;
  const extensions = runner.hooks.extensions ?? [];
  // The model sees ZCode names for the core tools; the journal holds the Xueness names.
  const active = new Set(activeTools.map((tool) => isDict(tool.function) && typeof tool.function.name === "string" ? internalToolName(tool.function.name) : null));
  let halt: Row | null = null;
  let stopTurn: Row | null = null;
  let awaitingUser: string | null = null;
  const toolMessage = (id: string): Row | undefined => (session.messages as Row[]).find((message) => message.role === "tool" && message.tool_call_id === id);
  let saving: Promise<void> = Promise.resolve();
  const onApprovalRequest = async (request: ApprovalRequest): Promise<void> => {
    const placeholder = awaitingApprovalResult(request) as unknown as Row;
    results[request.callId] = placeholder;
    const content = pyJsonDumps(placeholder);
    const existing = toolMessage(request.callId);
    if (existing) existing.content = content; else (session.messages as Row[]).push({ role: "tool", tool_call_id: request.callId, content });
    const saved = saving.then(() => context.save());
    saving = saved.catch(() => {});
    await saved;
    for (const extension of effectiveExtensions(context, extensions)) await extension.permissionRequested?.(context, request.callId);
    context.emit({ type: "approval_requested", id: request.callId, name: request.tool, kind: request.kind, subject: request.subject.slice(0, 160) });
  };
  const started = new Map<string, number>();
  const paused = (): Row => ({ ok: false, error: "not executed: run paused", retryable: false, error_code: "run_paused" });
  const prepare = async (call: Row): Promise<{ call: ToolCall; result: Row | null }> => {
    const fn = call.function as Row;
    const bridgeCall: ToolCall = { id: call.id as string, name: (fn.name as string).trim() };
    started.set(bridgeCall.id, performance.now() / 1000);
    if (isDict(results[bridgeCall.id])) return { call: bridgeCall, result: results[bridgeCall.id] as Row };
    if (halt || stopTurn || blockEffects || context.signal.aborted || context.options.shouldStop?.()) return { call: bridgeCall, result: paused() };
    if (!bridgeCall.name) return { call: bridgeCall, result: { ok: false, error: "unknown tool", error_code: "unknown_tool" } };
    const owner = runner.hooks.toolOwner(bridgeCall.name);
    if (!owner || !context.enabled(owner)) return { call: bridgeCall, result: { ok: false, error: "plugin disabled", error_code: "plugin_disabled", retryable: false,
      user_reason: "工具所属插件已关闭；请在插件管理中启用后继续。" } };
    if (!active.has(bridgeCall.name)) return { call: bridgeCall, result: { ok: false, error: "tool not active; discover it with tool_search first" } };
    let input: Row;
    try { input = argumentsObject(fn.arguments); } catch { return { call: bridgeCall, result: { ok: false, error: "invalid tool arguments", error_code: "invalid_tool_arguments" } }; }
    const prepared = { ...bridgeCall, input };
    for (const extension of effectiveExtensions(context, extensions)) {
      const veto = await extension.beforeTool?.(context, prepared);
      if (isDict(veto)) return { call: prepared, result: veto };
    }
    return { call: prepared, result: null };
  };
  const record = async (call: ToolCall, original: Row): Promise<void> => {
    // Media bytes never enter results or the journal: a sidecar holds them (tool-media.ts).
    const { media, _read_state, ...rest } = original;
    let result: Row = rest;
    for (const extension of effectiveExtensions(context, extensions)) if (extension.afterTool) result = await extension.afterTool(context, call, result);
    for (const extension of effectiveExtensions(context, extensions)) { try { extension.toolFinished?.(context, call, result, Math.max(0, performance.now() / 1000 - (started.get(call.id) ?? performance.now() / 1000))); } catch { /* telemetry is observational */ } }
    delete result.evidence_id;
    results[call.id] = result;
    const aliases = evidenceAliases(session);
    if (result.ok === true) result = { evidence_id: Object.entries(aliases).find(([, cid]) => cid === call.id)?.[0] ?? null, ...result };
    results[call.id] = result;
    const placed = toolMessage(call.id);
    const message: Row = placed ?? { role: "tool", tool_call_id: call.id, content: "" };
    message.content = pyJsonDumps(result);
    if (!placed) (session.messages as Row[]).push(message);
    if (_read_state !== undefined) message._read_state = _read_state;
    const refs = media === undefined ? [] : await saveToolMedia(context.stateDir, String(session.id), media);
    if (refs.length) message._tool_media = refs;
    const data = isDict(result.data) ? result.data : {};
    const error = isDict(result.error) ? result.error : {};
    // ZCode permission flow: approvals wait in process, so this is the fallback for an
    // approval nobody could answer now. A denial, a disabled plugin or another
    // non-retryable failure is an ordinary result the model sees.
    if (!halt && (result.awaiting_approval || data.awaitingApproval || error.code === "approval_required")) halt = result;
    if (!stopTurn && turnControlOf(result)) stopTurn = result;
    if (result.awaiting_user) awaitingUser = String(result.question ?? "");
    await context.save();
    for (const extension of effectiveExtensions(context, extensions)) await extension.toolResultRecorded?.(context, call, result);
    context.emit({ type: "tool_result", id: call.id, name: call.name, ok: !!result.ok, error: result.error ?? "" });
  };
  // Only explicitly classified reads run in parallel. Other calls are barriers,
  // so an approval request prevents every subsequent side effect.
  for (let start = 0; start < calls.length;) {
    let end = start + 1;
    const safe = (index: number): boolean => {
      const name = (calls[index]!.function as Row).name as string;
      return runner.hooks.concurrencySafe?.(name) === true;
    };
    if (safe(start) && !halt && !stopTurn && !blockEffects) while (end < calls.length && end - start < 10 && safe(end)) end += 1;
    const prepared = [];
    for (const call of calls.slice(start, end)) prepared.push(await prepare(call));
    const outcomes = await Promise.all(prepared.map(async (item): Promise<Row> => {
      if (item.result) return item.result;
      try { return await runner.toolBridge.call(item.call, { signal: context.signal, onApprovalRequest,
        onExecutionStarted: async (call) => { for (const extension of effectiveExtensions(context, extensions)) await extension.toolExecutionStarted?.(context, call); } }) as unknown as Row; }
      catch (error) { return { ok: false, error: error instanceof Error ? error.name : "Error" }; }
    }));
    for (let index = 0; index < prepared.length; index += 1) await record(prepared[index]!.call, outcomes[index]!);
    start = end;
  }
  return { awaitingUser, halt, stopTurn };
}
