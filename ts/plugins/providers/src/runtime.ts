/** Providers-owned lightweight behavior plugged into the shared agent driver. */
import { isDict } from "@xueness/contracts";
import type { AgentContext, AgentExtension, ModelRequest, Row } from "@xueness/agent";
import { finishReason, incompleteReason, normalizeNative } from "@xueness/providers";
import { observeUsage, runtimeOptions, type RuntimeProvider } from "./runtime-budget.ts";
import { promptView } from "./runtime-prompt.ts";
import { decodeTextResponse, partialAnswer, streamAnswerText, textMessages } from "./runtime-protocol.ts";
import { selectRuntimeTools, type RuntimeToolPolicy } from "./runtime-tools.ts";

export * from "./runtime-budget.ts";
export * from "./runtime-prompt.ts";
export * from "./runtime-protocol.ts";
export * from "./runtime-tools.ts";
export * from "./runtime-window.ts";

export interface LightweightRuntimeOptions { toolPolicy?: (context: AgentContext) => RuntimeToolPolicy }
export function lightweightRuntimeExtension(config: LightweightRuntimeOptions = {}): AgentExtension {
  const active = (context: AgentContext): boolean => (context.session.runtime_profile ?? context.provider.runtimeProfile) === "lightweight";
  const attempts = new WeakMap<Row, { overflow: boolean; tools: Row[]; extraAttempt?: boolean }>();
  const build = (context: AgentContext, request: ModelRequest, shrink = 1): ModelRequest => {
    const provider = context.provider as RuntimeProvider;
    const [catalog, tools] = selectRuntimeTools(request.tools, context.session, provider, config.toolPolicy?.(context));
    void catalog; // tool_search uses the registry catalog; the request receives only the selected view.
    const [messages, stats] = promptView(request.messages, tools, provider, { maxChars: context.options.maxChars,
      maxTokens: context.options.maxTokens, shrink, repair: request.repair, hostInstructions: request.hostInstructions,
      calibration: context.session.runtime_budget_calibration, injected: request.injected });
    context.session.runtime_budget = stats;
    const state = attempts.get(context.session) ?? { overflow: false, tools: [] }; state.tools = tools; attempts.set(context.session, state);
    return { ...request, messages: provider.toolCalling === "json" ? textMessages(messages) : messages, tools };
  };
  return {
    id: "providers", capabilities: ["providers.lightweight"], preserveJournal: active,
    beforeRun(context) {
      if (!active(context)) return;
      const provider = context.provider as RuntimeProvider;
      const options = runtimeOptions(provider);
      context.session.runtime_profile = "lightweight"; context.session.lightweight_options = { ...options };
      context.options.maxSteps = Math.min(context.options.maxSteps ?? options.stepLimit as number, options.stepLimit as number);
      if (context.options.maxChars === undefined) {
        let budget = Math.max(0, (provider.contextWindow || 8192) - (provider.maxOutputTokens || 1024) - (options.reserveTokens as number));
        if (context.options.maxTokens !== null && context.options.maxTokens !== undefined) budget = Math.min(budget, context.options.maxTokens);
        context.options.maxChars = Math.min(100000, Math.max(24000, budget * 2));
      }
      attempts.set(context.session, { overflow: false, tools: [] });
      return options.wallTimeSeconds ? { deadlineSeconds: options.wallTimeSeconds as number } : undefined;
    },
    prepareRequest(context, request) {
      if (!active(context)) return request;
      const state = attempts.get(context.session); if (state) state.extraAttempt = false;
      const options = runtimeOptions(context.provider as RuntimeProvider);
      return build(context, request, context.session.runtime_context_recovery === true ? options.overflowRetryRatio as number : 1);
    },
    retryRequest(context, request, error) {
      if (!active(context)) return null;
      const options = runtimeOptions(context.provider as RuntimeProvider);
      const state = attempts.get(context.session);
      if (!options.overflowRetry || state?.overflow || !(error && typeof error === "object" && "contextOverflow" in error && error.contextOverflow === true)) return null;
      if (state) { state.overflow = true; state.extraAttempt = true; }
      const retried = build(context, { ...request, messages: context.session.messages as Row[] }, options.overflowRetryRatio as number);
      (context.session.runtime_budget as Row).overflowRetry = true;
      return retried;
    },
    streamText(context, accumulated) { return active(context) && context.provider.toolCalling === "json" ? streamAnswerText(accumulated) : accumulated; },
    afterModelResponse(context, response) {
      if (!active(context)) return response;
      const state = attempts.get(context.session);
      if (state?.extraAttempt && typeof response._request_attempts === "number" && Number.isInteger(response._request_attempts) && response._request_attempts > 0) response = { ...response, _request_attempts: response._request_attempts + 1 };
      const incomplete = incompleteReason(finishReason(response._finish_reason), response._usage, context.provider);
      observeUsage(context.session, context.provider as RuntimeProvider, response._usage);
      if (incomplete) {
        if (incomplete === "context_limit") context.session.runtime_context_recovery = true;
        return { ...response, content: partialAnswer(response, context.provider.toolCalling === "json"), tool_calls: [] };
      }
      delete context.session.runtime_context_recovery;
      return context.provider.toolCalling === "json" ? decodeTextResponse(response, attempts.get(context.session)?.tools ?? [])
        : normalizeNative(response, Object.keys(isDict(context.session.results) ? context.session.results : {})) as Row;
    },
    close(context) { attempts.delete(context.session); },
  };
}
