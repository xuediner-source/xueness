/** Resolve saved credentials only after the server has selected an authorized profile. */
import { PyValueError } from "@xueness/contracts";
import { AnthropicMessages, isLoopbackLiteral, OpenAICompatible, pyUrlSplit, resolveRuntimeOptions, type ChatProvider } from "@xueness/providers";
import { ProfileStore, REASONING_LEVELS, reasoningLevels, type Dict } from "./profile-store.ts";
import { loadDefault } from "./default-selection.ts";

export const CONFIGURATION_GUIDANCE = "Configure a model with `xueness providers save ID --base-url URL --model MODEL --key-env ENV`, or set XUENESS_API_BASE, XUENESS_MODEL, and XUENESS_API_KEY (Anthropic also accepts ANTHROPIC_API_KEY with XUENESS_PROVIDER=anthropic).";
export function configurationError(error: unknown): string {
  let detail = (error instanceof Error ? error.message : String(error)).trim() || "model provider is not configured";
  if (detail.includes(CONFIGURATION_GUIDANCE)) return detail;
  if (detail.includes("XUENESS_MODEL and XUENESS_API_KEY must be set") || detail.includes("ANTHROPIC_API_KEY and XUENESS_MODEL must be set")) detail = "no model provider is configured";
  return `${detail}. ${CONFIGURATION_GUIDANCE}`;
}
export function validateEffort(model: unknown, configured: unknown, effort: unknown, base: unknown): void {
  if (effort === undefined || effort === null) return;
  if (typeof effort !== "string" || !REASONING_LEVELS.includes(effort)) throw new PyValueError("invalid reasoning effort");
  if (!reasoningLevels(model, base, configured).includes(effort)) throw new PyValueError("selected model does not declare support for reasoning effort " + effort);
}
export interface Selection { providerId?: string | null; model?: string | null; reasoningEffort?: string | null; runtimeProfile?: string | null; }
/** A saved profile's adapter, or another provider plugin's host-owned adapter. */
export type ResolvedProvider = OpenAICompatible | AnthropicMessages | ChatProvider;
export function resolveSavedProvider(store: ProfileStore, selection: Selection = {}): ResolvedProvider {
  if (selection.providerId == null && selection.model == null && selection.reasoningEffort == null) {
    const saved = loadDefault(store);
    selection = { ...selection, providerId: saved.providerId as string | null, model: saved.model as string | null, reasoningEffort: saved.reasoningEffort as string | null };
  }
  const { providerId, model, reasoningEffort, runtimeProfile } = selection;
  if (!providerId) {
    const protocol = (process.env.XUENESS_PROVIDER ?? "").trim().toLowerCase();
    if (!["", "openai", "anthropic"].includes(protocol)) throw new PyValueError("unsupported model provider; configure an OpenAI-compatible or Anthropic provider");
    if (protocol === "anthropic") {
      if (reasoningEffort) throw new PyValueError("Anthropic provider does not declare reasoning-effort support");
      return new AnthropicMessages({ model: model ?? undefined });
    }
    validateEffort(model ?? process.env.XUENESS_MODEL, null, reasoningEffort, process.env.XUENESS_API_BASE);
    return new OpenAICompatible({ model, reasoningEffort, runtimeProfile: runtimeProfile ?? "standard" });
  }
  const record = store.read(providerId);
  if (!record) {
    const external = store.external ? store.record(providerId) : null;
    if (external && store.external) return store.external.resolve(external, { model, reasoningEffort, runtimeProfile });
    throw new PyValueError("provider profile not found");
  }
  return providerFromRecord(record, { model, reasoningEffort, runtimeProfile });
}
export function providerFromRecord(record: Dict, selection: Selection = {}): OpenAICompatible | AnthropicMessages {
  const protocol = String(record.protocol ?? "openai");
  const options = resolveRuntimeOptions(selection.runtimeProfile ? { ...record, runtimeProfile: selection.runtimeProfile } : record, protocol);
  const url = pyUrlSplit(String(record.baseUrl ?? ""));
  const savedLoopback = record.allowLoopbackHttp === true && url.scheme === "http" && isLoopbackLiteral(url.hostname);
  const lightweight = record.runtimeProfile === "lightweight" || options.runtime_profile === "lightweight";
  const local = lightweight || savedLoopback;
  const capabilities = record.capabilities;
  if (capabilities !== undefined && (!Array.isArray(capabilities) || capabilities.some((v) => !["image", "pdf", "video"].includes(v)))) throw new PyValueError("provider profile has invalid model capabilities");
  const levels = record.reasoningLevels;
  if (levels !== undefined && (!Array.isArray(levels) || levels.some((v) => !REASONING_LEVELS.includes(v)) || new Set(levels).size !== levels.length)) throw new PyValueError("provider profile has invalid reasoning capabilities");
  const base = String(record.baseUrl ?? "");
  const model = selection.model || String(record.model ?? "");
  const key = typeof record.apiKey === "string" ? record.apiKey : "";
  if (protocol === "anthropic") {
    if (levels !== undefined) throw new PyValueError("Anthropic provider cannot declare reasoning levels");
    if (selection.reasoningEffort) throw new PyValueError("Anthropic provider does not declare reasoning-effort support");
    const provider = new AnthropicMessages({ base, model, key, capabilities: capabilities as string[] | undefined, maxTokens: options.max_output_tokens ?? 4096, allowLoopbackHttp: local ? true : null });
    Object.assign(provider, { runtimeProfile: options.runtime_profile, contextWindow: options.context_window, maxOutputTokens: options.max_output_tokens, toolCalling: options.tool_calling, compatibility: options.compatibility, lightweightOptions: options.lightweight_options });
    return provider;
  }
  if (protocol !== "openai") throw new PyValueError("provider profile uses an unsupported protocol");
  validateEffort(model, levels, selection.reasoningEffort, base);
  return new OpenAICompatible({ base, model, key, capabilities: capabilities as string[] | undefined, reasoningEffort: selection.reasoningEffort, runtimeProfile: options.runtime_profile, contextWindow: options.context_window, maxOutputTokens: options.max_output_tokens, toolCalling: options.tool_calling, compatibility: options.compatibility, lightweightOptions: options.lightweight_options, allowLoopbackHttp: local ? true : null, allowEmptyKey: lightweight ? true : savedLoopback ? false : null });
}
