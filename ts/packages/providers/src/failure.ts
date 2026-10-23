/**
 * ZCode's model failure taxonomy (`@zcode/contracts` model errors) and
 * classifier (`adapters/model/failure-classifier.ts`, `failure-inspection.ts`,
 * `failure-tls.ts`), applied to Xueness' sanitized provider errors.
 *
 * Only content-free facts are read: HTTP status, Xueness category and
 * stage, the bounded business code token, a transport hint and the
 * server-directed delay. Messages are ZCode's fixed strings, so upstream
 * text never reaches a classified failure.
 */
import { ProviderCallbackError, ProviderRequestError, ProviderTransportError, isStreamStop } from "./errors.ts";
import { businessCodeKind, isNetworkCode, isProxyCode, isTlsCode, sanitizeProviderCode, type BusinessCodeKind } from "./failure-codes.ts";
import { isModelStreamIdleTimeoutError } from "./stream-idle-timeout.ts";

export const ModelErrorCode = {
  InvalidModelSelection: "invalid_model_selection", ModelConfigMissing: "model_config_missing",
  ProviderNotFound: "provider_not_found", ProviderNotConfigured: "provider_not_configured",
  ModelNotFound: "model_not_found", InvalidModelRequest: "invalid_model_request",
  InvalidModelResponse: "invalid_model_response", ModelRequestFailed: "model_request_failed",
  ModelRequestAuthMissing: "model_request_auth_missing", ModelRequestCancelled: "model_request_cancelled",
  ModelRequestTimeout: "model_request_timeout", ModelRateLimited: "model_rate_limited",
  ModelContextExceeded: "model_context_exceeded",
} as const;
export type ModelErrorCode = (typeof ModelErrorCode)[keyof typeof ModelErrorCode];

export const ModelRetryReason = {
  RateLimited: "rate_limited", ProviderOverloaded: "provider_overloaded", ServerError: "server_error",
  NetworkError: "network_error", Timeout: "timeout", StreamIdleTimeout: "stream_idle_timeout",
  StaleConnection: "stale_connection", AuthRefresh: "auth_refresh",
  ReasoningSignatureRepair: "reasoning_signature_repair", OffpeakQueued: "offpeak_queued",
} as const;
export type ModelRetryReason = (typeof ModelRetryReason)[keyof typeof ModelRetryReason];

export const ModelFailureReason = {
  ...ModelRetryReason,
  AuthFailed: "auth_failed", Cancelled: "cancelled", ContextExceeded: "context_exceeded",
  InvalidRequest: "invalid_request", ProviderNotConfigured: "provider_not_configured",
  ProxyError: "proxy_error", TlsError: "tls_error", Unknown: "unknown",
} as const;
export type ModelFailureReason = (typeof ModelFailureReason)[keyof typeof ModelFailureReason];

export interface ClassifiedModelFailure {
  code: ModelErrorCode;
  message: string;
  reason: ModelFailureReason;
  retryReason: ModelRetryReason;
  retryable: boolean;
  retryAfterMs?: number;
  statusCode?: number;
  providerCode?: string;
}

export const MODEL_FAILURE_MESSAGES = {
  invalidResponse: "Model returned an invalid response.",
  cancelled: "Model request was cancelled.",
  timeout: "Model request timed out.",
  rateLimited: "Provider rate limited the model request.",
  quota: "Provider quota or usage limit was reached.",
  overloaded: "Provider is overloaded.",
  auth: "Provider authentication failed.",
  context: "Model request exceeded the provider context window.",
  rejected: "Provider rejected the model request.",
  modelNotFound: "Provider could not find the requested model.",
  server: "Provider returned a server error.",
  tls: "TLS validation failed for the provider request.",
  proxy: "Proxy connection failed for the provider request.",
  network: "Network connection failed for the provider request.",
  streamIdleTimeout: "The model stream stopped producing data.",
  markedRetryable: "Provider marked the model request as retryable.",
  failed: "Model request failed.",
} as const;

const E = ModelErrorCode, F = ModelFailureReason, R = ModelRetryReason, M = MODEL_FAILURE_MESSAGES;
type Shape = [ModelErrorCode, ModelFailureReason, ModelRetryReason, boolean, string];
const BUSINESS: Record<BusinessCodeKind, Shape> = {
  server: [E.ModelRequestFailed, F.ServerError, R.ServerError, true, M.server],
  auth_refresh: [E.ProviderNotConfigured, F.AuthFailed, R.AuthRefresh, false, M.auth],
  rejected: [E.ModelRequestFailed, F.InvalidRequest, R.NetworkError, false, M.rejected],
  model_not_found: [E.ModelNotFound, F.InvalidRequest, R.NetworkError, false, M.modelNotFound],
  invalid_request: [E.InvalidModelRequest, F.InvalidRequest, R.NetworkError, false, M.rejected],
  invalid_auth: [E.InvalidModelRequest, F.AuthFailed, R.AuthRefresh, false, M.auth],
  rate_limited_terminal: [E.ModelRateLimited, F.RateLimited, R.RateLimited, false, M.quota],
  rate_limited: [E.ModelRateLimited, F.RateLimited, R.RateLimited, true, M.rateLimited],
  overloaded: [E.ModelRequestFailed, F.ProviderOverloaded, R.ProviderOverloaded, true, M.overloaded],
  network: [E.ModelRequestFailed, F.NetworkError, R.NetworkError, true, M.network],
  context: [E.ModelContextExceeded, F.ContextExceeded, R.NetworkError, false, M.context],
  terminal: [E.ModelRequestFailed, F.Unknown, R.NetworkError, false, M.failed],
};

interface Facts {
  status?: number; category?: string; stage?: string; contextOverflow: boolean; transport?: string | null;
  providerCode?: string; code?: string; retryAfterMs?: number; markedRetryable: boolean; timeoutName: boolean;
}

const TIMEOUT_CODES = new Set(["ETIMEDOUT", "ESOCKETTIMEDOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]);

function isAbort(error: unknown, signal?: AbortSignal | null): boolean {
  if (signal?.aborted || isStreamStop(error)) return true;
  return error instanceof Error && error.name === "AbortError";
}

function factsOf(error: unknown): Facts {
  if (error instanceof ProviderRequestError) {
    const facts: Facts = { category: error.category, stage: error.stage, contextOverflow: error.contextOverflow,
      transport: error.transport, markedRetryable: false, timeoutName: false };
    if (error.status !== null) facts.status = error.status;
    if (error.providerCode !== null) facts.providerCode = error.providerCode;
    if (error.retryAfterMs !== null) facts.retryAfterMs = error.retryAfterMs;
    return facts;
  }
  if (error instanceof ProviderTransportError) {
    return { category: error.category, contextOverflow: false, transport: error.hint, markedRetryable: false, timeoutName: error.category === "timeout" };
  }
  const record = typeof error === "object" && error !== null ? error as Record<string, unknown> : {};
  const rawStatus = record.status ?? record.statusCode;
  const facts: Facts = { contextOverflow: record.contextOverflow === true, markedRetryable: record.isRetryable === true,
    timeoutName: error instanceof Error && error.name === "TimeoutError" };
  if (typeof rawStatus === "number" && Number.isInteger(rawStatus) && rawStatus >= 100 && rawStatus <= 599) facts.status = rawStatus;
  const code = sanitizeProviderCode(record.code);
  if (code !== null) facts.code = code;
  const providerCode = sanitizeProviderCode(record.providerCode);
  if (providerCode !== null) facts.providerCode = providerCode;
  if (typeof record.category === "string") facts.category = record.category;
  return facts;
}

function build(shape: Shape, facts: Facts, withDelay: boolean): ClassifiedModelFailure {
  const [code, reason, retryReason, retryable, message] = shape;
  const failure: ClassifiedModelFailure = { code, message, reason, retryReason, retryable };
  if (withDelay && facts.retryAfterMs !== undefined) failure.retryAfterMs = facts.retryAfterMs;
  if (facts.status !== undefined) failure.statusCode = facts.status;
  if (facts.providerCode !== undefined) failure.providerCode = facts.providerCode;
  return failure;
}

/** `classifyModelFailure`: ZCode's ordered ladder over the sanitized facts. */
export function classifyModelFailure(error: unknown, signal?: AbortSignal | null): ClassifiedModelFailure {
  const facts = factsOf(error);
  const shape = (...value: Shape): Shape => value;
  if (facts.code === E.InvalidModelResponse || facts.category === "invalid_response" || facts.stage === "parse") {
    return build(shape(E.InvalidModelResponse, F.InvalidRequest, R.NetworkError, false, M.invalidResponse), facts, false);
  }
  if (facts.code === E.InvalidModelRequest) return build(shape(E.InvalidModelRequest, F.InvalidRequest, R.NetworkError, false, M.rejected), facts, false);
  if (isAbort(error, signal)) return build(shape(E.ModelRequestCancelled, F.Cancelled, R.NetworkError, false, M.cancelled), facts, false);
  if (isModelStreamIdleTimeoutError(error)) {
    return build(shape(E.ModelRequestTimeout, F.StreamIdleTimeout, R.StreamIdleTimeout, true, M.streamIdleTimeout), facts, false);
  }
  if (error instanceof ProviderCallbackError) return build(shape(E.ModelRequestFailed, F.Unknown, R.NetworkError, false, M.failed), facts, false);
  const business = businessCodeKind(facts.providerCode);
  if (business !== null) {
    const mapped = BUSINESS[business];
    return build(mapped, facts, mapped[3]);
  }
  if (facts.category === "quota_exhausted") return build(BUSINESS.rate_limited_terminal, facts, false);
  const status = facts.status;
  if (facts.category === "timeout" || facts.timeoutName || status === 408 || status === 504 || (facts.code !== undefined && TIMEOUT_CODES.has(facts.code.toUpperCase()))) {
    return build(shape(E.ModelRequestTimeout, F.Timeout, R.Timeout, true, M.timeout), facts, true);
  }
  if (status === 429) return build(shape(E.ModelRateLimited, F.RateLimited, R.RateLimited, true, M.rateLimited), facts, true);
  if (status === 529) return build(BUSINESS.overloaded, facts, true);
  if (status === 401 || status === 403 || facts.category === "authentication_failed") {
    return build(shape(E.ProviderNotConfigured, F.AuthFailed, R.AuthRefresh, false, M.auth), facts, false);
  }
  if (status === 400 || status === 413 || status === 422 || facts.category === "request_rejected") {
    return build(facts.contextOverflow ? BUSINESS.context : shape(E.InvalidModelRequest, F.InvalidRequest, R.NetworkError, false, M.rejected), facts, false);
  }
  if (facts.contextOverflow || facts.category === "context_overflow") return build(BUSINESS.context, facts, false);
  if (status !== undefined && status >= 500) return build(BUSINESS.server, facts, true);
  if (facts.transport === "tls" || isTlsCode(facts.code)) return build(shape(E.ModelRequestFailed, F.TlsError, R.NetworkError, false, M.tls), facts, false);
  if (facts.transport === "proxy" || isProxyCode(facts.code)) return build(shape(E.ModelRequestFailed, F.ProxyError, R.NetworkError, true, M.proxy), facts, true);
  if (isNetworkCode(facts.code) || facts.category === "connection_failed" || facts.category === "service_unready") {
    return build(BUSINESS.network, facts, true);
  }
  if (facts.markedRetryable) return build(shape(E.ModelRequestFailed, F.ServerError, R.ServerError, true, M.markedRetryable), facts, true);
  return build(BUSINESS.terminal, facts, false);
}

/** `isRetryableFailure`. */
export function isRetryableFailure(failure: ClassifiedModelFailure): boolean {
  return failure.retryable && failure.reason !== ModelFailureReason.Cancelled;
}
