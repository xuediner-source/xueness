import { t as tr, tf } from '../../i18n';

export interface SessionRequestErrorOptions {
  status?: number;
  errorCode?: string;
  detail?: string;
  responseUnreadable?: boolean;
  cause?: unknown;
}

/** A user-readable request error that retains the server's machine-readable response fields. */
export class SessionRequestError extends Error {
  readonly status?: number;
  readonly errorCode?: string;
  readonly detail?: string;
  readonly responseUnreadable?: boolean;

  constructor(message: string, options: SessionRequestErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'SessionRequestError';
    this.status = options.status;
    this.errorCode = options.errorCode;
    this.detail = options.detail;
    this.responseUnreadable = options.responseUnreadable;
    // Keep the wire spelling available to existing callers inspecting API-shaped errors.
    if (options.errorCode !== undefined) Object.assign(this, { error_code: options.errorCode });
  }
}

export function sessionHttpFailureMessage(status: number): string {
  if (status === 400 || status === 422) return tr('请求内容不符合要求。请检查输入后重试。');
  if (status === 401 || status === 403) return tr('当前操作未获允许。请确认会话仍可用，然后重试。');
  if (status === 404) return tr('找不到这项会话操作。请刷新会话后再试；如果会话已删除，请重新打开。');
  if (status === 408) return tr('请求等待超时，结果可能尚未同步。请先检查会话状态，再决定是否重试。');
  if (status === 409) return tr('会话状态刚刚发生变化。请刷新会话，确认当前状态后再试。');
  if (status === 413) return tr('内容太大，暂时无法处理。请缩短输入或移除较大的附件后重试。');
  if (status === 429) return tr('请求过于频繁。请稍等片刻，检查会话状态后再试。');
  if (status >= 500) return tr('服务暂时无法完成这项操作。请先检查会话和回执，再决定是否重试。');
  return tf('请求未能完成（状态 {0}）。请检查会话状态后再试。', [status]);
}

export function createSessionHttpError(
  status: number,
  errorCode?: string,
  detail?: string,
  message?: string,
): SessionRequestError {
  const readableDetail = typeof detail === 'string' && detail.trim() ? detail : undefined;
  return new SessionRequestError(message ?? readableDetail ?? sessionHttpFailureMessage(status), {
    status,
    errorCode,
    detail: readableDetail,
  });
}

/** Network failures can happen after a mutation was accepted; keep TypeError for retry/recovery semantics. */
export function createSessionNetworkError(cause: TypeError): TypeError {
  return new TypeError(tr('网络连接中断，暂时无法确认这项操作的结果。请先检查会话状态；如果刚发送了内容，请查看回执后再决定是否重试。'), { cause });
}

export function createUnreadableSessionResponseError(status: number, cause: unknown): SessionRequestError {
  return new SessionRequestError(tr('服务器返回的数据无法读取，结果暂时无法确认。请先检查会话状态和回执，再决定是否重试。'), {
    status,
    responseUnreadable: true,
    cause,
  });
}
