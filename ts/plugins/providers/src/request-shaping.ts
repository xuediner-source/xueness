/** Providers-owned history projection and one signature repair through the normal recovery budget. */
import type { AgentExtension } from "@xueness/agent";
import { hasRequestMedia, projectAnthropicHistory, repairReasoningHistoryAfterSignatureRejection } from "@xueness/providers";

export function providerRequestShapingExtension(): AgentExtension {
  return { id: "providers", capabilities: ["providers.request_shaping"],
    prepareRequest(context, request) {
      const provider = context.provider.upcomingProvider?.() ?? context.provider;
      if (provider.protocol !== "anthropic") return request;
      return { ...request, messages: projectAnthropicHistory(request.messages, provider, hasRequestMedia),
        options: { ...request.options, reasoningHistoryNormalized: true } };
    },
    retryRequest(context, request, error) {
      if (context.provider.protocol !== "anthropic") return null;
      const messages = repairReasoningHistoryAfterSignatureRejection(request.messages, error);
      return messages ? { ...request, messages } : null;
    },
  };
}
