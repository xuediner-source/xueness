/**
 * Capabilities data layer: the six harness resource kinds the backend has
 * served all along (`/api/resources/<kind>`), finally consumed by the UI.
 *
 * Thin Result-typed wrapper over `xuenessApi` — the transport (same-origin,
 * CSRF two-step for PATCH, non-2xx → throw) lives there. Like
 * `xuenessWorkspace`, failures surface as `{ok:false, error}` so the panel can
 * show the real state instead of a lying empty list.
 *
 * Scope note: since Batch10 this layer also exposes create/delete (the backend
 * endpoints existed all along) plus per-kind editable-field metadata used by
 * the create/edit dialog.
 */
import type { Result } from "./xuenessWorkbench";
import { createResource, deleteResource, listResources, patchResource } from "./xuenessApi";

export const CAPABILITY_KINDS = ["mcp", "skills", "commands", "hooks", "subagents", "plugins"] as const;
export type CapabilityKind = (typeof CAPABILITY_KINDS)[number];

export type CapabilityItem = {
  id: string;
  enabled?: boolean;
  updatedAt?: string;
  description?: string;
  event?: string;
  command?: string;
  /** kind-specific remainder (config fields), trimmed for display. */
  extra?: Record<string, unknown>;
};

export type CapabilitySectionData = {
  kind: CapabilityKind;
  items: CapabilityItem[];
  userScopeAvailable: boolean;
  /** Fail-soft reason string when user scope is unavailable ("" when unknown). */
  userScopeReason?: string;
};

export const CAPABILITY_LABELS: Record<CapabilityKind, string> = {
  mcp: "MCP",
  skills: "技能",
  commands: "命令",
  hooks: "Hooks",
  subagents: "子代理",
  plugins: "插件",
};

/** Normalise any thrown value into the error text the Result contract carries. */
function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Known keys lifted out of a raw resource item; everything else lands in extra. */
const ITEM_KNOWN_KEYS = ["id", "enabled", "updatedAt", "description", "event", "command"] as const;

function toCapabilityItem(raw: Record<string, unknown>): CapabilityItem | null {
  const id = raw.id;
  if (typeof id !== "string" || !id.trim()) return null;
  const item: CapabilityItem = { id };
  if (typeof raw.enabled === "boolean") item.enabled = raw.enabled;
  if (typeof raw.updatedAt === "string") item.updatedAt = raw.updatedAt;
  if (typeof raw.description === "string") item.description = raw.description;
  if (typeof raw.event === "string") item.event = raw.event;
  if (typeof raw.command === "string") item.command = raw.command;
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    // `body` can be arbitrarily long prompt text; the panel never shows it, so
    // it is dropped here rather than carried around.
    if (key === "body" || (ITEM_KNOWN_KEYS as readonly string[]).includes(key)) continue;
    extra[key] = value;
  }
  if (Object.keys(extra).length > 0) item.extra = extra;
  return item;
}

function assertKind(kind: CapabilityKind): void {
  if (!(CAPABILITY_KINDS as readonly string[]).includes(kind)) {
    throw new TypeError(`unknown capability kind: ${kind}`);
  }
}

export async function loadCapabilitySection(kind: CapabilityKind): Promise<Result<CapabilitySectionData>> {
  // Programming errors (bad kind) throw before any IO; only transport/runtime
  // failures become Result errors.
  assertKind(kind);
  try {
    const payload = await listResources(kind);
    const items: CapabilityItem[] = [];
    for (const raw of payload.items) {
      if (typeof raw !== "object" || raw === null) continue;
      const item = toCapabilityItem(raw as Record<string, unknown>);
      if (item) items.push(item);
    }
    items.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return {
      ok: true,
      value: {
        kind,
        items,
        userScopeAvailable: payload.capability?.userScopeAvailable === true,
        userScopeReason:
          typeof payload.capability?.userScopeReason === "string"
            ? payload.capability.userScopeReason
            : "",
      },
    };
  } catch (error) {
    return { ok: false, error: toErrorMessage(error) };
  }
}

export async function toggleCapabilityItem(
  kind: CapabilityKind,
  id: string,
  enabled: boolean,
): Promise<Result<CapabilityItem>> {
  assertKind(kind);
  if (!id.trim()) throw new TypeError("capability id must be non-empty");
  try {
    // PATCH merges only the keys present, so toggling `enabled` cannot clobber
    // description/config fields stored on the item.
    const payload = await patchResource(kind, id, { enabled });
    const item = toCapabilityItem(payload.item ?? {});
    if (!item) return { ok: false, error: "toggle returned no usable item" };
    return { ok: true, value: item };
  } catch (error) {
    return { ok: false, error: toErrorMessage(error) };
  }
}

/** Local-timezone "yyyy-mm-dd hh:mm" rendering; "" when absent/invalid. */
export function formatCapabilityTime(value?: string): string {
  if (typeof value !== "string" || !value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Compact, bounded rendering of a kind-specific extra payload. */
export function summarizeExtra(extra?: Record<string, unknown>): string {
  if (!extra || Object.keys(extra).length === 0) return "";
  try {
    const text = JSON.stringify(extra);
    return text.length > 120 ? `${text.slice(0, 120)}…` : text;
  } catch {
    return "";
  }
}

/* ------------------------------------------------------------------ */
/* Batch10: create / delete + editable-field metadata                  */
/* ------------------------------------------------------------------ */

/**
 * Mirror of the backend id rule (`resources.py`): `^[A-Za-z0-9._-]{1,64}$`,
 * without any `..` segment. Returns "" when valid, otherwise a user-facing
 * Chinese message. Full regex validation lives in the dialog (the user's
 * typing); the data layer only rejects blank ids as programming errors.
 */
export function validateCapabilityId(id: string): string {
  if (!id.trim()) return "ID 不能为空";
  if (id.length > 64) return "ID 不能超过 64 个字符";
  if (!/^[A-Za-z0-9._-]+$/.test(id)) return "ID 只能包含字母、数字、点、下划线和连字符";
  if (id === "." || id.includes("..")) return "ID 不能是点号或包含连续点号";
  return "";
}

export async function createCapabilityItem(
  kind: CapabilityKind,
  input: { id: string; createOnly?: boolean } & Record<string, unknown>,
): Promise<Result<CapabilityItem>> {
  assertKind(kind);
  if (!input.id.trim()) throw new TypeError("capability id must be non-empty");
  try {
    const payload = await createResource(kind, input as Record<string, unknown>);
    const item = toCapabilityItem(payload.item ?? {});
    if (!item) return { ok: false, error: "create returned no usable item" };
    return { ok: true, value: item };
  } catch (error) {
    return { ok: false, error: toErrorMessage(error) };
  }
}

export async function deleteCapabilityItem(
  kind: CapabilityKind,
  id: string,
): Promise<Result<void>> {
  assertKind(kind);
  if (!id.trim()) throw new TypeError("capability id must be non-empty");
  try {
    await deleteResource(kind, id);
    return { ok: true, value: undefined };
  } catch (error) {
    return { ok: false, error: toErrorMessage(error) };
  }
}

/** One editable field of a kind: how the dialog renders and labels it. */
export type CapabilityFieldSpec = {
  key: string;
  label: string;
  kind: "text" | "textarea" | "boolean" | "json";
  required?: boolean;
  placeholder?: string;
};

/**
 * Per-kind editable fields for the create/edit dialog. The id is handled
 * separately by the dialog, so it is deliberately absent here. Fields the
 * backend accepts but we do not commit to (mcp custom config, subagent
 * prompt, …) stay unlisted — the API layer passes bodies through as-is.
 *
 * `hooks.event` mirrors HOOK_EVENTS at the top of `xueness/hooks.py`; the
 * field renders as text (no select type) with the valid values in its
 * placeholder.
 */
export const CAPABILITY_FIELD_SPECS: Record<CapabilityKind, CapabilityFieldSpec[]> = {
  skills: [
    { key: "name", label: "名称", kind: "text" },
    { key: "description", label: "描述", kind: "text", required: true, placeholder: "这个技能做什么（一句话）" },
    { key: "body", label: "正文", kind: "textarea", placeholder: "技能正文（Markdown）" },
    { key: "enabled", label: "启用", kind: "boolean" },
  ],
  commands: [
    { key: "description", label: "描述", kind: "text", placeholder: "这个命令做什么（一句话）" },
    { key: "body", label: "模板正文", kind: "textarea", placeholder: "命令模板正文" },
    { key: "enabled", label: "启用", kind: "boolean" },
  ],
  hooks: [
    {
      key: "event",
      label: "事件",
      kind: "text",
      required: true,
      placeholder: "SessionStart / UserPromptSubmit / PreToolUse / PermissionRequest / PostToolUse / PostToolUseFailure / Stop",
    },
    { key: "command", label: "命令", kind: "text", required: true, placeholder: "例如 python3 hook.py" },
    { key: "enabled", label: "启用", kind: "boolean" },
  ],
  mcp: [
    { key: "transport", label: "传输方式", kind: "text", placeholder: "stdio / http" },
    { key: "command", label: "程序路径", kind: "text", placeholder: "python3" },
    { key: "args", label: "参数 JSON", kind: "json", placeholder: '["server.py"]' },
    { key: "url", label: "HTTP URL", kind: "text", placeholder: "https://example.com/mcp" },
    { key: "headersEnv", label: "认证环境变量 JSON", kind: "json", placeholder: '{"Authorization":"MCP_AUTH"}' },
    { key: "allowLoopbackHttp", label: "允许本机 HTTP", kind: "boolean" },
    { key: "elicitation", label: "允许 MCP 询问少量信息", kind: "boolean" },
    { key: "description", label: "描述", kind: "text", placeholder: "这个服务器做什么（可选）" },
    { key: "enabled", label: "启用", kind: "boolean" },
  ],
  subagents: [
    { key: "name", label: "名称", kind: "text" },
    { key: "systemPrompt", label: "子代理指令", kind: "textarea" },
    { key: "description", label: "描述", kind: "text", placeholder: "这个子代理负责什么（可选）" },
    { key: "enabled", label: "启用", kind: "boolean" },
  ],
  plugins: [
    { key: "name", label: "名称", kind: "text", required: true },
    { key: "description", label: "描述", kind: "textarea", placeholder: "这个内置适配器做什么（可选）" },
    { key: "version", label: "版本", kind: "text", required: true, placeholder: "1.0.0" },
    { key: "apiVersion", label: "API 版本", kind: "text", required: true, placeholder: "1" },
    { key: "builtin", label: "内置能力", kind: "text", required: true, placeholder: "skills / hooks / subagents / mcp" },
    { key: "capabilities", label: "权限声明 JSON", kind: "json", placeholder: '["network"]' },
    { key: "enabled", label: "启用清单", kind: "boolean" },
  ],
};

const PLUGIN_BUILTINS = new Set(["skills", "hooks", "subagents", "mcp"]);
const PLUGIN_CAPABILITIES = new Set(["command", "network", "filesystem-write"]);
const PLUGIN_IMPORT_KEYS = new Set([
  "id", "name", "description", "version", "apiVersion", "builtin", "capabilities", "enabled",
]);

function parsedPluginCapabilities(value: unknown): string[] | null {
  let parsed = value;
  if (typeof value === "string") {
    if (!value.trim()) return [];
    try { parsed = JSON.parse(value); } catch { return null; }
  }
  if (parsed === undefined || parsed === null) return [];
  if (!Array.isArray(parsed) || parsed.some(item => typeof item !== "string" || !PLUGIN_CAPABILITIES.has(item))) return null;
  return [...new Set(parsed as string[])];
}

/** Validate the data-only manifest contract supported by xueness.plugin_sdk. */
export function validatePluginManifestDraft(id: string, fields: Record<string, unknown>): string {
  const idError = validateCapabilityId(id);
  if (idError) return idError;
  if (fields.entrypoint || fields.command) return "外部插件代码需要单独审查，清单不能包含 entrypoint 或 command";
  if (fields.name !== undefined && (typeof fields.name !== "string" || fields.name.length > 120)) return "插件名称必须是 120 字以内的文本";
  if (fields.description !== undefined && (typeof fields.description !== "string" || fields.description.length > 500)) return "插件描述必须是 500 字以内的文本";
  if (typeof fields.version !== "string" || !/^\d+\.\d+\.\d+$/.test(fields.version.trim())) return "版本号必须使用 MAJOR.MINOR.PATCH 格式";
  if (fields.apiVersion !== 1 && fields.apiVersion !== "1") return "API 版本必须为 1";
  if (typeof fields.builtin !== "string" || !PLUGIN_BUILTINS.has(fields.builtin.trim())) return "内置能力必须是 skills、hooks、subagents 或 mcp";
  if (parsedPluginCapabilities(fields.capabilities) === null) return "权限声明只能包含 command、network、filesystem-write 的 JSON 数组";
  return "";
}

/** Parse one import file as an SDK-compatible data manifest, always disabled. */
export function parsePluginManifestImport(text: string): Result<{ id: string; fields: Record<string, unknown> }> {
  if (text.length > 256 * 1024) return { ok: false, error: "插件清单不能超过 256 KiB" };
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return { ok: false, error: "JSON 配置格式无效" }; }
  if (!raw || Array.isArray(raw) || typeof raw !== "object") return { ok: false, error: "导入文件必须是一个 JSON 清单对象" };
  const source = raw as Record<string, unknown>;
  if (Object.keys(source).some(key => !PLUGIN_IMPORT_KEYS.has(key))) return { ok: false, error: "插件清单包含不支持的字段" };
  if ((source.name !== undefined && typeof source.name !== "string") ||
      (source.description !== undefined && typeof source.description !== "string") ||
      (source.enabled !== undefined && typeof source.enabled !== "boolean")) {
    return { ok: false, error: "插件清单的名称、描述或启用状态类型无效" };
  }
  const id = typeof source.id === "string" ? source.id.trim() : "";
  const fields: Record<string, unknown> = {
    name: typeof source.name === "string" ? source.name : id,
    description: typeof source.description === "string" ? source.description : "",
    version: source.version,
    apiVersion: source.apiVersion,
    builtin: source.builtin,
    capabilities: source.capabilities ?? [],
    // Imports are inert until the user explicitly enables the stored manifest.
    enabled: false,
  };
  const error = validatePluginManifestDraft(id, fields);
  if (error) return { ok: false, error };
  const capabilities = parsedPluginCapabilities(fields.capabilities);
  return {
    ok: true,
    value: {
      id,
      fields: {
        ...fields,
        version: (fields.version as string).trim(),
        apiVersion: 1,
        builtin: (fields.builtin as string).trim(),
        capabilities: capabilities ?? [],
        enabled: false,
      },
    },
  };
}

/** Field-level edit (PATCH merge), Result-wrapped like the rest of this layer. */
export async function updateCapabilityFields(
  kind: CapabilityKind,
  id: string,
  fields: Record<string, unknown>,
): Promise<Result<CapabilityItem>> {
  assertKind(kind);
  if (!id.trim()) throw new TypeError("capability id must be non-empty");
  try {
    const payload = await patchResource(kind, id, fields);
    const item = toCapabilityItem(payload.item ?? {});
    if (!item) return { ok: false, error: "update returned no usable item" };
    return { ok: true, value: item };
  } catch (error) {
    return { ok: false, error: toErrorMessage(error) };
  }
}
