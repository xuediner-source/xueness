import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ModelStreamIdleTimeoutError, ProviderRequestError, type StreamObservers, type ToolSnapshot } from "@xueness/providers";
import type { AgentEvent, Row } from "../src/index.ts";
import { providerActivityExtension } from "../../../plugins/providers/src/activity.ts";
import { sessionsToolActivityExtension } from "../../../plugins/sessions/src/tool-activity.ts";
import { call, fixture } from "./fixtures.ts";

const quick = { baseDelayMs: 0, jitter: false };
const empty = (): Row => ({ content: "", _finish_reason: "unknown", _usage: { total_tokens: 0 } });
const snapshot = (callId: string, input: string): ToolSnapshot => ({ index: 0, call_id: callId, name: "read", partial_input: input, input_chars: input.length, truncated: false });
const assistantRows = (session: Row): Row[] => (session.messages as Row[]).filter((message) => message.role === "assistant");
const retryEvents = (events: AgentEvent[]): AgentEvent[] => events.filter((event) => event.type === "model_retry_scheduled");

describe("logical model request handling", () => {
  it("retries a zero-usage empty completion once, publishes ordered attempt events, and releases each media binding", async () => {
    const events: AgentEvent[] = [];
    let calls = 0, binds = 0, releases = 0;
    const local = fixture([], [], { onEvent: (event) => { events.push(event); },
      bindPrompt: (_context, messages) => { binds += 1; return { messages, media: {} as never, release() { releases += 1; } }; } });
    local.provider.complete = async () => {
      calls += 1;
      return calls === 1 ? empty() : { content: "done", _finish_reason: "stop", _usage: { total_tokens: 7, secret: "upstream text" } };
    };
    try {
      await local.runner.run(local.session, { modelRetry: { ...quick, maxAttempts: 3 } });
      const status = events.filter((event) => ["model_request_started", "model_request_failed", "model_retry_scheduled", "model_request_completed"].includes(event.type));
      assert.deepEqual(status.map((event) => event.type), ["model_request_started", "model_request_failed", "model_retry_scheduled", "model_request_started", "model_request_completed"]);
      assert.equal(calls, 2); assert.equal(binds, 2); assert.equal(releases, 2);
      assert.equal(new Set(status.map((event) => event.requestId)).size, 1);
      assert.equal(new Set(status.map((event) => event.attemptId)).size, 2);
      assert.deepEqual(status.at(-1)?.usage, { total_tokens: 7 });
      assert.equal(status[1]?.phase, "response");
      assert.deepEqual(status.filter((event) => event.type === "model_request_started").map((event) => event.attempt), [1, 2]);
      assert.ok(status.filter((event) => event.type === "model_request_failed" || event.type === "model_request_completed").every((event) => Number(event.durationMs) >= 0));
      assert.equal(local.session.status, "completed");
    } finally { local.close(); }
  });

  it("bounds repeated empties, respects budgets, and skips adapter retries for normal stop, usage, tools, or reasoning", async () => {
    for (const [settings, expected] of [[{ ...quick, maxAttempts: 2 }, 2], [{ ...quick, budget: "single-attempt" as const }, 1], [{ ...quick, budget: "unbounded" as const }, 2]] as const) {
      const events: AgentEvent[] = [];
      const local = fixture([empty(), empty(), empty()], [], { onEvent: (event) => { events.push(event); } });
      try {
        await assert.rejects(local.runner.run(local.session, { modelRetry: settings }), ProviderRequestError);
        assert.equal(local.requests(), expected);
        assert.equal(assistantRows(local.session).some((message) => message.content === ""), false);
        assert.equal(retryEvents(events).length, expected - 1);
      } finally { local.close(); }
    }

    const normalCases: Array<{ responses: Row[]; outcomes?: Row[] }> = [
      { responses: [{ content: "", _finish_reason: "stop" }] },
      { responses: [{ content: "", _finish_reason: "unknown", _usage: { total_tokens: 1 } }] },
      { responses: [{ content: "", tool_calls: [call("one")], _finish_reason: "tool_calls" }, { content: "done", _finish_reason: "stop" }], outcomes: [{ ok: true, content: "read" }] },
    ];
    for (const scenario of normalCases) {
      const events: AgentEvent[] = [];
      const local = fixture(scenario.responses, scenario.outcomes ?? [], { onEvent: (event) => { events.push(event); } });
      try {
        await local.runner.run(local.session, { modelRetry: quick });
        assert.equal(retryEvents(events).length, 0);
        if (scenario.outcomes) assert.equal(local.effects(), 1);
      } finally { local.close(); }
    }

    const thinkingEvents: AgentEvent[] = [];
    const thinking = fixture([], [], { onEvent: (event) => { thinkingEvents.push(event); } });
    thinking.hooks.showReasoning = () => true;
    let streamCalls = 0;
    thinking.provider.stream = async (_messages, _tools, observers) => {
      streamCalls += 1; observers?.onReasoningDelta?.("thinking"); return { content: "", _finish_reason: "unknown" };
    };
    try {
      await assert.rejects(thinking.runner.run(thinking.session, { modelRetry: quick }), ProviderRequestError);
      assert.equal(streamCalls, 1);
      assert.equal(retryEvents(thinkingEvents).length, 0);
    } finally { thinking.close(); }
    const jsonThinking = fixture([{ ...empty(), _reasoning_blocks: [{ type: "thinking", thinking: "signed thought", signature: "sig" }] }]);
    try {
      await assert.rejects(jsonThinking.runner.run(jsonThinking.session, { modelRetry: quick }), ProviderRequestError);
      assert.equal(jsonThinking.requests(), 1);
    } finally { jsonThinking.close(); }
  });

  it("retries failed tool preludes without leaking snapshots and runs only the accepted tool call", async () => {
    const events: AgentEvent[] = [];
    const local = fixture([], [{ ok: true, content: "read" }], { onEvent: (event) => { events.push(event); } });
    local.session.tool_activity = [{ stale: true }];
    const observed: string[] = [];
    local.hooks.extensions = [sessionsToolActivityExtension(), { id: "files", observeToolDelta(_context, fact) { observed.push(String(fact.call_id)); } }];
    let calls = 0;
    local.provider.stream = async (_messages, _tools, observers) => {
      calls += 1;
      if (calls === 1) {
        observers?.onToolDelta?.(snapshot("failed-prelude", "{"));
        assert.equal(local.session.tool_activity, undefined);
        throw new ProviderRequestError({ status: 503 });
      }
      if (calls === 2) {
        observers?.onToolDelta?.(snapshot("accepted-prelude", "{\"path\":"));
        return { content: "", tool_calls: [call("actual-call")], _finish_reason: "tool_calls" };
      }
      return { content: "done", _finish_reason: "stop" };
    };
    try {
      await local.runner.run(local.session, { modelRetry: quick });
      assert.equal(calls, 3);
      assert.deepEqual(observed, ["accepted-prelude"]);
      assert.equal(local.effects(), 1);
      assert.equal(retryEvents(events).length, 1);
    } finally { local.close(); }
  });

  it("does not retry after visible body or hidden reasoning and leaves visible partials while releasing the lease", async () => {
    const cases: Array<{ visible: boolean; setup(observers?: StreamObservers): void }> = [
      { visible: true, setup(observers) { observers?.onDelta?.("partial answer"); } },
      { visible: false, setup(observers) { observers?.onReasoningDelta?.("private thought"); } },
    ];
    for (const scenario of cases) {
      const events: AgentEvent[] = [];
      const local = fixture([], [], { onEvent: (event) => { events.push(event); } });
      let calls = 0;
      const visibleProviderStream = async (_messages: Row[], _tools: Row[], observers?: StreamObservers) => {
        calls += 1; scenario.setup(observers); throw new ProviderRequestError({ status: 503 });
      };
      local.provider.stream = visibleProviderStream;
      try {
        await assert.rejects(local.runner.run(local.session, { modelRetry: quick }), ProviderRequestError);
        assert.equal(calls, 1);
        assert.equal(retryEvents(events).length, 0);
        const streaming = local.session.streaming as Row;
        assert.equal(streaming.status, "interrupted");
        if (scenario.visible) assert.equal(streaming.text, "partial answer");
        else { assert.equal(streaming.reasoning, undefined); assert.equal(events.some((event) => event.type === "reasoning_delta"), false); }
        assert.equal(local.session.status, "provider_error");
        const lease = await local.store.lease(String(local.session.id)); await lease.release();
      } finally { local.close(); }
    }
  });

  it("persists localized terminal failures, clears them on the next request, and skips disabled provider hooks", async () => {
    const local = fixture([]);
    local.hooks.extensions = [providerActivityExtension()];
    local.provider.complete = async () => { throw new ProviderRequestError({ status: 401 }); };
    try {
      await assert.rejects(local.runner.run(local.session, { modelRetry: quick }), ProviderRequestError);
      const failure = local.session.model_failure as Row;
      assert.equal(failure.reason, "auth_failed");
      assert.equal(failure.errorCode, "provider_not_configured");
      assert.equal(failure.messageZh, "模型服务认证失败，请检查 API 密钥和账号权限。");
      assert.deepEqual((await local.store.load(String(local.session.id))).model_failure, failure);

      local.provider.complete = async () => ({ content: "recovered", _finish_reason: "stop" });
      await local.runner.run(local.session, { modelRetry: quick });
      assert.equal(Object.hasOwn(local.session, "model_failure"), false);
    } finally { local.close(); }

    const disabled = fixture([]);
    disabled.hooks.extensions = [providerActivityExtension()];
    disabled.hooks.enabled = (id) => id !== "providers" && ["sessions", "files"].includes(id);
    disabled.session.model_failure = { reason: "unknown", messageZh: "preserved" };
    let calls = 0;
    disabled.provider.complete = async () => { calls += 1; return { content: "unused" }; };
    try {
      await disabled.runner.run(disabled.session, { modelRetry: quick });
      assert.equal(calls, 0);
      assert.equal(disabled.session.runtime_activity, undefined);
      assert.deepEqual(disabled.session.model_failure, { reason: "unknown", messageZh: "preserved" });
    } finally { disabled.close(); }
  });

  it("keeps user cancellation during an idle-timeout retry from persisting a provider failure and releases media", async () => {
    const events: AgentEvent[] = [];
    let local!: ReturnType<typeof fixture>;
    let releases = 0;
    local = fixture([], [], { onEvent: (event) => { events.push(event); if (event.type === "model_retry_scheduled") local.runner.cancel(String(local.session.id)); },
      bindPrompt: (_context, messages) => ({ messages, media: {} as never, release() { releases += 1; } }) });
    local.hooks.extensions = [providerActivityExtension()];
    let calls = 0;
    local.provider.stream = async () => { calls += 1; throw new ModelStreamIdleTimeoutError(); };
    try {
      await local.runner.run(local.session, { modelRetry: { ...quick, baseDelayMs: 60_000 } });
      assert.equal(local.session.status, "stopped");
      assert.equal(calls, 1); assert.equal(releases, 1);
      assert.equal(local.session.model_failure, undefined);
      assert.equal((events.find((event) => event.type === "model_request_failed") as Row | undefined)?.terminal, false);
    } finally { local.close(); }
  });
});
