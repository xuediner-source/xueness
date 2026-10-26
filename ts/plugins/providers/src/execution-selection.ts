/**
 * Plugin-owned execution selection scopes (C-MDL-03): building the temporary
 * selection and its declarative fallback from the provider profile registry,
 * with registry lookup failures normalized to the agent's pre-request class.
 */
import { ModelSelectionLookupError, type AgentProvider, type ExecutionModelScope, type ExecutionModelSelection, type SelectionFallbackDeclaration } from "@xueness/agent";
import { resolveSavedProvider, type Selection } from "./provider-config.ts";
import type { ProfileStore } from "./profile-store.ts";

export interface ExecutionSelectionInput {
  /** The temporary selection this run executes with; names a provider and/or model. */
  selection: { providerId?: string | null; model?: string | null; reasoningEffort?: string | null; runtimeProfile?: string | null };
  fallback?: {
    providerId: string;
    rules: ReadonlyArray<{ reason: string; providerErrorCode?: string }>;
    target?: { providerId?: string | null; model?: string | null; reasoningEffort?: string | null };
    sameProvider?: boolean;
  };
}

const clean = (value: unknown, label: string): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > 200) throw new TypeError(`${label} is too long`);
  return trimmed;
};

function toSelection(raw: unknown, label: string): ExecutionModelSelection {
  const record = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const providerId = clean(record.providerId, `${label}.providerId`);
  const modelId = clean(record.model, `${label}.model`);
  if (!providerId && !modelId) throw new TypeError(`${label} must name a provider or a model`);
  const reasoningEffort = clean(record.reasoningEffort, `${label}.reasoningEffort`);
  return { providerId, modelId, ...(reasoningEffort ? { reasoningEffort } : {}) };
}

/**
 * An execution scope whose selections resolve through the saved profile registry.
 * Lookup failures (missing profile, unsupported effort) reject with
 * `ModelSelectionLookupError`, the pre-request selection-failure class; a
 * declared fallback becomes the agent's SingleAttempt + fallback route.
 */
export function providerExecutionModelScope(store: ProfileStore, input: ExecutionSelectionInput): ExecutionModelScope {
  const selection = toSelection(input.selection, "selection");
  const runtimeProfile = clean(input.selection.runtimeProfile, "selection.runtimeProfile");
  const rawFallback = input.fallback;
  let fallback: SelectionFallbackDeclaration | undefined;
  if (rawFallback) {
    const providerId = clean(rawFallback.providerId, "fallback.providerId");
    if (!providerId) throw new TypeError("fallback.providerId must name a provider");
    if (!Array.isArray(rawFallback.rules) || rawFallback.rules.length === 0) throw new TypeError("fallback.rules must be a non-empty array");
    const rules = rawFallback.rules.map((rule, index) => {
      const reason = clean(rule?.reason, `fallback.rules[${index}].reason`);
      if (!reason) throw new TypeError(`fallback.rules[${index}].reason must be a non-empty string`);
      const providerErrorCode = clean(rule?.providerErrorCode, `fallback.rules[${index}].providerErrorCode`);
      return { reason, ...(providerErrorCode ? { providerErrorCode } : {}) };
    });
    fallback = {
      providerId,
      rules,
      // A declared target names what the submitter was using before the temporary selection.
      ...(rawFallback.target ? { target: toSelection(rawFallback.target, "fallback.target") } : {}),
      ...(rawFallback.sameProvider === true ? { sameProvider: true } : {}),
    };
  }
  return {
    selection,
    ...(fallback ? { fallback } : {}),
    resolveProvider(target: ExecutionModelSelection): AgentProvider {
      const requested: Selection = {
        providerId: target.providerId ?? undefined,
        model: target.modelId ?? undefined,
        ...(target.reasoningEffort ? { reasoningEffort: target.reasoningEffort } : {}),
        // Only the execution selection itself carries a runtime profile override.
        ...(target === selection && runtimeProfile ? { runtimeProfile } : {}),
      };
      try {
        return resolveSavedProvider(store, requested);
      } catch (error) {
        // Registry lookup/validation failures are the pre-request class; transport or
        // programming errors keep their own type.
        if (error instanceof Error && error.name === "ValueError") throw new ModelSelectionLookupError(error.message, target);
        throw error;
      }
    },
  };
}
