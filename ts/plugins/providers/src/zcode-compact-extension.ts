/**
 * ZCode-aligned compaction for the standard runtime (ZCode v3.15.1, aac4755, Apache-2.0:
 * `core/runtime/methods/compact.ts` autoCompactIfNeeded, `turn-model-step.ts`
 * recoverModelStepAfterContextExceeded, `turn-loop-state.ts` rapid-refill tracking).
 * - auto: before each request, when the prepared request reaches the threshold;
 * - reactive: once per model step after a context-overflow error, then the request is retried;
 * - manual: `compactSessionNow` (the sessions compact route).
 * Three consecutive auto failures open the circuit breaker; three compactions that refill
 * within fewer than three tool turns stop the run. The lightweight runtime keeps its own
 * bounded prompt view, and `compaction.enabled === false` keeps the deterministic fallback.
 */
import { isDict } from "@xueness/contracts";
import {
  CompactionError, getUsageTotalTokens, isModelContextExceededError, MAX_CONSECUTIVE_RAPID_REFILLS, estimateMessageTokens, RAPID_REFILL_TOOL_TURN_THRESHOLD,
  rapidRefillMessage, resolveModelLimits, resolveNormalRequestMaxOutputTokens, shouldAutoCompact,
  type AgentContext, type AgentExtension, type AutoCompactTokenOverride, type LocalMicrocompactPolicyConfig, type RebuildRequest, type Row,
} from "@xueness/agent";
import { isStreamStop } from "@xueness/providers";
import { auxiliaryModelAdmission } from "./aux-admission.ts";
import { compactConversation, type CompactConversationResult } from "./zcode-compact.ts";
import { compactRequestView } from "./zcode-compact-view.ts";

interface Tracking { consecutiveRapidRefills: number; toolTurnsSinceCompact: number }
interface CompactState { failures: number; tracking?: Tracking; reactiveUsed: boolean; justCompacted: boolean; toolBatchPending: boolean }
const states = new WeakMap<object, CompactState>();
function stateOf(session: object): CompactState {
  let state = states.get(session);
  if (!state) states.set(session, state = { failures: 0, reactiveUsed: false, justCompacted: false, toolBatchPending: false });
  return state;
}
export function evaluateRapidRefill(tracking: Tracking | undefined): { consecutiveRapidRefills: number; shouldBlock: boolean; toolTurnsSinceCompact: number } {
  const toolTurnsSinceCompact = tracking?.toolTurnsSinceCompact ?? 0;
  const consecutiveRapidRefills = tracking && toolTurnsSinceCompact < RAPID_REFILL_TOOL_TURN_THRESHOLD ? tracking.consecutiveRapidRefills + 1 : 0;
  return { consecutiveRapidRefills, shouldBlock: consecutiveRapidRefills >= MAX_CONSECUTIVE_RAPID_REFILLS, toolTurnsSinceCompact };
}

export function zcodeCompactionActive(session: Row, provider: { runtimeProfile?: string }): boolean {
  if ((session.runtime_profile ?? provider.runtimeProfile) === "lightweight") return false;
  return !(isDict(session.compaction) && session.compaction.enabled === false) && !(isDict(session.semantic_compaction) && session.semantic_compaction.enabled === false);
}

/** Provider usage of the last response, plus an estimate of the messages appended since (ZCode buildProviderUsageTokenOverride). */
export function usageTokenOverride(session: Row): AutoCompactTokenOverride | undefined {
  const anchor = session.context_usage; const journal = Array.isArray(session.messages) ? session.messages as Row[] : [];
  if (!isDict(anchor) || typeof anchor.totalTokens !== "number" || typeof anchor.messageCount !== "number" || anchor.totalTokens <= 0) return undefined;
  if (anchor.compactions !== (Array.isArray(session.compactions) ? session.compactions.length : 0) || anchor.messageCount > journal.length) return undefined;
  let later = journal.slice(anchor.messageCount);
  if (later[0]?.role === "assistant") later = later.slice(1); // the response itself is in the usage
  const incremental = estimateMessageTokens(later);
  return { source: "provider_usage", tokenCount: anchor.totalTokens + incremental, baseTokenCount: anchor.totalTokens, incrementalTokenCount: incremental };
}

export function autoCompactConfig(provider: AgentContext["provider"]): { contextWindow: number; maxOutputTokens: number } {
  const limits = resolveModelLimits(provider);
  return { contextWindow: limits.contextWindow, maxOutputTokens: resolveNormalRequestMaxOutputTokens({ modelMaxOutputTokens: limits.maxOutputTokens }) };
}

const runSignal = (context: AgentContext): AbortSignal => AbortSignal.any([context.signal, context.hostSignal].filter((signal): signal is AbortSignal => !!signal));
const isCancel = (context: AgentContext, error: unknown): boolean => isStreamStop(error) || context.signal.aborted || !!context.hostSignal?.aborted || !!context.options.shouldStop?.();
const saver = (context: AgentContext) => async (staged: Row): Promise<void> => { await context.store.save(staged as never); };

export interface ZCodeCompactionOptions { microcompact?: (context: AgentContext) => LocalMicrocompactPolicyConfig | undefined }

export function zcodeCompactionExtension(config: ZCodeCompactionOptions = {}): AgentExtension {
  const active = (context: AgentContext): boolean => zcodeCompactionActive(context.session, context.provider);
  const isError = (context: AgentContext) => (id: string): boolean => { const results = context.session.results; return isDict(results) && isDict(results[id]) && results[id].ok === false; };
  return {
    id: "providers", capabilities: ["providers.semantic_compaction", "providers.zcode_compaction"],
    ownsCompaction: active,
    prepareRequest(context, request) {
      if (!active(context)) return request;
      return { ...request, messages: compactRequestView(request.messages, { isError: isError(context), microcompact: config.microcompact?.(context) }) };
    },
    async compactBeforeRequest(context, request, rebuild) {
      if (!active(context)) return false;
      const state = stateOf(context.session);
      if (state.toolBatchPending) { state.toolBatchPending = false; state.reactiveUsed = false; if (state.tracking) state.tracking.toolTurnsSinceCompact += 1; }
      if (state.justCompacted) return false;
      const decision = shouldAutoCompact({ messages: request.messages, config: autoCompactConfig(context.provider), consecutiveFailures: state.failures, tokenOverride: usageTokenOverride(context.session) });
      const cap = context.options.maxTokens;
      const capped = typeof cap === "number" && Number.isInteger(cap) && cap > 0 && decision.reason === "below_threshold" && decision.tokenCount >= cap;
      if (!decision.shouldCompact && !capped) return false;
      const rapid = evaluateRapidRefill(state.tracking);
      if (rapid.shouldBlock) throw new CompactionError("compact_rapid_refill", rapidRefillMessage(), false);
      try {
        const result = await compactConversation(context.session, { provider: context.provider, rebuild, root: context.root, trigger: "auto", phase: "preflight", reason: "context_limit",
          preCompactTokens: decision.tokenCount, autoCompactThreshold: capped ? cap! : decision.threshold, signal: runSignal(context), shouldStop: context.options.shouldStop,
          admission: auxiliaryModelAdmission(context.stateDir), save: saver(context), emit: (event) => context.emit({ ...event, type: String(event.type) }) });
        if (!result.compacted) return false;
        state.failures = 0; state.tracking = { consecutiveRapidRefills: rapid.consecutiveRapidRefills, toolTurnsSinceCompact: 0 }; state.justCompacted = true;
        return true;
      } catch (error) {
        if (isCancel(context, error)) throw error;
        state.failures += 1;
        return false;
      }
    },
    async compactAfterOverflow(context, _request, error, rebuild) {
      if (!active(context) || !isModelContextExceededError(error)) return false;
      const state = stateOf(context.session);
      if (state.reactiveUsed) return false;
      const rapid = evaluateRapidRefill(state.tracking);
      if (rapid.shouldBlock) throw new CompactionError("compact_rapid_refill", rapidRefillMessage(), false, { cause: error });
      state.reactiveUsed = true;
      try {
        const result = await compactConversation(context.session, { provider: context.provider, rebuild, root: context.root, trigger: "reactive", phase: "reactive", reason: "context_limit",
          overflowCause: error, signal: runSignal(context), shouldStop: context.options.shouldStop, admission: auxiliaryModelAdmission(context.stateDir),
          save: saver(context), emit: (event) => context.emit({ ...event, type: String(event.type) }) });
        if (!result.compacted) return false;
        state.tracking = { consecutiveRapidRefills: rapid.consecutiveRapidRefills, toolTurnsSinceCompact: 0 }; state.justCompacted = true;
        return true;
      } catch (failure) {
        if (isCancel(context, failure)) throw failure;
        return false;
      }
    },
    afterModelResponse(context, response) {
      if (!active(context)) return response;
      const state = stateOf(context.session);
      state.justCompacted = false;
      if (Array.isArray(response.tool_calls) && response.tool_calls.length) state.toolBatchPending = true;
      const total = getUsageTotalTokens(isDict(response._usage) ? response._usage : undefined);
      if (total > 0) context.session.context_usage = { totalTokens: total, messageCount: Array.isArray(context.session.messages) ? context.session.messages.length : 0,
        compactions: Array.isArray(context.session.compactions) ? context.session.compactions.length : 0 };
      return response;
    },
  };
}

/** Manual compaction outside a run (ZCode `/compact [instructions]`): keeps no recent round. */
export async function compactSessionNow(context: AgentContext, rebuild: RebuildRequest, instructions: string | null): Promise<CompactConversationResult> {
  return compactConversation(context.session, { provider: context.provider, rebuild, root: context.root, trigger: "manual", phase: "manual", reason: "manual",
    ...instructions ? { customInstructions: instructions } : {}, preCompactTokens: estimateMessageTokens((await rebuild(context.session.messages as Row[])).messages),
    signal: runSignal(context), shouldStop: context.options.shouldStop, admission: auxiliaryModelAdmission(context.stateDir),
    save: saver(context), emit: (event) => context.emit({ ...event, type: String(event.type) }) });
}
