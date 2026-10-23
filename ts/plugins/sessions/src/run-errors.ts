import { ProviderCallbackError, ProviderRequestError } from "@xueness/providers";
import { isPyOSError, storeStage } from "@xueness/sessions";
import type { SessionReply } from "./http-api.ts";
const PRESENTATION: Record<string, [string, number, string]> = {
  quota_exhausted: ["provider_quota_exhausted", 503, "上游报告账户额度已用尽，请等待额度恢复或切换到仍可用的模型"],
  unsupported_region: ["provider_unsupported_region", 502, "The model service is unavailable from this network region"],
  context_overflow: ["provider_context_overflow", 502, "The conversation exceeds the model context limit; compact it or start a new conversation"],
  request_rejected: ["provider_request_rejected", 502, "The model service rejected the request"],
  authentication_failed: ["provider_authentication_failed", 502, "模型服务拒绝了认证，请检查供应商设置中的 API 密钥或订阅授权信息"],
  endpoint_not_found: ["provider_endpoint_not_found", 502, "The model service endpoint was not found"], timeout: ["provider_timeout", 504, "The model request timed out"],
  rate_limited: ["provider_rate_limited", 503, "The model service rate-limited the request"], service_unready: ["provider_service_unready", 503, "The model service is not ready"],
  upstream_failure: ["provider_upstream_failure", 502, "The model service returned an error"], connection_failed: ["provider_connection_failed", 502, "Could not connect to the model service"],
  invalid_response: ["provider_invalid_response", 502, "The model service returned an invalid response"], http_error: ["provider_http_error", 502, "The model service returned an HTTP error"], request_failed: ["provider_request_failed", 502, "The model request failed"],
};
export function runErrorResponse(error: unknown, traceId: string): SessionReply {
  if (error instanceof Error && error.name === "QueueRunError" && "status" in error && Number.isInteger(error.status) && Number(error.status) >= 400 && Number(error.status) < 600) return [Number(error.status), { error: error.message }];
  if (error instanceof ProviderRequestError) {
    let [code, status, message] = PRESENTATION[error.category] ?? PRESENTATION.request_failed!;
    const trace = error.traceId || traceId;
    if (error.contextOverflow) { code = "provider_context_limit"; message = "The model service rejected the request due to a context limit"; }
    const reset = error.category === "quota_exhausted" ? error.quotaResetAt : null;
    if (reset) message += "。上游报告额度重置时间：" + reset;
    if (error.status !== null) message += ` (HTTP ${error.status})`;
    return [status, { error: `${message} (reference ${trace})`, error_code: code, trace_id: trace, ...(error.status !== null ? { upstream_status: error.status } : {}), ...(reset ? { quota_reset_at: reset } : {}) }];
  }
  if (error instanceof ProviderCallbackError) return [500, { error: `Local stream callback failed (reference ${error.traceId})`, error_code: "local_stream_callback_failed", trace_id: error.traceId }];
  const stage = storeStage(error), code = stage ? "session_persistence_failed" : isPyOSError(error) ? "local_io_failure" : "run_failed", message = stage ? "Session state could not be saved locally" : isPyOSError(error) ? "A local file operation failed" : "Run failed";
  return [500, { error: `${message} (reference ${traceId})`, error_code: code, trace_id: traceId }];
}
