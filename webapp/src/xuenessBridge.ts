import { isPermissionMode, type PermissionMode } from "./plugins/sessions/permissionModes";

/** 后端 session_events() 派生的只读事件尾；payload 都是截断摘要，不含文件正文。 */
export type XuenessEvent =
  | { type: "status"; status: string; steps: number }
  | { type: "user"; preview: string }
  | { type: "assistant"; preview: string }
  | { type: "tool_call"; id: string; name: string; subject: string }
  | { type: "tool_result"; id: string; subject: string; ok: boolean; error: string }
  | { type: "completion"; verified: boolean; summary: string }
  | { type: "pending_question"; question: string };

// Browser-only run choices. Never store credentials or bypass the server's
// model/permission gates; credentials remain on the host.
export type RunChoices = {
  provider: "real";
  mode: "build" | "plan";
  permission_mode?: PermissionMode;
  /** Set only after the sessions plugin's explicit full-access confirmation. */
  acknowledge_yolo?: boolean;
  provider_id?: string;
  model?: string;
  runtime_profile?: "standard" | "lightweight";
  reasoning_effort?: string;
  skill_catalog?: boolean;
  browser?: boolean;
  goal?: boolean;
  remote?: string;
};
let runChoices: RunChoices = { provider: "real", mode: "build", permission_mode: "build", browser: false };

/** Clear a profile override when the user changes provider; that provider's saved default then applies. */
export function mergeRunChoices(current: RunChoices, patch: Partial<RunChoices>): RunChoices {
  const next = { ...current, ...patch };
  if ("permission_mode" in patch && !("acknowledge_yolo" in patch)) {
    next.acknowledge_yolo = patch.permission_mode === "yolo"
      ? current.permission_mode === "yolo" && current.acknowledge_yolo === true
      : false;
  }
  if ("provider_id" in patch && patch.provider_id !== current.provider_id && !("runtime_profile" in patch)) {
    next.runtime_profile = undefined;
  }
  return next;
}

export function setRunChoices(choices: RunChoices): void {
  if (choices.provider !== "real" || !(["build", "plan"] as string[]).includes(choices.mode) ||
      (choices.permission_mode !== undefined && !isPermissionMode(choices.permission_mode))) {
    throw new Error("invalid run choices");
  }
  if ((choices.acknowledge_yolo !== undefined && typeof choices.acknowledge_yolo !== "boolean") ||
      (choices.acknowledge_yolo === true && choices.permission_mode !== "yolo")) {
    throw new Error("invalid yolo acknowledgement");
  }
  if (choices.runtime_profile !== undefined &&
      choices.runtime_profile !== "standard" && choices.runtime_profile !== "lightweight") {
    throw new Error("invalid runtime profile");
  }
  runChoices = { ...choices };
}
export function getRunChoices(): RunChoices { return { ...runChoices }; }

/**
 * 统一解析 JSON 响应。反向代理/网关在后端不可用时常返回 HTML 或空体（502/504），
 * 直接 response.json() 会抛出难懂的 SyntaxError；这里改为给出 HTTP 状态码。
 * 读取被中止（AbortError）时照常向上抛出。
 */
export async function readJsonResponse<T>(response: Response): Promise<T> {
  let payload: unknown;
  let parsed = true;
  try {
    payload = await response.json();
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    parsed = false;
  }
  if (!response.ok) {
    const detail = (payload as { error?: unknown } | null | undefined)?.error;
    throw new Error(typeof detail === "string" && detail ? detail : `HTTP ${response.status}`);
  }
  if (!parsed) throw new Error("invalid JSON response");
  return payload as T;
}

export async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin", cache: "no-store", ...(signal ? { signal } : {}) });
  return readJsonResponse<T>(response);
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
  return readJsonResponse<T>(response);
}

export async function post<T>(path: string, body: object, signal?: AbortSignal): Promise<T> {
  return send<T>("POST", path, body, signal);
}

export async function put<T>(path: string, body: object, signal?: AbortSignal): Promise<T> {
  return send<T>("PUT", path, body, signal);
}

export async function patch<T>(path: string, body: object, signal?: AbortSignal): Promise<T> {
  return send<T>("PATCH", path, body, signal);
}

export async function del<T>(path: string, signal?: AbortSignal): Promise<T> {
  return send<T>("DELETE", path, undefined, signal);
}

/**
 * 运行时能力开关（设置页「Agent 能力」分区）。
 *
 * 默认全关：任何读取失败都返回 {}，而后端把缺失当作 false。
 * 这些能力会 spawn 子进程或嵌套模型调用，不能因为一次设置读取失败就默认打开。
 */
export async function readRunOptIns(signal?: AbortSignal): Promise<{
  allow_mcp?: boolean;
  allow_subagents?: boolean;
  allow_hooks?: boolean;
}> {
  try {
    const payload = await get<{ values?: Record<string, unknown> }>("/api/settings/agent", signal);
    const values = payload?.values ?? {};
    return {
      allow_mcp: values.allowMcp === true,
      allow_subagents: values.allowSubagents === true,
      allow_hooks: values.allowHooks === true,
    };
  } catch {
    // Fail closed: an unreadable setting must never enable a capability.
    return {};
  }
}
