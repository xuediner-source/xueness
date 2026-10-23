/** Agent extension that sends the ZCode-style prompt view on every model request. */
import type { AgentContext, AgentExtension, ModelRequest } from "../types.ts";
import type { EnvInfo } from "./env-sections.ts";
import { localDate } from "./env-sections.ts";
import { sessionEnvInfo } from "./environment.ts";
import { buildPromptView } from "./view.ts";
import { modelToolName } from "../tool-contract/names.ts";

export interface PromptContextOptions {
  envInfo?: (context: AgentContext) => EnvInfo;
  now?: () => Date;
}
export function promptContextExtension(options: PromptContextOptions = {}): AgentExtension {
  return {
    id: "sessions", capabilities: ["sessions.prompt_context"],
    prepareRequest(context: AgentContext, request: ModelRequest): ModelRequest {
      if ((context.session.runtime_profile ?? context.provider.runtimeProfile) === "lightweight") return request;
      const envInfo = options.envInfo?.(context) ?? sessionEnvInfo(String(context.session.id ?? ""), context.root);
      const model = context.provider.model?.trim();
      const messages = buildPromptView(request.messages, {
        envInfo, currentDate: localDate(options.now?.() ?? new Date()),
        ...(model ? { model: { providerId: context.provider.protocol ?? "openai", modelId: model } } : {}),
        guidanceToolNames: request.tools.map((t) => (t.function as { name?: unknown } | undefined)?.name).filter((n): n is string => typeof n === "string").map(modelToolName),
        hostInstructions: request.hostInstructions, repair: request.repair,
      });
      return messages ? { ...request, messages } : request;
    },
  };
}
