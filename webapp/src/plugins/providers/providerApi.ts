import { del, get, post } from "../../xuenessBridge";

export type ProviderCompatibilityCheckDetails = {
  detectedMarkupDialect?: string;
  recommendedToolCalling?: "native";
  [key: string]: unknown;
};

/** 供应商摘要——**刻意不含 apiKey**，密钥永不回显。 */
export type ProviderCompatibilityCheckRecord = {
  mode: ProviderCompatibilityTestMode;
  ok: boolean;
  testedAt: string;
  requestCount: number;
  latencyMs?: number;
  error?: string;
  failedStep?: string;
  httpStatus?: number;
  details?: ProviderCompatibilityCheckDetails;
};

export type ProviderCompatibilityDiagnosticGroup = {
  optionsHash: string;
  compatibility: NonNullable<ProviderSummary["compatibility"]>;
  checks: ProviderCompatibilityCheckRecord[];
};

export type ProviderLightweightOptions = {
  reserveTokens?: number;
  optionalContextChars?: number;
  toolResultChars?: number;
  initialTools?: "auto" | "minimal" | "core";
  maxDiscoveredTools?: number;
  toolSearchResults?: number;
  resultPageChars?: number;
  fileReadChars?: number;
  overflowRetry?: boolean;
  overflowRetryRatio?: number;
  jsonRepairAttempts?: number;
  stepLimit?: number;
  wallTimeSeconds?: number;
  requestTimeoutSeconds?: number;
  transportRetries?: number;
  temperature?: number;
  topP?: number;
  seed?: number;
};

export type ProviderSummary = {
  source?: "subscription";
  subscriptionId?: string;
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  hasKey: boolean;
  protocol?: "openai" | "anthropic";
  capabilities?: string[];
  reasoningLevels?: string[];
  runtimeProfile?: "standard" | "lightweight";
  /** Explicitly permits this saved profile to use plaintext HTTP on loopback IP literals only. */
  allowLoopbackHttp?: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
  toolCalling?: "native" | "json";
  lightweightOptions?: ProviderLightweightOptions;
  compatibility?: {
    streamUsage?: boolean;
    parallelToolCalls?: boolean;
    maxTokensField?: "max_tokens" | "max_completion_tokens";
    toolChoice?: "auto" | "required";
    think?: boolean;
  };
  compatibilityDiagnostics?: ProviderCompatibilityDiagnosticGroup[];
  compatibilityVerification?: {
    verifiedAt: string;
    optionsHash: string;
    checks: ProviderCompatibilityCheckRecord[];
  };
};

export type ProviderConnectionTest = {
  ok: true;
  provider: { id: string; name: string; model: string; protocol: "openai" | "anthropic" };
  latencyMs: number;
};

export type ProviderCompatibilityTestMode =
  | "conversation"
  | "native_tool_call"
  | "json_tool_call"
  | "json_tool_roundtrip"
  | "stream"
  | "tool_roundtrip";

export type ProviderCompatibilityTest = {
  ok: boolean;
  error?: string;
  provider: { id: string; name: string; model: string; protocol: "openai" };
  latencyMs: number;
  optionsHash: string;
  testedAt: string;
  providerCompatibilityDiagnostics: ProviderCompatibilityDiagnosticGroup[];
  details: {
    mode: ProviderCompatibilityTestMode;
    requestCount: number;
    failedStep?: string | null;
    httpStatus?: number | null;
    detectedMarkupDialect?: string;
    recommendedToolCalling?: "native";
    requests?: { step: string; fields: string[] }[];
    [key: string]: unknown;
  };
};

export type ProviderDiscoveredModel = {
  id: string;
  created?: number;
  ownedBy?: string;
};

export type ProviderModelDiscovery = {
  ok: true;
  provider: { id: string; name: string; model: string; protocol: "openai" };
  models: ProviderDiscoveredModel[];
};

/** providers.default_selection: the stored default model and reasoning level. */
export type DefaultModelSelection = {
  providerId?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
};

/** GET /api/providers —— 只返回 hasKey，绝不含 apiKey。 */
export async function listProviders(signal?: AbortSignal): Promise<{ providers: ProviderSummary[] }> {
  const payload = await get<{ providers: ProviderSummary[] }>("/api/providers", signal);
  return { providers: payload.providers ?? [] };
}

/** POST /api/providers；body 可含 apiKey（只上行，永不回读）。 */
export async function saveProvider(body: Record<string, unknown>): Promise<{ provider: ProviderSummary }> {
  return post<{ provider: ProviderSummary }>("/api/providers", body);
}

/** POST /api/providers/test; the server reads credentials only from its saved profile. */
export async function testProviderConnection(id: string): Promise<ProviderConnectionTest> {
  return post<ProviderConnectionTest>("/api/providers/test", { id });
}

/** POST /api/providers/compatibility-test; tests only a saved profile and never stores draft options. */
export async function testProviderCompatibility(
  id: string,
  mode: ProviderCompatibilityTestMode,
  compatibility: NonNullable<ProviderSummary["compatibility"]>,
): Promise<ProviderCompatibilityTest> {
  return post<ProviderCompatibilityTest>("/api/providers/compatibility-test", {
    id, mode, compatibility: { ...compatibility },
  });
}

/** POST /api/providers/compatibility-adopt; server checks persisted results before saving. */
export async function adoptProviderCompatibility(id: string, optionsHash: string): Promise<{ provider: ProviderSummary }> {
  return post<{ provider: ProviderSummary }>("/api/providers/compatibility-adopt", { id, optionsHash });
}

/** GET /api/providers/default: the stored default selection, or null when none is saved. */
export async function getDefaultModelSelection(signal?: AbortSignal): Promise<DefaultModelSelection | null> {
  const payload = await get<{ default: DefaultModelSelection | null }>("/api/providers/default", signal);
  return payload.default ?? null;
}

/** POST /api/providers/default; the server validates before storing and answers 400 otherwise. */
export async function saveDefaultModelSelection(selection: DefaultModelSelection): Promise<DefaultModelSelection | null> {
  const payload = await post<{ default: DefaultModelSelection | null }>("/api/providers/default", {
    providerId: selection.providerId ?? null,
    model: selection.model ?? null,
    reasoningEffort: selection.reasoningEffort ?? null,
  });
  return payload.default ?? null;
}

/** POST /api/providers/discover; reads the saved OpenAI profile without sending a chat request. */
export async function discoverProviderModels(id: string): Promise<ProviderModelDiscovery> {
  const payload = await post<unknown>("/api/providers/discover", { id });
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("invalid model discovery response");
  const response = payload as Record<string, unknown>;
  const provider = response.provider;
  if (response.ok !== true || !provider || typeof provider !== "object" || Array.isArray(provider) || !Array.isArray(response.models)) {
    throw new Error("invalid model discovery response");
  }
  const providerRecord = provider as Record<string, unknown>;
  if (typeof providerRecord.id !== "string" || typeof providerRecord.name !== "string"
    || typeof providerRecord.model !== "string" || providerRecord.protocol !== "openai") {
    throw new Error("invalid model discovery response");
  }
  const models = response.models.map((item): ProviderDiscoveredModel => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("invalid model discovery response");
    const record = item as Record<string, unknown>;
    if (typeof record.id !== "string" || !record.id.trim()
      || (record.created !== undefined && (typeof record.created !== "number" || !Number.isFinite(record.created)))
      || (record.ownedBy !== undefined && typeof record.ownedBy !== "string")) {
      throw new Error("invalid model discovery response");
    }
    return {
      id: record.id,
      ...(record.created !== undefined ? { created: record.created } : {}),
      ...(record.ownedBy !== undefined ? { ownedBy: record.ownedBy } : {}),
    };
  });
  return {
    ok: true,
    provider: { id: providerRecord.id, name: providerRecord.name, model: providerRecord.model, protocol: "openai" },
    models,
  };
}

/** DELETE /api/providers/<id> */
export async function deleteProvider(id: string): Promise<{ ok: boolean; id: string }> {
  return del<{ ok: boolean; id: string }>(`/api/providers/${encodeURIComponent(id)}`);
}
