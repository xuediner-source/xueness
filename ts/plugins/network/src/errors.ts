/** `transport.NetworkError`: a safe, user-actionable failure and its result shape. */
export type Row = Record<string, unknown>;

export class NetworkError extends Error {
  override name = "NetworkError";
  readonly code: string;
  readonly retryable: boolean;
  readonly reason: string;
  readonly httpStatus: number | null;
  constructor(code: string, retryable: boolean, reason: string, httpStatus: number | null = null) {
    super(reason);
    this.code = code; this.retryable = retryable; this.reason = reason; this.httpStatus = httpStatus;
  }

  /** `NetworkError.as_result()`. */
  asResult(): Row {
    const result: Row = { ok: false, error: this.code, error_code: this.code, retryable: this.retryable, user_reason: this.reason, reason: this.reason };
    if (this.httpStatus !== null) result.http_status = this.httpStatus;
    return result;
  }
}

/** What Python's `except (NetworkError, ValueError, OSError)` turns any other failure into. */
export const SETTINGS_UNAVAILABLE = (): NetworkError => new NetworkError("network_settings_unavailable", false,
  "网络工具设置无法读取。请检查插件设置文件权限，或在网络搜索设置中重新保存配置。");
