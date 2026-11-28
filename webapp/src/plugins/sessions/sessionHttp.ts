/**
 * Same-origin transport for the sessions data layer. Any non-2xx or unreadable
 * body becomes a thrown Error that the exported API wrappers catch into
 * `{ok:false, error}`; it never escapes as an exception to the UI.
 */
import { t as tr, tf as trf } from '../../i18n';
import { createSessionHttpError, createSessionNetworkError, createUnreadableSessionResponseError, friendlyModelSetupError } from './sessionRequestErrors';

export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function requestJson<T>(path: string, init: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, init);
  } catch (error) {
    if (init.signal?.aborted) throw init.signal.reason ?? error;
    if (error instanceof TypeError) throw createSessionNetworkError(error);
    throw error;
  }
  let payload: unknown;
  let jsonParsed = true;
  let jsonError: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    if (init.signal?.aborted) throw init.signal.reason ?? error;
    jsonParsed = false;
    jsonError = error;
  }
  if (!response.ok) {
    const detail = (payload as { error?: unknown } | null | undefined)?.error;
    const code = (payload as { error_code?: unknown } | null | undefined)?.error_code;
    const errorCode = typeof code === 'string' && code.trim() ? code : undefined;
    const backendDetail = typeof detail === 'string' && detail.trim() ? detail : undefined;
    const appendDetail = (message: string) => backendDetail ? trf('{0}\n服务器说明：{1}', [message, backendDetail]) : message;
    if (code === 'yolo_confirmation_required') {
      throw createSessionHttpError(response.status, errorCode, backendDetail, appendDetail(tr('发送前需要确认完全访问，请重新发送并完成确认。')));
    }
    if (code === 'message_action_conflict') {
      const message = String(detail);
      if (message.includes('conversation changed')) throw createSessionHttpError(response.status, errorCode, backendDetail, appendDetail(tr('会话已发生变化。请刷新后重新编辑；当前输入已保留。')));
      if (message.includes('queued messages')) throw createSessionHttpError(response.status, errorCode, backendDetail, appendDetail(tr('请先处理或取消排队消息，再编辑历史。')));
      if (message.includes('run already in progress')) throw createSessionHttpError(response.status, errorCode, backendDetail, appendDetail(tr('会话正在运行，结束后可修改历史。')));
    }
    if (backendDetail && friendlyModelSetupError(backendDetail) !== backendDetail) {
      throw createSessionHttpError(response.status, errorCode, backendDetail, friendlyModelSetupError(backendDetail));
    }
    throw createSessionHttpError(response.status, errorCode, backendDetail);
  }
  if (!jsonParsed) throw createUnreadableSessionResponseError(response.status, jsonError);
  return payload as T;
}

export async function requestGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const cancel = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const timer = setTimeout(() => controller.abort(new DOMException(tr('读取超时，请稍后重试。'), 'TimeoutError')), 20000);
  try {
    return await requestJson<T>(path, { credentials: "same-origin", cache: "no-store", signal: controller.signal });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}

/** Every mutation fetches a fresh CSRF token first and sends it as a header. */
export async function requestMutation<T>(method: "POST" | "PATCH" | "DELETE", path: string, body: unknown, signal?: AbortSignal, beforeSend?: () => boolean): Promise<T> {
  let token: { csrfToken?: string };
  try { token = await requestGet<{ csrfToken?: string }>("/api/csrf", signal); }
  catch (error) { if (error instanceof Error) Object.assign(error, { requestNotSent: true }); throw error; }
  const csrfToken = typeof token?.csrfToken === "string" ? token.csrfToken : "";
  if (!csrfToken) throw new Error("missing csrf token");
  if (signal?.aborted) throw Object.assign(signal.reason instanceof Error ? signal.reason : new Error('Request cancelled'), { requestNotSent: true });
  if (beforeSend && !beforeSend()) throw Object.assign(new Error('Request is no longer enabled'), { requestNotSent: true });
  return requestJson<T>(path, {
    method,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
}

export function requestPost<T>(path: string, body: unknown, signal?: AbortSignal, beforeSend?: () => boolean): Promise<T> {
  return requestMutation<T>("POST", path, body, signal, beforeSend);
}

export function sessionPath(id: string, suffix = ""): string {
  return `/api/sessions/${encodeURIComponent(id)}${suffix}`;
}
