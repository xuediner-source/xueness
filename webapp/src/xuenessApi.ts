/**
 * Xueness 前端 API 客户端（Stage 2 契约）。
 *
 * 与 `xuenessBridge.ts` 保持同一风格：
 * - `credentials: "same-origin"`，GET 带 `cache: "no-store"`
 * - 写操作先取 `/api/csrf`，再带 `X-CSRF-Token` 头
 * - 非 2xx → `throw new Error(payload.error || \`HTTP ${status}\`)`
 *
 * 不引入任何新依赖；不对响应体做猜测式解构，形状由契约保证。
 */

/* ------------------------------------------------------------------ */
/* 类型                                                                */
/* ------------------------------------------------------------------ */

/** 资源条目（skills / commands / hooks / mcp / subagents / plugins 通用）。 */
export type ResourceItem = {
  id: string;
  createdAt: string;
  updatedAt: string;
  [k: string]: unknown;
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
  details?: Record<string, unknown>;
};

export type ProviderCompatibilityDiagnosticGroup = {
  optionsHash: string;
  compatibility: NonNullable<ProviderSummary["compatibility"]>;
  checks: ProviderCompatibilityCheckRecord[];
};

export type ProviderSummary = {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  hasKey: boolean;
  protocol?: "openai" | "anthropic";
  capabilities?: string[];
  reasoningLevels?: string[];
  runtimeProfile?: "standard" | "lightweight";
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

/** 用量汇总。/api/usage?range=... */
export type UsageSummary = {
  range: string;
  totals: { sessions: number; steps: number; completed: number };
  series: { date: string; sessions: number; steps: number }[];
  updatedAt: string;
  tokens?: { input: number; output: number; total?: number; reportedRequests: number; unknownRequests: number };
  costs?: Record<string, number>;
  costSource?: string;
  dailyUsage?: UsageDailySummary[];
  models?: UsageModelSummary[];
  tokenActivity?: {
    activeDays: number;
    peakDayTokens: number;
    currentStreakDays: number;
    longestStreakDays: number;
  };
};

export type UsageModelSummary = {
  model: string | null;
  protocol: "openai" | "anthropic" | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  requestCount: number;
  unknownRequests: number;
  costs: Record<string, number>;
};

export type UsageDailySummary = {
  date: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  requestCount: number;
  unknownRequests: number;
  costs: Record<string, number>;
  models: UsageModelSummary[];
};

/** 记忆文件轨道。 */
export type MemoryTrack = {
  name: "memory" | "user" | "key";
  path: string;
  bytes: number;
  present: boolean;
};

export type SettingsMap = Record<string, Record<string, unknown>>;
export type SettingsSection = { section: string; values: Record<string, unknown> };
export type ResourceList = {
  items: ResourceItem[];
  capability: { userScopeAvailable: boolean; userScopeReason?: string };
};
/** 合并命令清单的一行：内建提示命令、工作区/用户 .md 文件与资源存储同表呈现。 */
export type CommandCatalogRow = {
  id: string;
  name: string;
  description?: string;
  argumentHint?: string;
  source: string;
  scope?: string;
  shadowed?: boolean;
  shadowedBy?: string | null;
  [k: string]: unknown;
};
export type MemoryTracks = { tracks: MemoryTrack[] };

export type XuenessPluginFeature = {
  id: string;
  name: string;
  nameEn?: string;
};

/** Host plugin catalog. These records describe locally installed modules; they
 * never contain executable frontend code. The UI maps IDs through its own
 * allowlisted registry before exposing panels. */
export type XuenessPlugin = {
  id: string;
  name: string;
  description: string;
  version: string;
  apiVersion: string;
  enabled: boolean;
  effective: boolean;
  dependencies: string[];
  blockedBy: string[];
  tools: string[];
  commands: string[];
  panels: string[];
  resources: string[];
  capabilities: string[];
  /** Feature descriptions are metadata only; the host catalog never supplies executable code. */
  features?: XuenessPluginFeature[];
};
export type XuenessPluginCatalog = { plugins: XuenessPlugin[] };
export type MarketplaceItem = {
  id: string; name: string; description: string; version: string; sha256: string;
  installedVersion: string | null; manifest: Record<string, unknown>; source: string;
};
/** One selectable composition profile: allowlisted plugin ids, booleans only. */
export type PluginProfileRow = {
  name: string;
  source: string;
  extends: string[];
  description: string;
  descriptionEn: string;
  enabled: string[];
  disabled: string[];
  active: boolean;
};
export type PluginProfileCatalog = { active: string | null; profiles: PluginProfileRow[] };
/** What applying a profile switches, and what the host kept ahead of it. */
export type PluginProfileApplyResult = {
  ok: boolean;
  dryRun: boolean;
  profile: string;
  changes: { id: string; enabled: boolean; wasEnabled: boolean; effective: boolean; wasEffective: boolean }[];
  blocked: { id: string; blockedBy: string[] }[];
  warnings: { code: string; id?: string; message: string }[];
};

export type AutomationRecord = {
  id: string; name: string; schedule: string; timezone: string; enabled: boolean;
  workflow: { root: string; name: string; nodes: unknown[]; concurrency?: number };
  approvalRequired: true; approved?: boolean; allowReal?: boolean; nextRunAt: number;
  history: { id: string; at: number; status: string; workflowId?: string; error?: string }[];
};

/** One queued 闲时任务 and its bounded per-attempt history. */
export type OffPeakTaskRecord = {
  id: string; name: string; prompt: string; root: string;
  model: string | null; provider_id: string | null; deadlineSeconds: number;
  onlyWhenIdle: boolean; window: { start: string; end: string } | null; timezone: string | null;
  status: string; createdAt: number; nextEligibleAt: number; holdUntil: number | null;
  approved: boolean; allowReal: boolean; runId: string | null; workflowId: string | null;
  claimedAt: number | null; finishedAt: number | null; digest: string;
  history: { id: string; at: number; status: string; workflowId?: string; error?: string }[];
};

export type OffPeakSettings = {
  window: { start: string; end: string };
  timezone: string | null;
};

export type OffPeakOverview = {
  tasks: OffPeakTaskRecord[];
  settings: OffPeakSettings;
  windowOpen: boolean;
  nextWindowAt: number;
};

/* ------------------------------------------------------------------ */
/* 传输层（复用 xuenessBridge.ts 的 get/post 风格）                     */
/* ------------------------------------------------------------------ */

export async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin", cache: "no-store", ...(signal ? { signal } : {}) });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload as T;
}

/** 写操作统一取 CSRF token 后再发送（GET 因契约不同分开处理）。 */
async function send<T>(method: "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: object, signal?: AbortSignal): Promise<T> {
  const token = await get<{ csrfToken: string }>("/api/csrf", signal);
  signal?.throwIfAborted();
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": token.csrfToken },
    body: body === undefined ? undefined : JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload as T;
}

export async function post<T>(path: string, body: object, signal?: AbortSignal): Promise<T> {
  return send<T>("POST", path, body, signal);
}

export async function cancelSubagentTask(sessionId: string, taskId: string): Promise<{ cancelled: true; taskId: string }> {
  return post<{ cancelled: true; taskId: string }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/tasks/${encodeURIComponent(taskId)}/cancel`,
    {},
  );
}

async function patch<T>(path: string, body: object): Promise<T> {
  return send<T>("PATCH", path, body);
}

async function put<T>(path: string, body: object): Promise<T> {
  return send<T>("PUT", path, body);
}

export async function del<T>(path: string): Promise<T> {
  return send<T>("DELETE", path);
}

/* ------------------------------------------------------------------ */
/* 1. 设置                                                            */
/* ------------------------------------------------------------------ */

/** GET /api/settings → 全部 section 的键值。 */
export async function getSettings(): Promise<SettingsMap> {
  const payload = await get<{ settings: SettingsMap }>("/api/settings");
  return payload.settings ?? {};
}

/** GET /api/settings/<section> */
export async function getSettingsSection(section: string): Promise<SettingsSection> {
  return get<SettingsSection>(`/api/settings/${encodeURIComponent(section)}`);
}

/** POST /api/settings/<section> */
export async function saveSettingsSection(
  section: string,
  values: Record<string, unknown>,
): Promise<SettingsSection> {
  return post<SettingsSection>(`/api/settings/${encodeURIComponent(section)}`, { values });
}

/* ------------------------------------------------------------------ */
/* 2. 资源                                                            */
/* ------------------------------------------------------------------ */

/** GET /api/resources/<kind> → 按 id 升序的条目 + 用户级作用域能力。 */
export async function listResources(kind: string): Promise<ResourceList> {
  const payload = await get<ResourceList>(`/api/resources/${encodeURIComponent(kind)}`);
  return {
    items: payload.items ?? [],
    capability: payload.capability ?? { userScopeAvailable: true },
  };
}

/**
 * GET /api/resources/commands/files → `xueness commands list` 打印的同一份合并清单。
 *
 * 内建提示命令、文件命令与资源条目在这里汇合，所以斜杠候选不需要 UI 侧第二份名单；
 * 被遮蔽的行仍返回（`shadowed`），由调用方决定展示与否。`root` 缺省时只有状态目录
 * 的条目（内建命令要求工作区，故不出现）。
 */
export async function listCommandCatalog(root?: string, language?: string): Promise<CommandCatalogRow[]> {
  const query = new URLSearchParams();
  if (root) query.set("root", root);
  if (language) query.set("language", language);
  const payload = await get<{ commands: CommandCatalogRow[] }>(
    `/api/resources/commands/files${query.size ? `?${query}` : ""}`);
  return payload.commands ?? [];
}

/** POST /api/resources/<kind>，body 至少含 `id`。 */
export type ResourceCreateBody = Record<string, unknown> & {
  /** Reject an existing id atomically instead of applying the legacy upsert. */
  createOnly?: boolean;
};

export async function createResource(
  kind: string,
  body: ResourceCreateBody,
): Promise<{ item: ResourceItem }> {
  return post<{ item: ResourceItem }>(`/api/resources/${encodeURIComponent(kind)}`, body);
}

/**
 * PATCH /api/resources/<kind>/<id>
 *
 * 与已有条目**合并**（只覆盖 body 里出现的键），所以「切换 enabled」不会
 * 抹掉 name / description / body 等既有字段。body 直传。
 */
export async function patchResource(
  kind: string,
  id: string,
  body: Record<string, unknown>,
): Promise<{ item: ResourceItem }> {
  return patch<{ item: ResourceItem }>(
    `/api/resources/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`,
    body,
  );
}

/** DELETE /api/resources/<kind>/<id> */
export async function deleteResource(kind: string, id: string): Promise<{ ok: boolean; id: string }> {
  return del<{ ok: boolean; id: string }>(
    `/api/resources/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`,
  );
}

/**
 * PUT /api/resources/<kind> —— **整体替换**语义（Stage 4 契约）。
 *
 * 请求体 `{ items: [...] }`；列表里不存在的旧条目会被后端删除。任一项 id 非法时
 * 后端返回 400 且**不做任何改动**（先全量校验再落盘），这里按统一风格抛错。
 */
export async function putResource(
  kind: string,
  body: { items: unknown[] },
): Promise<{ items: ResourceItem[] }> {
  const payload = await put<{ items: ResourceItem[] }>(
    `/api/resources/${encodeURIComponent(kind)}`,
    body,
  );
  return { items: Array.isArray(payload.items) ? payload.items : [] };
}

/* ------------------------------------------------------------------ */
/* 3. 供应商                                                          */
/* ------------------------------------------------------------------ */

/** GET /api/providers —— 只返回 hasKey，绝不含 apiKey。 */
export async function listProviders(): Promise<{ providers: ProviderSummary[] }> {
  const payload = await get<{ providers: ProviderSummary[] }>("/api/providers");
  return { providers: payload.providers ?? [] };
}

/** POST /api/providers；body 可含 apiKey（只上行，永不回读）。 */
export async function saveProvider(
  body: Record<string, unknown>,
): Promise<{ provider: ProviderSummary }> {
  return post<{ provider: ProviderSummary }>("/api/providers", body);
}

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

/** providers.default_selection: the stored default model and reasoning level. */
export type DefaultModelSelection = {
  providerId?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
};

/** GET /api/providers/default; ``null`` when nothing was saved or it no longer resolves. */
export async function loadDefaultModelSelection(): Promise<DefaultModelSelection | null> {
  const payload = await get<{ default: DefaultModelSelection | null }>("/api/providers/default");
  return payload.default ?? null;
}

/** POST /api/providers/default; the server validates before storing and answers 400 otherwise. */
export async function saveDefaultModelSelection(
  selection: DefaultModelSelection,
): Promise<DefaultModelSelection | null> {
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

/* ------------------------------------------------------------------ */
/* 4. 用量                                                            */
/* ------------------------------------------------------------------ */

const DEFAULT_USAGE_RANGE = "7d";

/** GET /api/usage?range=7d|30d|all（默认 7d）。 */
export async function getUsage(range: string = DEFAULT_USAGE_RANGE): Promise<UsageSummary> {
  return get<UsageSummary>(`/api/usage?range=${encodeURIComponent(range)}`);
}

/* ------------------------------------------------------------------ */
/* 5. 记忆                                                            */
/* ------------------------------------------------------------------ */

/** GET /api/memory/tracks —— 只读，未设置 XUENESS_MEMORY_ROOT 时为空数组。 */
export async function getMemoryTracks(): Promise<{ tracks: MemoryTrack[] }> {
  const payload = await get<{ tracks: MemoryTrack[] }>("/api/memory/tracks");
  return { tracks: payload.tracks ?? [] };
}

/** GET /api/plugins: locally installed plugin metadata and effective state. */
export async function listPlugins(): Promise<XuenessPluginCatalog> {
  const payload = await get<XuenessPluginCatalog>("/api/plugins");
  if (!Array.isArray(payload.plugins)) throw new Error("Invalid plugin catalog response");
  return { plugins: payload.plugins };
}

/** POST /api/plugins/<id>: enable or disable a plugin; host enforces CSRF. */
export async function setPluginEnabled(id: string, enabled: boolean): Promise<XuenessPluginCatalog> {
  const payload = await post<XuenessPluginCatalog>(`/api/plugins/${encodeURIComponent(id)}`, { enabled });
  if (!Array.isArray(payload.plugins)) throw new Error("Invalid plugin catalog response");
  return { plugins: payload.plugins };
}

export async function listMarketplace(): Promise<{ marketplace: MarketplaceItem[] }> {
  const payload = await get<{ marketplace: MarketplaceItem[] }>("/api/plugins/marketplace");
  if (!Array.isArray(payload.marketplace)) throw new Error("Invalid marketplace response");
  return { marketplace: payload.marketplace };
}
export async function installMarketplaceItem(id: string, sha256: string, update = false): Promise<{ marketplace: MarketplaceItem[] }> {
  const payload = await post<{ marketplace: MarketplaceItem[] }>(`/api/plugins/marketplace/${encodeURIComponent(id)}/${update ? "update" : "install"}`, { sha256 });
  if (!Array.isArray(payload.marketplace)) throw new Error("Invalid marketplace response");
  return { marketplace: payload.marketplace };
}

function profileNames(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** GET /api/plugins/profiles — the selectable pure-data plugin tiers. */
export async function listPluginProfiles(): Promise<PluginProfileCatalog> {
  const payload = await get<{ active?: unknown; profiles?: unknown }>("/api/plugins/profiles");
  if (!Array.isArray(payload.profiles)) throw new Error("Invalid plugin profile response");
  const profiles = payload.profiles.map((item): PluginProfileRow => {
    const row = item as Record<string, unknown>;
    if (!row || typeof row.name !== "string" || !row.name) throw new Error("Invalid plugin profile response");
    return {
      name: row.name,
      source: typeof row.source === "string" ? row.source : "built-in",
      extends: profileNames(row.extends),
      description: typeof row.description === "string" ? row.description : "",
      descriptionEn: typeof row.descriptionEn === "string" ? row.descriptionEn : "",
      enabled: profileNames(row.enabled),
      disabled: profileNames(row.disabled),
      active: row.active === true,
    };
  });
  return { active: typeof payload.active === "string" ? payload.active : null, profiles };
}

/** POST /api/plugins/profiles/apply — choose a tier; explicit user switches stay ahead of it. */
export async function applyPluginProfile(name: string, dryRun = false): Promise<PluginProfileApplyResult> {
  const payload = await post<Record<string, unknown>>("/api/plugins/profiles/apply", { name, dryRun });
  if (payload.ok !== true || !Array.isArray(payload.changes) || !Array.isArray(payload.blocked) || !Array.isArray(payload.warnings)) {
    throw new Error("Invalid plugin profile response");
  }
  return {
    ok: true,
    dryRun: payload.dryRun === true,
    profile: typeof payload.profile === "string" ? payload.profile : name,
    changes: payload.changes as PluginProfileApplyResult["changes"],
    blocked: payload.blocked as PluginProfileApplyResult["blocked"],
    warnings: payload.warnings as PluginProfileApplyResult["warnings"],
  };
}

export async function listAutomations(): Promise<{ automations: AutomationRecord[] }> {
  const payload = await get<{ automations: AutomationRecord[] }>("/api/automations");
  if (!Array.isArray(payload.automations)) throw new Error("Invalid automations response");
  return { automations: payload.automations };
}
export async function createAutomation(data: Omit<AutomationRecord, "id" | "approvalRequired" | "nextRunAt" | "history">): Promise<{ automation: AutomationRecord }> {
  return post<{ automation: AutomationRecord }>("/api/automations", data);
}
export async function updateAutomation(id: string, data: Partial<AutomationRecord>): Promise<{ automation: AutomationRecord }> {
  return post<{ automation: AutomationRecord }>(`/api/automations/${encodeURIComponent(id)}`, data);
}
export async function deleteAutomation(id: string): Promise<{ deleted: string }> {
  return del<{ deleted: string }>(`/api/automations/${encodeURIComponent(id)}`);
}
export async function runAutomation(id: string): Promise<{ run: AutomationRecord["history"][number] & { workflowId: string } }> {
  return post<{ run: AutomationRecord["history"][number] & { workflowId: string } }>(`/api/automations/${encodeURIComponent(id)}/run`, {});
}
export async function approveAutomation(id: string, allowReal: boolean): Promise<{ automation: AutomationRecord }> {
  return post<{ automation: AutomationRecord }>(`/api/automations/${encodeURIComponent(id)}/approve`, { confirmed: true, allowReal });
}

/* 闲时任务（automation.off_peak）：本地低峰窗口队列，纯数据，不引入可执行配置。 */
export async function listOffPeakTasks(): Promise<OffPeakOverview> {
  const payload = await get<OffPeakOverview>("/api/automation/offpeak");
  if (!Array.isArray(payload.tasks)) throw new Error("Invalid off-peak queue response");
  return payload;
}
export async function createOffPeakTask(data: Record<string, unknown>): Promise<{ task: OffPeakTaskRecord }> {
  return post<{ task: OffPeakTaskRecord }>("/api/automation/offpeak", data);
}
export async function cancelOffPeakTask(id: string): Promise<{ cancelled: string }> {
  return del<{ cancelled: string }>(`/api/automation/offpeak/${encodeURIComponent(id)}`);
}
export async function runOffPeakTask(id: string): Promise<{ result: { id: string; status: string; error?: string; workflowId?: string } }> {
  return post<{ result: { id: string; status: string; error?: string; workflowId?: string } }>(`/api/automation/offpeak/${encodeURIComponent(id)}/run`, {});
}
/** 批准绑定已保存计划的摘要；真实服务商仍由主机决定是否放行。 */
export async function approveOffPeakTask(id: string, allowReal: boolean): Promise<{ task: OffPeakTaskRecord }> {
  return post<{ task: OffPeakTaskRecord }>(`/api/automation/offpeak/${encodeURIComponent(id)}/approve`, { confirmed: true, allowReal });
}
export async function getOffPeakSettings(): Promise<{ settings: OffPeakSettings }> {
  return get<{ settings: OffPeakSettings }>("/api/automation/offpeak/settings");
}
export async function saveOffPeakSettings(window: OffPeakSettings["window"], timezone: string | null): Promise<{ settings: OffPeakSettings }> {
  return post<{ settings: OffPeakSettings }>("/api/automation/offpeak/settings", { window, timezone });
}

/* ------------------------------------------------------------------ */
/* 6. 目录浏览（DSH browse 能力的客户端侧）                             */
/* ------------------------------------------------------------------ */

/** 目录条目：宿主给出绝对路径，客户端不自己拼接路径段。 */
export type DirectoryEntry = {
  name: string;
  path: string;
  /** "directory" | "file"；选择器默认只收到目录，文件树会收到两者。 */
  type?: "directory" | "file";
  hidden: boolean;
  isSymbolicLink?: boolean;
};

/** 一个目录层级 + 祖先链。 */
export type DirectoryListing = {
  path: string;
  home: string;
  crumbs: DirectoryEntry[];
  entries: DirectoryEntry[];
  truncated: boolean;
};

/** GET /api/system —— 宿主账号的 home，作为选择器的起始锚点。 */
export async function getSystemHome(): Promise<{ homedir: string }> {
  return get<{ homedir: string }>("/api/system");
}

/**
 * GET /api/directory —— 列出目录层级。
 *
 * `includeFiles` 默认关：目录选择器只走目录（对齐 DSH 的 browse 语义）。
 * 工作区文件树需要文件和目录并列，显式打开。
 */
export async function listDirectory(
  path?: string,
  includeHidden = false,
  includeFiles = false,
): Promise<DirectoryListing> {
  const query = new URLSearchParams();
  if (path) query.set("path", path);
  if (includeHidden) query.set("includeHidden", "1");
  if (includeFiles) query.set("includeFiles", "1");
  const suffix = query.toString() ? `?${query.toString()}` : "";
  return get<DirectoryListing>(`/api/directory${suffix}`);
}

/** POST /api/directory —— 在已有父目录下建一个子目录（非递归）。 */
export async function createDirectory(path: string, name: string): Promise<{ path: string }> {
  return post<{ path: string }>("/api/directory", { path, name });
}
