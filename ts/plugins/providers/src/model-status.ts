import type { Row } from "@xueness/agent";
import { FINISH_REASONS } from "@xueness/providers";

const REASONS = new Set(["auth_failed", "rate_limited", "provider_overloaded", "server_error", "timeout", "stream_idle_timeout", "network_error", "proxy_error", "tls_error", "context_exceeded", "invalid_request", "provider_not_configured", "unknown"]);
const TOKEN = /^[A-Za-z0-9_.:-]{1,128}$/;
const CODE = /^[a-z_]{1,40}$/;
const cleanText = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);

/** A fixed, localized message for the classified failure; provider text is never included. */
export function modelFailureMessage(info: Row, language: "zh" | "en" = "zh"): string {
  const reason = REASONS.has(String(info.reason)) ? String(info.reason) : "unknown";
  const empty = info.errorCode === "invalid_model_response" && reason === "unknown";
  if (language === "zh") {
    if (empty) return "模型服务返回了空回复，请重试或检查模型服务。";
    if (reason === "auth_failed") return "模型服务认证失败，请检查 API 密钥和账号权限。";
    if (reason === "rate_limited") return info.retryable === false ? "模型服务的额度或用量限制已用尽，请检查账户额度。" : "模型服务请求过于频繁，请稍后重试。";
    if (reason === "provider_overloaded") return "模型服务当前负载过高，请稍后重试。";
    if (reason === "server_error") return "模型服务发生错误，请稍后重试。";
    if (reason === "timeout") return "模型请求超时，请检查连接后重试。";
    if (reason === "stream_idle_timeout") return "模型响应流长时间没有数据，请稍后重试。";
    if (reason === "network_error") return "无法连接模型服务，请检查网络后重试。";
    if (reason === "proxy_error") return "无法通过代理连接模型服务，请检查代理设置。";
    if (reason === "tls_error") return "模型服务的 TLS 连接验证失败，请检查网络或证书设置。";
    if (reason === "context_exceeded") return "请求内容超过模型的上下文上限，请缩短内容后重试。";
    if (reason === "invalid_request") return "模型服务拒绝了请求，请检查模型和请求设置。";
    if (reason === "provider_not_configured") return "模型服务尚未配置，请检查供应商设置。";
    return "模型请求失败，请检查模型配置后重试。";
  }
  if (empty) return "The model returned an empty response. Retry or check the model service.";
  if (reason === "auth_failed") return "Model service authentication failed. Check the API key and account access.";
  if (reason === "rate_limited") return info.retryable === false ? "The model service quota or usage limit is exhausted. Check the account quota." : "The model service is receiving requests too quickly. Try again shortly.";
  if (reason === "provider_overloaded") return "The model service is currently overloaded. Try again shortly.";
  if (reason === "server_error") return "The model service encountered an error. Try again shortly.";
  if (reason === "timeout") return "The model request timed out. Check the connection and try again.";
  if (reason === "stream_idle_timeout") return "The model response stream became idle. Try again shortly.";
  if (reason === "network_error") return "Could not connect to the model service. Check the network and try again.";
  if (reason === "proxy_error") return "Could not connect through the proxy. Check the proxy settings.";
  if (reason === "tls_error") return "TLS verification for the model service failed. Check the network or certificate settings.";
  if (reason === "context_exceeded") return "The request exceeds the model context limit. Shorten it and try again.";
  if (reason === "invalid_request") return "The model service rejected the request. Check the model and request settings.";
  if (reason === "provider_not_configured") return "The model service is not configured. Check the provider settings.";
  return "The model request failed. Check the model configuration and try again.";
}

/** Public allowlist projection used by the providers plugin's own consumers. */
export function publicModelFailure(raw: unknown): Row | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const value = raw as Row, result: Row = {};
  const reason = REASONS.has(String(value.reason)) ? String(value.reason) : null;
  if (!reason) return null;
  result.reason = reason;
  for (const key of ["requestId", "attemptId"]) if (typeof value[key] === "string" && TOKEN.test(value[key] as string)) result[key] = value[key];
  for (const key of ["attempt", "maxAttempts"]) { const number = value[key]; if (typeof number === "number" && Number.isInteger(number) && number >= (key === "attempt" ? 1 : 0) && number <= 1e9) result[key] = number; }
  if (typeof value.timestamp === "string" && value.timestamp.length <= 40 && Number.isFinite(Date.parse(value.timestamp))) result.timestamp = value.timestamp;
  if (typeof value.durationMs === "number" && Number.isFinite(value.durationMs) && value.durationMs >= 0 && value.durationMs <= 1e9) result.durationMs = value.durationMs;
  if (typeof value.modelId === "string" && cleanText(value.modelId, 160)) result.modelId = value.modelId;
  if (typeof value.providerKind === "string" && TOKEN.test(value.providerKind)) result.providerKind = value.providerKind;
  if (typeof value.errorCode === "string" && CODE.test(value.errorCode)) result.errorCode = value.errorCode;
  if (typeof value.retryable === "boolean") result.retryable = value.retryable;
  if (["connect", "read", "parse", "deadline", "response"].includes(String(value.phase))) result.phase = value.phase;
  if (typeof value.statusCode === "number" && Number.isInteger(value.statusCode) && value.statusCode >= 100 && value.statusCode <= 599) result.statusCode = value.statusCode;
  if (typeof value.providerErrorCode === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(value.providerErrorCode)) result.providerErrorCode = value.providerErrorCode;
  if (typeof value.finishReason === "string" && FINISH_REASONS.has(value.finishReason)) result.finishReason = value.finishReason;
  if (value.terminal === true) result.terminal = true;
  result.messageZh = modelFailureMessage(result, "zh");
  result.message = modelFailureMessage(result, "en");
  return result;
}

/** Record only terminal, non-cancelled failures and retain content-free facts. */
export function recordModelFailure(session: Row, info: Row): void {
  if (info.terminal !== true || info.reason === "cancelled") return;
  const safe: Row = { ...info, reason: REASONS.has(String(info.reason)) ? String(info.reason) : "unknown" };
  const failure = publicModelFailure(safe);
  if (!failure) return;
  failure.messageZh = modelFailureMessage(failure, "zh");
  failure.message = modelFailureMessage(failure, "en");
  session.model_failure = failure;
}
