import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Row } from "@xueness/agent";
import { providerActivityExtension } from "../src/activity.ts";
import { modelFailureMessage, publicModelFailure, recordModelFailure } from "../src/model-status.ts";
import { publicRuntimeActivity, publicSessionPayload } from "../../sessions/src/public-session.ts";

function storedModelFailure(session: Row): Row | null {
  const value = session["model_failure"];
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : null;
}

describe("model failure status", () => {
  it("uses fixed localized text and persists only terminal classified facts", () => {
    const cases: [Row, string, string][] = [
      [{ reason: "auth_failed" }, "模型服务认证失败，请检查 API 密钥和账号权限。", "Model service authentication failed. Check the API key and account access."],
      [{ reason: "rate_limited", retryable: false }, "模型服务的额度或用量限制已用尽，请检查账户额度。", "The model service quota or usage limit is exhausted. Check the account quota."],
      [{ reason: "provider_overloaded" }, "模型服务当前负载过高，请稍后重试。", "The model service is currently overloaded. Try again shortly."],
      [{ reason: "server_error" }, "模型服务发生错误，请稍后重试。", "The model service encountered an error. Try again shortly."],
      [{ reason: "timeout" }, "模型请求超时，请检查连接后重试。", "The model request timed out. Check the connection and try again."],
      [{ reason: "stream_idle_timeout" }, "模型响应流长时间没有数据，请稍后重试。", "The model response stream became idle. Try again shortly."],
      [{ reason: "network_error" }, "无法连接模型服务，请检查网络后重试。", "Could not connect to the model service. Check the network and try again."],
      [{ reason: "proxy_error" }, "无法通过代理连接模型服务，请检查代理设置。", "Could not connect through the proxy. Check the proxy settings."],
      [{ reason: "tls_error" }, "模型服务的 TLS 连接验证失败，请检查网络或证书设置。", "TLS verification for the model service failed. Check the network or certificate settings."],
      [{ reason: "context_exceeded" }, "请求内容超过模型的上下文上限，请缩短内容后重试。", "The request exceeds the model context limit. Shorten it and try again."],
      [{ reason: "invalid_request" }, "模型服务拒绝了请求，请检查模型和请求设置。", "The model service rejected the request. Check the model and request settings."],
      [{ reason: "provider_not_configured" }, "模型服务尚未配置，请检查供应商设置。", "The model service is not configured. Check the provider settings."],
      [{ reason: "unknown", errorCode: "invalid_model_response" }, "模型服务返回了空回复，请重试或检查模型服务。", "The model returned an empty response. Retry or check the model service."],
    ];
    for (const [info, zh, en] of cases) { assert.equal(modelFailureMessage(info), zh); assert.equal(modelFailureMessage(info, "en"), en); }
    const session: Row = {};
    recordModelFailure(session, { terminal: false, reason: "network_error", message: "upstream-secret" });
    recordModelFailure(session, { terminal: true, reason: "cancelled", message: "upstream-secret" });
    assert.equal(session.model_failure, undefined);
    const safeInfo: Row = { requestId: "request-1", attemptId: "attempt-2", attempt: 2, maxAttempts: 4, timestamp: "2026-10-22T00:00:00Z", durationMs: 91,
      modelId: "sample-model", providerKind: "openai", reason: "unknown", errorCode: "invalid_model_response", retryable: false, statusCode: 502,
      providerErrorCode: "E502", terminal: true, message: "raw provider text token=secret https://private.invalid", messageZh: "raw provider text token=secret" };
    recordModelFailure(session, safeInfo);
    const failure = storedModelFailure(session);
    assert.ok(failure);
    assert.equal(failure.messageZh, modelFailureMessage(safeInfo));
    assert.equal(failure.message, modelFailureMessage(safeInfo, "en"));
    const projected = publicModelFailure({ ...safeInfo, token: "secret-token", proxyUrl: "https://private.invalid" })!;
    const serialized = JSON.stringify(projected);
    assert.equal(serialized.includes("secret"), false);
    assert.equal(serialized.includes("https://"), false);
    assert.equal(Object.hasOwn(projected, "token"), false);
    assert.deepEqual(Object.keys(projected).sort(), ["attempt", "attemptId", "durationMs", "errorCode", "maxAttempts", "message", "messageZh", "modelId", "providerErrorCode", "providerKind", "reason", "requestId", "retryable", "statusCode", "terminal", "timestamp"].sort());
  });

  it("tracks start, completion and terminal failure on one activity record", async () => {
    const session: Row = { steps: 3, model_failure: { reason: "old" } };
    let saves = 0;
    const context = { session, save: async () => { saves += 1; } } as any;
    const extension = providerActivityExtension();
    await extension.prepareRequest!(context, { messages: [], tools: [], options: {} });
    const activity = session.runtime_activity as Row;
    activity.retry = { reason: "rate_limited", attempt: 2 };
    await extension.modelRequestStarted!(context, { requestId: "logical-1", attemptId: "physical-1", attempt: 1, maxAttempts: 3 });
    assert.equal(activity.phase, "waiting_model");
    assert.equal(activity.retry, undefined);
    assert.equal(session.model_failure, undefined);
    assert.equal(activity.requestId, "logical-1");
    assert.equal(activity.attemptId, "physical-1");
    session.model_failure = { reason: "stale" };
    extension.modelRequestCompleted!(context, { requestId: "logical-1", attemptId: "physical-1", attempt: 1, maxAttempts: 3, durationMs: 83, finishReason: "stop" });
    assert.equal(activity.modelRequestDurationMs, 83);
    assert.equal(activity.finishReason, "stop");
    assert.equal(session.model_failure, undefined);
    const retry: Row = { requestId: "logical-1", attemptId: "physical-2", attempt: 2, maxAttempts: 3, durationMs: 20, reason: "server_error", retryable: true, terminal: false, message: "upstream-secret" };
    await extension.modelRequestFailed!(context, retry);
    assert.equal(session.model_failure, undefined);
    assert.equal(retry.messageZh, undefined);
    const terminal: Row = { requestId: "logical-1", attemptId: "physical-3", attempt: 3, maxAttempts: 3, durationMs: 22, reason: "network_error", retryable: false, terminal: true, message: "upstream-secret token=secret" };
    await extension.modelRequestFailed!(context, terminal);
    assert.equal(terminal.messageZh, modelFailureMessage(terminal));
    assert.equal(terminal.message, modelFailureMessage(terminal, "en"));
    const failure = storedModelFailure(session);
    assert.ok(failure);
    assert.equal(failure.messageZh, terminal.messageZh);
    assert.equal(JSON.stringify(failure)?.includes("secret"), false);
    assert.equal(saves, 3);
  });

  it("projects safe model failure and request activity fields in session payloads", async () => {
    const session: Row = { id: "a".repeat(32), task: "example", root: "workspace", status: "paused", steps: 1, messages: [], results: {},
      model_failure: { reason: "rate_limited", requestId: "request-1", attemptId: "attempt-2", attempt: 2, maxAttempts: 4, durationMs: 50,
        retryable: false, statusCode: 429, terminal: true, messageZh: "固定中文额度提示", message: "Fixed quota message", token: "secret" },
      runtime_activity: { phase: "waiting_model", requestId: "request-1", attemptId: "attempt-2", attempt: 2, maxAttempts: 4, modelRequestDurationMs: 50 } };
    const options = { enabled: () => false, approvals: new Map() } as any;
    const payload = await publicSessionPayload(session as any, options);
    assert.deepEqual(payload.runtime_activity, { phase: "waiting_model", requestId: "request-1", attemptId: "attempt-2", attempt: 2, maxAttempts: 4, modelRequestDurationMs: 50 });
    assert.deepEqual(payload.model_failure, { reason: "rate_limited", requestId: "request-1", attemptId: "attempt-2", attempt: 2, maxAttempts: 4, durationMs: 50,
      retryable: false, statusCode: 429, terminal: true, messageZh: "固定中文额度提示", message: "Fixed quota message" });
    session.model_failure = { reason: "made_up", message: "raw upstream token=secret" };
    session.runtime_activity = { phase: "waiting_model", requestId: "https://private.invalid/?token=secret", attemptId: "bad id", attempt: 0, maxAttempts: -1, modelRequestDurationMs: -2 };
    const invalid = await publicSessionPayload(session as any, options);
    assert.equal(invalid.model_failure, null);
    assert.deepEqual(invalid.runtime_activity, { phase: "waiting_model" });
    assert.equal(JSON.stringify(invalid).includes("secret"), false);
    assert.equal(publicRuntimeActivity({ phase: "waiting_model", requestId: "req", attemptId: "a", attempt: 1, maxAttempts: 2, modelRequestDurationMs: 8 })?.modelRequestDurationMs, 8);
  });
});
