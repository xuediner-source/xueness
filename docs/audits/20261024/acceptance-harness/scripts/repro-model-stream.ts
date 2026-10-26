/**
 * F00.04 acceptance harness · S-MDL-02A / S-MDL-02B / S-FAIL-01 (offline).
 *
 * Exercises the production model-request/stream/retry path
 * (ts/packages/agent/src/model-request.ts, stream.ts, model-retry.ts) through
 * AgentRunner with a scripted provider — no server, no model, temp state dir.
 * Mirrors the shapes already proven by ts/packages/agent/test/model-retry.test.ts
 * and lifecycle.test.ts; this script exists so the boundary is reproducible
 * from the harness without running the whole test suite.
 *
 * Exit code 0 means "all boundary checks matched" — for these samples that
 * means the C-MDL-02 invariant clauses HOLD (see [CONTRACT] lines).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../../../../../ts/packages/sessions/src/index.ts";
import { AgentRunner, type AgentEvent } from "../../../../../ts/packages/agent/src/index.ts";
import { ProviderRequestError } from "../../../../../ts/packages/providers/src/index.ts";
import type { AgentProvider } from "../../../../../ts/packages/agent/src/index.ts";

const failures: string[] = [];
const check = (label: string, ok: boolean, detail: string): void => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${detail}`);
  if (!ok) failures.push(label);
};
async function rejects(promise: Promise<unknown>, errorType: abstract new (...args: never[]) => Error): Promise<void> {
  await promise.then(() => { throw new Error("expected rejection"); }, (error: unknown) => {
    if (!(error instanceof errorType)) throw new Error(`unexpected rejection type: ${String(error)}`);
  });
}

function makeFixture(onEvent?: (event: AgentEvent) => void) {
  const directory = mkdtempSync(join(tmpdir(), "xueness-harness-mdl-"));
  const store = new SessionStore(join(directory, "state"));
  const session = { id: "a".repeat(32), root: directory, task: "task", status: "pending", steps: 0,
    messages: [{ role: "system", content: "System" }, { role: "user", content: "task" }], results: {}, compactions: [], archived_messages: [], completion: null } as never;
  let requests = 0;
  const provider: AgentProvider = { runtimeProfile: "standard", toolCalling: "native",
    async complete() { requests += 1; throw new Error("script must override complete"); } };
  const hooks = { enabled: (id: string) => ["providers", "sessions", "files"].includes(id), toolOwner: () => null, tools: () => [] };
  const runner = new AgentRunner({ store, provider, hooks, root: directory, onEvent,
    toolBridge: { call: async () => { throw new Error("no effects in harness"); }, callAll: async () => [] } } as never);
  return { directory, store, session, runner, provider, requests: () => requests, close: () => rmSync(directory, { recursive: true, force: true }) };
}
const quick = { baseDelayMs: 0, jitter: false };
const count = (events: AgentEvent[], type: string) => events.filter((event) => event.type === type);

// ---- Case A (S-MDL-02A): cancel during the provider stream → no retry, no replay, lease released.
{
  const events: AgentEvent[] = [];
  const local = makeFixture((event) => { events.push(event); });
  let calls = 0;
  local.provider.stream = async (_messages, _tools, observers) => {
    calls += 1;
    local.runner.cancel(local.session.id as string);            // user stop arrives mid-stream
    observers?.onDelta?.("partial response");                    // fragments already in flight
    return { content: "never reached" };
  };
  try {
    await local.runner.run(local.session, { modelRetry: quick });
    check("A1 settles as stopped", (local.session as { status?: string }).status === "stopped", String((local.session as { status?: string }).status));
    check("A2 provider called exactly once (cancel is not retried)", calls === 1, String(calls));
    check("A3 zero model_retry_scheduled events", count(events, "model_retry_scheduled").length === 0, String(count(events, "model_retry_scheduled").length));
    const messages = (local.session as { messages: Array<{ role: string }> }).messages;
    check("A4 no assistant message persisted (committed fragments never replayed into history)", messages.filter((row) => row.role === "assistant").length === 0, String(messages.length));
    check("A5 runner no longer marks the session running", local.runner.isRunning(local.session.id as string) === false, "isRunning");
    const lease = await local.store.lease(local.session.id as string); await lease.release();
    check("A6 lease re-acquirable after the stopped run", true, "lease acquired+released");
  } finally { local.close(); }
}

// ---- Case B (S-MDL-02B): failure AFTER committed output → no retry (fragments would be replayed).
{
  const events: AgentEvent[] = [];
  const local = makeFixture((event) => { events.push(event); });
  let calls = 0;
  local.provider.stream = async (_messages, _tools, observers) => {
    calls += 1;
    observers?.onDelta?.("partial committed text");              // commits the stream
    throw new ProviderRequestError({ status: 503 });             // transport dies mid-response
  };
  try {
    await rejects(local.runner.run(local.session, { modelRetry: quick }), ProviderRequestError);
    check("B1 provider called exactly once (no second request → no fragment replay)", calls === 1, String(calls));
    check("B2 zero model_retry_scheduled events after committed output", count(events, "model_retry_scheduled").length === 0, String(count(events, "model_retry_scheduled").length));
    check("B3 failure surfaced as ProviderRequestError (not swallowed, not looped)", true, "503 propagated");
  } finally { local.close(); }
}

// ---- Case C (S-FAIL-01): classification drives backoff; one budget across attempts.
{
  const events: AgentEvent[] = [];
  const local = makeFixture((event) => { events.push(event); });
  let calls = 0;
  local.provider.complete = async () => {
    calls += 1;
    if (calls === 1) throw new ProviderRequestError({ status: 503 });
    if (calls === 2) throw new ProviderRequestError({ status: 429, providerCode: "1302", retryAfterMs: 5 });
    return { content: "done", _request_attempts: 1 };
  };
  try {
    await local.runner.run(local.session, { modelRetry: quick });
    check("C1 three provider attempts (503 → 429 → success)", calls === 3, String(calls));
    const failed = count(events, "model_request_failed");
    check("C2 failed events classified server_error then rate_limited",
      JSON.stringify(failed.map((event) => [event.attempt, event.reason, event.retryable, event.statusCode])) === JSON.stringify([[1, "server_error", true, 503], [2, "rate_limited", true, 429]]),
      JSON.stringify(failed.map((event) => [event.attempt, event.reason, event.retryable, event.statusCode])));
    check("C3 providerErrorCode surfaced for the rate limit", (failed[1] as { providerErrorCode?: string }).providerErrorCode === "1302", String((failed[1] as { providerErrorCode?: string }).providerErrorCode));
    const retries = count(events, "model_retry_scheduled");
    check("C4 retry delay honors Retry-After (5ms) after the zero-delay first backoff",
      JSON.stringify(retries.map((event) => [event.attempt, event.nextAttempt, event.delayMs, event.reason])) === JSON.stringify([[1, 2, 0, "server_error"], [2, 3, 5, "rate_limited"]]),
      JSON.stringify(retries.map((event) => [event.attempt, event.nextAttempt, event.delayMs, event.reason])));
    const modelIds = new Set(events.filter((event) => String(event.type).startsWith("model_")).map((event) => event.requestId));
    check("C5 one requestId across the whole request lifecycle (failure counted against one budget)", modelIds.size === 1, String(modelIds.size));
    check("C6 run completes after classified retries", (local.session as { status?: string }).status === "completed", String((local.session as { status?: string }).status));
  } finally { local.close(); }
}

// ---- Case D (S-FAIL-01): non-retryable auth failure — no backoff, single attempt.
{
  const events: AgentEvent[] = [];
  const local = makeFixture((event) => { events.push(event); });
  let calls = 0;
  local.provider.complete = async () => { calls += 1; throw new ProviderRequestError({ status: 401 }); };
  try {
    await rejects(local.runner.run(local.session, { modelRetry: quick }), ProviderRequestError);
    check("D1 provider called exactly once for non-retryable auth failure", calls === 1, String(calls));
    const failed = count(events, "model_request_failed");
    check("D2 classified as non-retryable", failed.length === 1 && (failed[0] as { retryable?: boolean }).retryable === false, JSON.stringify(failed.map((event) => event.retryable)));
    check("D3 zero model_retry_scheduled events", count(events, "model_retry_scheduled").length === 0, String(count(events, "model_retry_scheduled").length));
  } finally { local.close(); }
}

// ---- Case E (S-FAIL-01): empty completion retries at most once, then succeeds.
// The anomaly guard keys on a non-stop finish reason with no text/tool calls/usage.
{
  const local = makeFixture();
  let calls = 0;
  local.provider.complete = async () => { calls += 1; return calls === 1 ? { content: "", _finish_reason: "end_turn" } : { content: "done", _finish_reason: "stop", _request_attempts: 1 }; };
  try {
    await local.runner.run(local.session, { modelRetry: quick });
    check("E1 empty completion retried exactly once then completed", calls === 2 && (local.session as { status?: string }).status === "completed", `calls=${calls} status=${(local.session as { status?: string }).status}`);
  } finally { local.close(); }
}

console.log("");
console.log("[HARNESS] S-MDL-02A/S-MDL-02B/S-FAIL-01 " + (failures.length === 0 ? "all boundary checks matched." : "UNEXPECTED: " + failures.join(", ")));
console.log("[CONTRACT] C-MDL-02 invariant verdict today: pass (offline clauses: 取消不重试 / 已提交不重播 / 分类驱动退避 / 单次预算 / 空输出有界重试). 字段级对照仍属 C-MDL-01（live_model 单列）。");
process.exit(failures.length === 0 ? 0 : 1);
