/**
 * ZCode model failure taxonomy, business codes and retry policy
 * (`adapters/model/failure-classifier.ts`, `failure-provider-business-codes.ts`,
 * `retry-policy.ts`, `retry-budget.ts`, `runner-retry.ts`), plus the
 * transport facts that feed them.
 */
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import {
  DEFAULT_MODEL_RETRY_OPTIONS, ModelErrorCode, ModelFailureReason, ModelRetryBudget, ProviderCallbackError, ProviderCancelled,
  ProviderRequestError, ProviderTransportError, RetryableProviderError, calculateRetryDelay, classifyModelFailure, isRetryableFailure,
  openWithRetry, pyUrlSplit, resolveModelRetryOptions, resolveRetryOptionsForBudget, retryAfterMilliseconds, retryBudgetAllows,
  retryBudgetMaxAttempts, toProviderRequestError,
} from "../src/index.ts";

const pick = (error: unknown, signal?: AbortSignal) => {
  const failure = classifyModelFailure(error, signal);
  return [failure.code, failure.reason, failure.retryable] as const;
};

describe("ZCode model failure classification", () => {
  it("follows ZCode's status ladder over sanitized provider errors", () => {
    const rate = classifyModelFailure(new ProviderRequestError({ status: 429, retryAfterMs: 1500 }));
    assert.deepEqual([rate.code, rate.reason, rate.retryReason, rate.retryable, rate.retryAfterMs, rate.statusCode, rate.message],
      [ModelErrorCode.ModelRateLimited, "rate_limited", "rate_limited", true, 1500, 429, "Provider rate limited the model request."]);
    assert.deepEqual(pick(new ProviderRequestError({ status: 529 })), ["model_request_failed", "provider_overloaded", true]);
    assert.deepEqual(pick(new ProviderRequestError({ status: 503 })), ["model_request_failed", "server_error", true]);
    assert.deepEqual(pick(new ProviderRequestError({ status: 401 })), ["provider_not_configured", "auth_failed", false]);
    assert.deepEqual(pick(new ProviderRequestError({ category: "authentication_failed" })), ["provider_not_configured", "auth_failed", false]);
    assert.deepEqual(pick(new ProviderRequestError({ status: 400, contextOverflow: true })), ["model_context_exceeded", "context_exceeded", false]);
    assert.deepEqual(pick(new ProviderRequestError({ contextOverflow: true })), ["model_context_exceeded", "context_exceeded", false]);
    assert.deepEqual(pick(new ProviderRequestError({ status: 422 })), ["invalid_model_request", "invalid_request", false]);
    assert.deepEqual(pick(new ProviderRequestError({ status: 404 })), ["model_request_failed", "unknown", false]);
    assert.deepEqual(pick(new ProviderRequestError({ status: 504 })), ["model_request_timeout", "timeout", true]);
    assert.deepEqual(pick(new ProviderRequestError({ category: "timeout", stage: "read" })), ["model_request_timeout", "timeout", true]);
    assert.deepEqual(pick(new ProviderRequestError({ category: "invalid_response", stage: "parse" })), ["invalid_model_response", "invalid_request", false]);
    assert.deepEqual(pick(new ProviderRequestError({ status: 429, category: "quota_exhausted" })), ["model_rate_limited", "rate_limited", false]);
    assert.deepEqual(pick(toProviderRequestError(new ProviderTransportError("connection_failed", "ConnectionResetError"), { stage: "read" })),
      ["model_request_failed", "network_error", true]);
    assert.deepEqual(pick(toProviderRequestError(new ProviderTransportError("service_unready", "URLError"), { stage: "read" })),
      ["model_request_failed", "network_error", true]);
    assert.deepEqual(pick(toProviderRequestError(new ProviderTransportError("connection_failed", "URLError", "x", "tls"), { stage: "read" })),
      ["model_request_failed", "tls_error", false]);
    assert.deepEqual(pick(toProviderRequestError(new ProviderTransportError("connection_failed", "URLError", "x", "proxy"), { stage: "read" })),
      ["model_request_failed", "proxy_error", true]);
  });

  it("maps provider business codes before the generic status branches", () => {
    assert.deepEqual(pick(new ProviderRequestError({ status: 429, providerCode: "1302" })), ["model_rate_limited", "rate_limited", true]);
    assert.deepEqual(pick(new ProviderRequestError({ status: 429, providerCode: "1113" })), ["model_request_failed", "unknown", false]);
    assert.deepEqual(pick(new ProviderRequestError({ status: 429, providerCode: "insufficient_quota" })), ["model_rate_limited", "rate_limited", false]);
    assert.deepEqual(pick(new ProviderRequestError({ status: 400, providerCode: "1261" })), ["model_context_exceeded", "context_exceeded", false]);
    assert.deepEqual(pick(new ProviderRequestError({ status: 500, providerCode: 1234 })), ["model_request_failed", "network_error", true]);
    assert.deepEqual(pick(new ProviderRequestError({ status: 403, providerCode: "3007" })), ["invalid_model_request", "auth_failed", false]);
    assert.deepEqual(pick(new ProviderRequestError({ providerCode: "overloaded_error" })), ["model_request_failed", "provider_overloaded", true]);
    // Terminal business failures drop Retry-After; retryable ones keep it.
    assert.equal(classifyModelFailure(new ProviderRequestError({ status: 429, providerCode: "1308", retryAfterMs: 9000 })).retryAfterMs, undefined);
    assert.equal(classifyModelFailure(new ProviderRequestError({ status: 429, providerCode: "1302", retryAfterMs: 9000 })).retryAfterMs, 9000);
    // Unbounded or unsafe tokens are never kept.
    assert.equal(new ProviderRequestError({ providerCode: "x".repeat(65) }).providerCode, null);
    assert.equal(new ProviderRequestError({ providerCode: "bad code" }).providerCode, null);
  });

  it("treats cancellation, callbacks and unknown local errors as non-retryable", () => {
    assert.deepEqual(pick(new ProviderCancelled()), ["model_request_cancelled", "cancelled", false]);
    const aborted = new AbortController(); aborted.abort();
    assert.deepEqual(pick(new ProviderRequestError({ status: 503 }), aborted.signal), ["model_request_cancelled", "cancelled", false]);
    assert.deepEqual(pick(new ProviderCallbackError("Error")), ["model_request_failed", "unknown", false]);
    assert.deepEqual(pick(new Error("private details")), ["model_request_failed", "unknown", false]);
    assert.equal(classifyModelFailure(new Error("private details")).message, "Model request failed.");
    assert.deepEqual(pick(Object.assign(new Error("reset"), { code: "ECONNRESET" })), ["model_request_failed", "network_error", true]);
    assert.deepEqual(pick(Object.assign(new Error("cert"), { code: "CERT_HAS_EXPIRED" })), ["model_request_failed", "tls_error", false]);
    assert.deepEqual(pick({ status: 500 }), ["model_request_failed", "server_error", true]);
    assert.deepEqual(pick({ isRetryable: true }), ["model_request_failed", "server_error", true]);
    assert.equal(isRetryableFailure({ ...classifyModelFailure(new ProviderRequestError({ status: 503 })), reason: ModelFailureReason.Cancelled }), false);
  });

  it("keeps the Python-compatible JSON view unchanged", () => {
    const error = new ProviderRequestError({ status: 429, retryAfter: 30, retryAfterMs: 30_000, providerCode: "1302", traceId: "0123456789abcdef" });
    assert.deepEqual(Object.keys(error.toJSON()), ["status", "category", "stage", "trace_id", "exception_type", "context_overflow", "quota_reset_at", "retry_after"]);
    assert.equal(error.retryAfter, 2);
    assert.equal(error.retryAfterMs, 30_000);
    assert.equal(new ProviderRequestError({ retryAfterMs: 86_400_001 }).retryAfterMs, null);
  });
});

describe("ZCode model retry policy", () => {
  it("resolves explicit options, then XUENESS_MODEL_RETRY_* , then ZCode defaults", () => {
    assert.deepEqual(resolveModelRetryOptions(undefined, {}), { ...DEFAULT_MODEL_RETRY_OPTIONS });
    assert.deepEqual(DEFAULT_MODEL_RETRY_OPTIONS, { backoffFactor: 2, baseDelayMs: 2000, jitter: true, maxAttempts: 11, maxDelayMs: 60000 });
    const env = { XUENESS_MODEL_RETRY_MAX_RETRIES: "3", XUENESS_MODEL_RETRY_BASE_DELAY_MS: "500", XUENESS_MODEL_RETRY_BACKOFF_FACTOR: "3", XUENESS_MODEL_RETRY_MAX_DELAY_MS: "9000" };
    assert.deepEqual(resolveModelRetryOptions(undefined, env), { backoffFactor: 3, baseDelayMs: 500, jitter: true, maxAttempts: 4, maxDelayMs: 9000 });
    assert.deepEqual(resolveModelRetryOptions({ maxAttempts: 2, jitter: false }, env), { backoffFactor: 3, baseDelayMs: 500, jitter: false, maxAttempts: 2, maxDelayMs: 9000 });
    const invalid = { XUENESS_MODEL_RETRY_MAX_RETRIES: "-1", XUENESS_MODEL_RETRY_BASE_DELAY_MS: "x", XUENESS_MODEL_RETRY_BACKOFF_FACTOR: "0", XUENESS_MODEL_RETRY_MAX_DELAY_MS: " " };
    assert.deepEqual(resolveModelRetryOptions(undefined, invalid), { ...DEFAULT_MODEL_RETRY_OPTIONS });
    assert.equal(resolveModelRetryOptions({ maxAttempts: 0 }, {}).maxAttempts, 1);
  });

  it("applies budget tiers like retry-budget.ts", () => {
    const retry = resolveModelRetryOptions(undefined, {});
    assert.equal(resolveRetryOptionsForBudget(retry, ModelRetryBudget.SingleAttempt).maxAttempts, 1);
    assert.equal(resolveRetryOptionsForBudget(retry, ModelRetryBudget.Unbounded).maxAttempts, 11);
    assert.equal(retryBudgetAllows(ModelRetryBudget.Default, 10, 11), true);
    assert.equal(retryBudgetAllows(ModelRetryBudget.Default, 11, 11), false);
    assert.equal(retryBudgetAllows(ModelRetryBudget.Unbounded, 500, 11), true);
    assert.equal(retryBudgetMaxAttempts(ModelRetryBudget.Unbounded, 11), 0);
    assert.equal(retryBudgetMaxAttempts(undefined, 11), 11);
  });

  it("computes ZCode backoff with jitter and a reasonable Retry-After first", () => {
    const fixed = { ...DEFAULT_MODEL_RETRY_OPTIONS, jitter: false };
    assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map((attempt) => calculateRetryDelay(fixed, attempt)), [2000, 4000, 8000, 16000, 32000, 60000, 60000]);
    assert.equal(calculateRetryDelay(DEFAULT_MODEL_RETRY_OPTIONS, 1, undefined, () => 0), 1000);
    assert.equal(calculateRetryDelay(DEFAULT_MODEL_RETRY_OPTIONS, 1, undefined, () => 1), 2000);
    assert.equal(calculateRetryDelay(fixed, 1, 45_000), 45_000);
    assert.equal(calculateRetryDelay(fixed, 1, 0), 0);
    // Longer than five minutes is ignored unless shorter than the uncapped exponential delay.
    assert.equal(calculateRetryDelay(fixed, 1, 600_000), 2000);
    assert.equal(calculateRetryDelay(fixed, 20, 600_000), 600_000);
    assert.equal(calculateRetryDelay({ ...fixed, baseDelayMs: 0 }, 3), 0);
  });

  it("parses Retry-After like ZCode parseRetryAfterMs", () => {
    const headers = (values: Record<string, string>) => (name: string) => values[name];
    assert.equal(retryAfterMilliseconds(headers({ "retry-after-ms": "1500", "retry-after": "9" })), 1500);
    assert.equal(retryAfterMilliseconds(headers({ "retry-after": "3" })), 3000);
    assert.equal(retryAfterMilliseconds(headers({ "retry-after": "0.25" })), 250);
    assert.equal(retryAfterMilliseconds(headers({ "retry-after": "Wed, 21 Oct 2015 07:28:10 GMT" }), Date.parse("Wed, 21 Oct 2015 07:28:00 GMT")), 10_000);
    assert.equal(retryAfterMilliseconds(headers({ "retry-after": "3", "x-should-retry": "false" })), null);
    assert.equal(retryAfterMilliseconds(headers({ "retry-after": "soon" })), null);
    assert.equal(retryAfterMilliseconds(headers({})), null);
  });
});

describe("transport facts for ZCode classification", () => {
  let reply: (res: http.ServerResponse) => void = (res) => res.end();
  const server = http.createServer((req, res) => { req.resume(); req.on("end", () => reply(res)); });
  let port = 0;
  before(async () => { await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); port = (server.address() as AddressInfo).port; });
  after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });
  const spec = () => ({ url: pyUrlSplit(`http://127.0.0.1:${port}/v1/chat/completions`), method: "POST" as const,
    headers: { "Content-Type": "application/json" }, body: Buffer.from("{}"), timeoutMs: 5000, proxy: null });
  const failure = async (): Promise<RetryableProviderError> => {
    try { await openWithRetry(spec()); } catch (error) { if (error instanceof RetryableProviderError) return error; throw error; }
    throw new Error("expected a status failure");
  };

  it("keeps the business code and the unclamped Retry-After of an error status", async () => {
    reply = (res) => { res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "7" }); res.end(JSON.stringify({ error: { code: "1302", message: "slow down" } })); };
    const limited = await failure();
    assert.deepEqual([limited.status, limited.retryable, limited.delay, limited.providerCode, limited.retryAfterMs], [429, true, 2, "1302", 7000]);
    reply = (res) => { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: { code: 1234, message: "internal network error" } })); };
    const network = await failure();
    assert.deepEqual([network.status, network.providerCode, network.retryAfterMs], [500, "1234", null]);
    reply = (res) => { res.writeHead(503, { "Content-Type": "text/plain" }); res.end("unavailable"); };
    assert.equal((await failure()).providerCode, null);
  });
});
