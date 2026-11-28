/**
 * Xueness 核心客户端 API 入口与兼容转出口层。
 *
 * - 核心域（传输、设置、资源、记忆、插件目录）留在本文件或 `xuenessBridge.ts`；
 * - 插件域（供应商、用量、扩展市场、自动化、子代理、目录浏览）按所属插件
 *   分拆在 `plugins/<id>/*Api.ts`，同时从此处完整转出，保持既有调用方与测试契约不变。
 */
import { del, get, patch, post } from "./xuenessBridge";

export { readJsonResponse, get, post, put, del } from "./xuenessBridge";
export * from "./plugins/providers/providerApi";
export * from "./plugins/usage/usageApi";
export * from "./plugins/extensions/extensionsApi";
export * from "./plugins/automation/automationApi";
export * from "./plugins/subagents/subagentsApi";
export * from "./plugins/files/directoryApi";

export type ResourceItem = {
  id: string;
  createdAt: string;
  updatedAt: string;
  [k: string]: unknown;
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

export type XuenessPluginFeature = {
  id: string;
  name: string;
  nameEn?: string;
};

/** Host plugin catalog. These records describe locally installed modules; they
 * never contain executable frontend code. The UI maps IDs through its own
 * allowlisted registry before exposing panels. */
export type XuenessPlugin = {
  /** `category`: `bundled` ships inside the app; `center` is official and downloaded on demand from the plugin center. */
  installed?: boolean;
  category?: "bundled" | "center";
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

/** GET /api/settings → 全部 section 的键值。 */
export async function getSettings(signal?: AbortSignal): Promise<SettingsMap> {
  const payload = await get<{ settings: SettingsMap }>("/api/settings", signal);
  return payload.settings ?? {};
}

/** POST /api/settings/<section> */
export async function saveSettingsSection(
  section: string,
  values: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<SettingsSection> {
  return post<SettingsSection>(`/api/settings/${encodeURIComponent(section)}`, { values }, signal);
}

/** GET /api/resources/<kind> → 按 id 升序的条目 + 用户级作用域能力。 */
export async function listResources(kind: string, signal?: AbortSignal): Promise<ResourceList> {
  const payload = await get<ResourceList>(`/api/resources/${encodeURIComponent(kind)}`, signal);
  return {
    items: payload.items ?? [],
    capability: payload.capability ?? { userScopeAvailable: true },
  };
}

/**
 * GET /api/resources/commands/files → `xueness commands list` 打印的同一份合并清单。
 */
export async function listCommandCatalog(root?: string, language?: string): Promise<CommandCatalogRow[]> {
  const query = new URLSearchParams();
  if (root) query.set("root", root);
  if (language) query.set("language", language);
  const payload = await get<{ commands: CommandCatalogRow[] }>(
    `/api/resources/commands/files${query.size ? `?${query}` : ""}`,
  );
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

/** PATCH /api/resources/<kind>/<id> */
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
