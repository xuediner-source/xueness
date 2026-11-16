/**
 * The decision model in a run (`AgentExtension`, id `tool_judge`).
 *
 * `prepareRequest` remembers the schemas the model saw. `afterModelResponse`
 * runs before the step is saved: it sends ONE judge request for all risky
 * calls of the step and, when repairs are on, rewrites a repaired call's
 * arguments in the response — so the saved step, the permission subject and
 * approval replay all see the repaired call, while the verdict record keeps
 * the original. `beforeTool` stops a call the judge rejected (once);
 * `afterTool` puts the judge's note on the result the model reads;
 * `toolFinished` counts how judged calls turned out.
 *
 * It fails open: no profile, a timeout, an error or an unreadable answer lets
 * every call run, recorded as `unavailable`. It is not a permission gate.
 */
import { isDict, pyJsonDumps, pyJsonLoads } from "@xueness/contracts";
import type { AgentContext, AgentExtension, AgentProvider, ModelRequest } from "@xueness/agent";
import { internalToolName } from "@xueness/agent";
import { decide, judgeMessages, MAX_JUDGED_CALLS, parseVerdicts, riskyCall, signature, verdictNote, type JudgedCall, type RecentResult } from "./verdicts.ts";
import { JudgeStatsRecorder, markRejected, recordVerdict, rejectState, verdictFor, type VerdictRecord } from "./stats.ts";
import type { JudgeSelection, JudgeSettings } from "./settings.ts";

type Row = Record<string, unknown>;
const DEFERRED = "deferred_tool_call";

export interface JudgePorts {
  /** Current settings; a throw means "judge off" for this step. */
  settings(): JudgeSettings;
  /** The judge model for this run (settings, or a swarm's own choice); null keeps the judge off. */
  selection(settings: JudgeSettings): JudgeSelection | null;
  provider(selection: JudgeSelection): AgentProvider;
  /** One bounded, tool-free JSON request under model admission (`handoffModelJson`). */
  ask(provider: AgentProvider, messages: Row[], options: { timeoutSeconds: number; outputTokens: number; signal: AbortSignal }): Promise<[Row, Row]>;
  /** A registered tool's gate kind, by internal name. */
  gateOf(name: string): string | null;
  /** Whether a finished result failed, and whether the failure was avoidable (tool outcomes). */
  classify(name: string, result: Row): { failed: boolean; avoidable: boolean };
  /** Platform and shell the calls run on, for the judge's eyes. */
  platform(): string;
}

interface Pending { callIndex: number; modelName: string; name: string; input: Row; schema: Row | null; deferred: boolean }

function parseArguments(raw: unknown): Row | null {
  if (isDict(raw)) return raw;
  if (typeof raw !== "string") return null;
  try { const value = pyJsonLoads(raw); return isDict(value) ? value : null; } catch { return null; }
}

function goalOf(session: Row): string {
  const messages = Array.isArray(session.messages) ? session.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const row = messages[index];
    if (isDict(row) && row.role === "user" && typeof row.content === "string" && !row._input_kind && !row._meta_source) return row.content;
  }
  return typeof session.task === "string" ? session.task : "";
}

function recentResults(session: Row): RecentResult[] {
  const messages = Array.isArray(session.messages) ? session.messages : [];
  const names = new Map<string, string>();
  for (const row of messages) if (isDict(row) && Array.isArray(row.tool_calls)) for (const call of row.tool_calls) if (isDict(call) && isDict(call.function)) names.set(String(call.id), String(call.function.name));
  const out: RecentResult[] = [];
  for (let index = messages.length - 1; index >= 0 && out.length < 3; index -= 1) {
    const row = messages[index];
    if (!isDict(row) || row.role !== "tool" || typeof row.content !== "string") continue;
    let result: Row = {};
    try { const value = pyJsonLoads(row.content); if (isDict(value)) result = value; } catch { /* plain text result */ }
    const error = isDict(result.error) ? result.error : {};
    const text = typeof result.output === "string" ? result.output : typeof result.error === "string" ? result.error : typeof error.message === "string" ? error.message : row.content;
    out.unshift({ name: names.get(String(row.tool_call_id)) ?? "tool", ok: result.ok === true, code: typeof result.error_code === "string" ? result.error_code : typeof error.code === "string" ? error.code : null, text });
  }
  return out;
}

export function toolJudgeExtension(ports: JudgePorts): AgentExtension {
  const schemas = new WeakMap<object, Map<string, Row>>();
  const vetoes = new WeakMap<object, Map<string, string>>();
  const stats = new JudgeStatsRecorder();
  const now = (): string => new Date().toISOString();

  return {
    id: "tool_judge",
    capabilities: ["tool_judge.verdicts", "tool_judge.stats"],
    prepareRequest(context: AgentContext, request: ModelRequest): ModelRequest {
      const map = new Map<string, Row>();
      for (const tool of request.tools) if (isDict(tool) && isDict(tool.function) && typeof tool.function.name === "string") map.set(tool.function.name, isDict(tool.function.parameters) ? tool.function.parameters : {});
      schemas.set(context.session, map);
      return request;
    },
    async afterModelResponse(context: AgentContext, response: Row): Promise<Row> {
      if (response._protocol_error || response._finish_reason === "length" || !Array.isArray(response.tool_calls) || !response.tool_calls.length) return response;
      let settings: JudgeSettings, selection: JudgeSelection | null;
      try { settings = ports.settings(); selection = ports.selection(settings); } catch { return response; }
      if (!selection) return response;
      const session = context.session as Row;
      const seen = schemas.get(session) ?? new Map<string, Row>();
      const pending: Pending[] = [];
      response.tool_calls.forEach((call, callIndex) => {
        if (!isDict(call) || !isDict(call.function) || typeof call.function.name !== "string" || pending.length >= MAX_JUDGED_CALLS) return;
        const modelName = call.function.name.trim();
        const args = parseArguments(call.function.arguments);
        if (!args) return; // the core reports invalid arguments itself
        const deferred = modelName === DEFERRED && typeof args.tool === "string";
        const name = internalToolName(deferred ? String(args.tool).trim() : modelName);
        const input = deferred ? (isDict(args.input) ? args.input : {}) : args;
        if (!riskyCall(name, ports.gateOf(name))) return;
        pending.push({ callIndex, modelName: deferred ? String(args.tool) : modelName, name, input, schema: deferred ? null : seen.get(modelName) ?? null, deferred });
      });
      if (!pending.length) return response;
      const model = `${selection.providerId}${selection.model ? `:${selection.model}` : ""}`;
      const calls: JudgedCall[] = pending.map((item) => ({ name: item.modelName, input: item.input, schema: item.schema }));
      const started = performance.now();
      let answer: Row;
      try {
        const provider = ports.provider(selection);
        [answer] = await ports.ask(provider, judgeMessages(calls, goalOf(session), recentResults(session), ports.platform()),
          { timeoutSeconds: settings.timeoutMs / 1000, outputTokens: settings.maxOutputTokens, signal: context.signal });
      } catch {
        const ms = performance.now() - started;
        stats.request(session, model, pending.length, ms, false);
        for (const item of pending) {
          const callId = String((response.tool_calls[item.callIndex] as Row).id);
          recordVerdict(session, callId, { v: 1, at: now(), tool: item.name, verdict: "unavailable", applied: "none", reason: "", judgeMs: Math.round(ms), model, sig: signature(item.name, item.input) });
          stats.add(session, "unavailable");
        }
        return response;
      }
      const ms = performance.now() - started;
      stats.request(session, model, pending.length, ms, true);
      const raws = parseVerdicts(answer, pending.length);
      const signed = Array.isArray(response._reasoning_blocks) && response._reasoning_blocks.length > 0;
      const toolCalls = [...response.tool_calls];
      pending.forEach((item, index) => {
        const call = toolCalls[item.callIndex] as Row;
        const callId = String(call.id);
        const sig = signature(item.name, item.input);
        // A call stopped once runs when repeated unchanged; if that first repeat succeeds, the stop was a wrong block.
        const state = rejectState(session, sig);
        if (state === "rejected") markRejected(session, sig, "retried");
        const decision = decide(raws[index]!, item.input, item.schema, { applyRepairs: settings.applyRepairs, applyRejects: settings.applyRejects, rejectedBefore: state !== null, signedReasoning: signed });
        stats.add(session, decision.verdict);
        const record: VerdictRecord = { v: 1, at: now(), tool: item.name, verdict: decision.verdict, applied: decision.applied, reason: decision.reason, judgeMs: Math.round(ms), model, sig, ...state === "rejected" ? { retryOfReject: true } : {} };
        if (decision.applied === "repaired" && decision.input) {
          record.original = item.input;
          const replaced = item.deferred ? { ...parseArguments((call.function as Row).arguments), input: decision.input } : decision.input;
          toolCalls[item.callIndex] = { ...call, function: { ...(call.function as Row), arguments: pyJsonDumps(replaced) } };
          stats.add(session, "repairsApplied");
        }
        if (decision.applied === "rejected") {
          markRejected(session, sig);
          stats.add(session, "rejectsApplied");
          const map = vetoes.get(session) ?? new Map<string, string>();
          map.set(callId, verdictNote(decision, null));
          vetoes.set(session, map);
        }
        recordVerdict(session, callId, record);
      });
      return { ...response, tool_calls: toolCalls };
    },
    beforeTool(context: AgentContext, call: { id: string }): Row | null {
      const note = vetoes.get(context.session)?.get(call.id);
      if (note === undefined) return null;
      vetoes.get(context.session)!.delete(call.id);
      return { ok: false, error: note, error_code: "judge_rejected", retryable: true, user_reason: "工具调用判定模型在执行前拦下了这个调用；模型原样重试时会放行。" };
    },
    afterTool(context: AgentContext, call: { id: string }, result: Row): Row {
      const record = verdictFor(context.session as Row, call.id);
      if (!record || record.applied === "none" || record.applied === "rejected") return result;
      const decision = { verdict: record.verdict === "unavailable" ? "pass" as const : record.verdict, applied: record.applied, reason: record.reason, input: null, retryOfReject: record.retryOfReject === true };
      return { ...result, judge_note: verdictNote(decision, record.original ?? null) };
    },
    toolFinished(context: AgentContext, call: { id: string; name: string }, result: Row): void {
      const session = context.session as Row;
      const record = verdictFor(session, call.id);
      if (!record || record.outcome || record.verdict === "unavailable" || result.awaiting_approval) return;
      const { failed, avoidable } = ports.classify(call.name, result);
      record.outcome = failed ? "failed" : "ok";
      stats.outcome(session, record, failed, avoidable);
    },
  };
}
