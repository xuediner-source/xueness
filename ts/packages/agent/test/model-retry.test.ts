/**
 * ZCode runner retry at the shared driver (`adapters/model` attempt loop,
 * `runner-retry.ts`, `retry-budget.ts`): classified transient failures
 * before committed output are retried with ZCode status events.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ProviderRequestError, type ProviderCallOptions } from "@xueness/providers";
import { AgentRunner, type AgentEvent, type AgentExtension, type ModelRetryInfo, type Row } from "../src/index.ts";
import { fixture } from "./fixtures.ts";

const quick = { baseDelayMs: 0, jitter: false };

describe("ZCode model retry in the agent driver", () => {
  it("re-sends the same request after transient failures and publishes ZCode status events", async () => {
    const events: AgentEvent[] = [];
    const scheduled: ModelRetryInfo[] = [];
    const observer: AgentExtension = { id: "providers", modelRetryScheduled(_context, info) { scheduled.push(info); } };
    const local = fixture([], [], { onEvent: (event) => { events.push(event); } });
    const options: ProviderCallOptions[] = [];
    let calls = 0;
    local.provider.complete = async (_messages, _tools, callOptions) => {
      options.push({ ...callOptions });
      calls += 1;
      if (calls === 1) throw new ProviderRequestError({ status: 503 });
      if (calls === 2) throw new ProviderRequestError({ status: 429, providerCode: "1302", retryAfterMs: 5 });
      return { content: "done", _request_attempts: 1 };
    };
    local.hooks.extensions = [observer];
    try {
      await local.runner.run(local.session, { modelRetry: quick });
      assert.equal(local.session.status, "completed");
      assert.equal(calls, 3);
      assert.deepEqual(options.map((item) => item.transportAttempts), [1, 1, 1]);
      const failed = events.filter((event) => event.type === "model_request_failed");
      const retries = events.filter((event) => event.type === "model_retry_scheduled");
      assert.deepEqual(failed.map((event) => [event.attempt, event.reason, event.retryable, event.statusCode]), [[1, "server_error", true, 503], [2, "rate_limited", true, 429]]);
      assert.deepEqual(retries.map((event) => [event.attempt, event.nextAttempt, event.maxAttempts, event.delayMs, event.reason]), [[1, 2, 11, 0, "server_error"], [2, 3, 11, 5, "rate_limited"]]);
      assert.equal(failed[1]?.providerErrorCode, "1302");
      assert.equal(new Set(events.filter((event) => String(event.type).startsWith("model_")).map((event) => event.requestId)).size, 1);
      assert.deepEqual(scheduled.map((info) => info.nextAttempt), [2, 3]);
    } finally { local.close(); }
  });

  it("stops at the budget, on non-retryable failures and after committed output", async () => {
    const budget = fixture([]);
    let calls = 0;
    budget.provider.complete = async () => { calls += 1; throw new ProviderRequestError({ status: 502 }); };
    try {
      await assert.rejects(budget.runner.run(budget.session, { modelRetry: { ...quick, maxAttempts: 3 } }), ProviderRequestError);
      assert.equal(budget.session.status, "provider_error");
      assert.equal(calls, 3);
    } finally { budget.close(); }

    const auth = fixture([]);
    calls = 0;
    auth.provider.complete = async () => { calls += 1; throw new ProviderRequestError({ status: 401 }); };
    try {
      await assert.rejects(auth.runner.run(auth.session, { modelRetry: quick }), ProviderRequestError);
      assert.equal(calls, 1);
    } finally { auth.close(); }

    const streamed = fixture([]);
    calls = 0;
    streamed.provider.stream = async (_messages, _tools, observers) => {
      calls += 1; observers?.onDelta?.("partial"); throw new ProviderRequestError({ status: 503 });
    };
    try {
      await assert.rejects(streamed.runner.run(streamed.session, { modelRetry: quick }), ProviderRequestError);
      assert.equal(calls, 1);
    } finally { streamed.close(); }
  });

  it("keeps a single attempt for the lightweight profile and honours single-attempt budgets", async () => {
    for (const [profile, settings] of [["lightweight", quick], ["standard", { ...quick, budget: "single-attempt" as const }]] as const) {
      const local = fixture([]);
      let calls = 0;
      let attempts: number | undefined = -1;
      const provider = { ...local.provider, runtimeProfile: profile, async complete(_m: Row[], _t: Row[], options?: ProviderCallOptions) {
        calls += 1; attempts = options?.transportAttempts; throw new ProviderRequestError({ status: 503 });
      } };
      // The lightweight profile requires its providers capability; a stub declares it.
      const hooks = { ...local.hooks, extensions: [{ id: "providers", capabilities: ["providers.lightweight"] }] };
      const runner = new AgentRunner({ store: local.store, provider, hooks, root: local.directory,
        toolBridge: { call: async () => { throw new Error("no effects"); }, callAll: async () => [] } });
      try {
        await assert.rejects(runner.run(local.session, { modelRetry: settings }), ProviderRequestError);
        assert.equal(calls, 1, profile);
        assert.equal(attempts, undefined, profile);
      } finally { local.close(); }
    }
  });

  it("settles as stopped when the user stops during the retry wait", async () => {
    const local = fixture([], [], { onEvent: (event) => { if (event.type === "model_retry_scheduled") local.runner.cancel(local.session.id as string); } });
    let calls = 0;
    local.provider.complete = async () => { calls += 1; throw new ProviderRequestError({ status: 503 }); };
    const started = Date.now();
    try {
      await local.runner.run(local.session, { modelRetry: { baseDelayMs: 60_000, jitter: false } });
      assert.equal(local.session.status, "stopped");
      assert.equal(calls, 1);
      assert.ok(Date.now() - started < 5000);
    } finally { local.close(); }
  });

  it("never retries past the wall-time bound", async () => {
    let ticks = 0;
    const local = fixture([], [], { now: () => ticks });
    let calls = 0;
    local.provider.complete = async () => { calls += 1; throw new ProviderRequestError({ status: 503 }); };
    try {
      await assert.rejects(local.runner.run(local.session, { maxWallSeconds: 1, modelRetry: { baseDelayMs: 5000, jitter: false } }), ProviderRequestError);
      assert.equal(local.session.status, "provider_error");
      assert.equal(calls, 1);
      ticks = 0;
    } finally { local.close(); }
  });
});
