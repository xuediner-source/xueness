import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ModelRetryBudget, ProviderCallbackError, ProviderRequestError } from "@xueness/providers";
import type { AgentEvent, AgentProvider, Row } from "../src/index.ts";
import {
  matchExecutionSelectionFallback, ModelSelectionLookupError, resolveExecutionFallbackCandidates, resolveExecutionModelRetryBudget, type ExecutionModelScope, type ExecutionModelSelection, type SelectionFallbackDeclaration,
} from "../src/execution-selection.ts";
import { fixture } from "./fixtures.ts";

const quick = { baseDelayMs: 0, jitter: false };
const TEMP_PROVIDER_ID = "account:temp-execution";
const SESSION_PROVIDER_ID = "builtin:session";
const declaration: SelectionFallbackDeclaration = {
  providerId: TEMP_PROVIDER_ID,
  rules: [
    { reason: "card_expired", providerErrorCode: "3402" },
    { reason: "execution_request_failed" },
  ],
};

describe("resolveExecutionModelRetryBudget", () => {
  const selection: ExecutionModelSelection = { providerId: TEMP_PROVIDER_ID, modelId: "GLM-5.3" };
  it("a selection pointing at the declared fallback provider gets SingleAttempt", () => {
    assert.equal(resolveExecutionModelRetryBudget({ selection, selectionFallback: declaration }), ModelRetryBudget.SingleAttempt);
  });
  it("no declaration, no selection or another provider keeps the default budget", () => {
    assert.equal(resolveExecutionModelRetryBudget({ selection, selectionFallback: undefined }), undefined);
    assert.equal(resolveExecutionModelRetryBudget({ selection: { providerId: SESSION_PROVIDER_ID, modelId: "GLM-5.3" }, selectionFallback: declaration }), undefined);
    assert.equal(resolveExecutionModelRetryBudget({ selection: undefined, selectionFallback: declaration }), undefined);
  });
});

describe("resolveExecutionFallbackCandidates", () => {
  const target: ExecutionModelSelection = { providerId: SESSION_PROVIDER_ID, modelId: "GLM-5.3", reasoningEffort: "low" };
  const resident: ExecutionModelSelection = { providerId: "user-provider", modelId: "user-model" };
  it("declared target first, then the session-resident selection", () => {
    assert.deepEqual(resolveExecutionFallbackCandidates({
      declaredTarget: target, executionProviderId: TEMP_PROVIDER_ID, sessionSelection: resident,
    }), [{ source: "declared_target", selection: target }, { source: "session_selection", selection: resident }]);
  });
  it("no target leaves the session selection; none at all leaves no candidates", () => {
    assert.deepEqual(resolveExecutionFallbackCandidates({
      declaredTarget: undefined, executionProviderId: TEMP_PROVIDER_ID, sessionSelection: resident,
    }), [{ source: "session_selection", selection: resident }]);
    assert.deepEqual(resolveExecutionFallbackCandidates({
      declaredTarget: undefined, executionProviderId: TEMP_PROVIDER_ID, sessionSelection: undefined,
    }), []);
  });
  it("the execution provider itself is never a candidate and identical candidates dedupe", () => {
    assert.deepEqual(resolveExecutionFallbackCandidates({
      declaredTarget: { providerId: TEMP_PROVIDER_ID, modelId: "GLM-5.3" }, executionProviderId: TEMP_PROVIDER_ID, sessionSelection: target,
    }), [{ source: "session_selection", selection: target }]);
    assert.deepEqual(resolveExecutionFallbackCandidates({
      declaredTarget: target, executionProviderId: TEMP_PROVIDER_ID, sessionSelection: { ...target },
    }), [{ source: "declared_target", selection: target }]);
  });
  it("a declared same-provider fallback may swap in the provider's other model (F13.01)", () => {
    const other: ExecutionModelSelection = { providerId: TEMP_PROVIDER_ID, modelId: "GLM-5.3-Air" };
    assert.deepEqual(resolveExecutionFallbackCandidates({
      declaredTarget: other, executionProviderId: TEMP_PROVIDER_ID, executionModelId: "GLM-5.3", allowSameProvider: true, sessionSelection: resident,
    }), [{ source: "declared_target", selection: other }, { source: "session_selection", selection: resident }]);
    // Without the declaration the execution provider stays excluded, and even
    // with it an identical selection would only fail once more.
    assert.deepEqual(resolveExecutionFallbackCandidates({
      declaredTarget: other, executionProviderId: TEMP_PROVIDER_ID, executionModelId: "GLM-5.3", sessionSelection: resident,
    }), [{ source: "session_selection", selection: resident }]);
    assert.deepEqual(resolveExecutionFallbackCandidates({
      declaredTarget: { providerId: TEMP_PROVIDER_ID, modelId: "GLM-5.3" }, executionProviderId: TEMP_PROVIDER_ID,
      executionModelId: "GLM-5.3", allowSameProvider: true, sessionSelection: resident,
    }), [{ source: "session_selection", selection: resident }]);
  });
});

describe("matchExecutionSelectionFallback", () => {
  const match = (error: unknown, overrides: Partial<Parameters<typeof matchExecutionSelectionFallback>[0]> = {}) =>
    matchExecutionSelectionFallback({ error, executionProviderId: TEMP_PROVIDER_ID, selectionFallback: declaration, turnAborted: false, ...overrides });
  const failure = (init: ConstructorParameters<typeof ProviderRequestError>[0]): Error => new ProviderRequestError(init);

  it("a declared provider error code hits its rule first and keeps the attribution", () => {
    assert.deepEqual(match(failure({ status: 400, providerCode: "3402" })), { reason: "card_expired", providerErrorCode: "3402", statusCode: 400 });
  });
  for (const [label, init] of [
    ["auth failure", { status: 401 }],
    ["rate limited", { status: 429 }],
    ["server error", { status: 503 }],
    ["other business code", { status: 400, providerCode: "1234" }],
    ["stream idle timeout", { category: "timeout", stage: "read" }],
  ] as const) {
    it(`${label} hits the catch-all rule`, () => {
      assert.equal(match(failure(init as ConstructorParameters<typeof ProviderRequestError>[0]))?.reason, "execution_request_failed");
    });
  }
  it("no declaration, a user stop or another execution provider never falls back", () => {
    const error = failure({ status: 500 });
    assert.equal(match(error, { selectionFallback: undefined }), undefined);
    assert.equal(match(error, { turnAborted: true }), undefined);
    assert.equal(match(error, { executionProviderId: SESSION_PROVIDER_ID }), undefined);
  });
  it("local runtime failures without provider attribution never fall back", () => {
    assert.equal(match(new Error("event store append failed")), undefined);
    assert.equal(match(new ProviderCallbackError("ValueError")), undefined);
  });
  it("context-window overflow keeps the compaction path", () => {
    assert.equal(match(failure({ status: 400, contextOverflow: true })), undefined);
  });
  it("code-only declarations match just that code; declaration order is the priority", () => {
    const expiredOnly: SelectionFallbackDeclaration = { providerId: TEMP_PROVIDER_ID, rules: [declaration.rules[0]!] };
    assert.equal(match(failure({ status: 500 }), { selectionFallback: expiredOnly }), undefined);
    assert.equal(match(failure({ providerCode: "3402" }), { selectionFallback: expiredOnly })?.reason, "card_expired");
    const catchAllFirst: SelectionFallbackDeclaration = { providerId: TEMP_PROVIDER_ID, rules: [declaration.rules[1]!, declaration.rules[0]!] };
    assert.equal(match(failure({ providerCode: "3402" }), { selectionFallback: catchAllFirst })?.reason, "execution_request_failed");
  });
});

/** A scripted run with an execution-scoped temporary selection. */
function executionFixture(input: {
  resolve?: (selection: ExecutionModelSelection) => AgentProvider;
  sessionSelection?: Row;
  target?: ExecutionModelSelection;
}) {
  const local = fixture([], []);
  if (input.sessionSelection) local.session.model_selection = input.sessionSelection;
  const scope: ExecutionModelScope = {
    selection: { providerId: TEMP_PROVIDER_ID, modelId: "GLM-5.3-Turbo" },
    fallback: { ...declaration, ...(input.target ? { target: input.target } : {}) },
    resolveProvider: input.resolve ?? (() => { throw new Error("no resolver"); }),
  };
  return { ...local, scope };
}

describe("execution-scoped selection runtime", () => {
  it("a matching request failure gets one physical attempt, settles the stream, and continues on the session model", async () => {
    const events: AgentEvent[] = [];
    let tempCalls = 0;
    const tempAdapter: AgentProvider = {
      runtimeProfile: "standard", toolCalling: "native", model: "GLM-5.3-Turbo",
      async complete() { throw new ProviderRequestError({ status: 500, stage: "response" }); },
      async stream(_messages, _tools, observers) {
        tempCalls += 1;
        observers?.onDelta?.("partial from temporary model");
        observers?.onToolDelta?.({ index: 0, call_id: "temp-call-1", name: "read", partial_input: "{}", input_chars: 2, truncated: false });
        throw new ProviderRequestError({ status: 500, stage: "response" });
      },
    };
    const local = fixture([], [], { onEvent: (event) => { events.push(event); } });
    try {
      local.provider.complete = async () => ({ content: "done on the session model", _finish_reason: "stop", _usage: { total_tokens: 3 } });
      const scope: ExecutionModelScope = {
        selection: { providerId: TEMP_PROVIDER_ID, modelId: "GLM-5.3-Turbo" },
        fallback: declaration,
        resolveProvider: () => tempAdapter,
      };
      const finished = await local.runner.run(local.session, { maxSteps: 1, executionModel: scope, modelRetry: quick });
      assert.equal(finished.status, "completed");
      // SingleAttempt: the retryable 500 surfaces immediately instead of retrying the failed endpoint.
      assert.equal(tempCalls, 1);
      assert.equal(events.filter((event) => event.type === "model_retry_scheduled").length, 0);
      // The turn continued on the original session provider and finished there.
      assert.equal((local.session.messages as Row[]).at(-1)?.content, "done on the session model");
      // Settled exactly once: received facts recorded, no tool of the failed attempt executed or replayed.
      const history = local.session.execution_model_fallbacks as Row[];
      assert.equal(history.length, 1);
      assert.equal(history[0]?.applied, true);
      assert.match(String(history[0]?.at), /\+00:00$/);
      assert.equal(history[0]?.reason, "execution_request_failed");
      assert.equal(history[0]?.toSource, "session_selection");
      assert.equal((history[0]?.settled as Row)?.toolSnapshots, 1);
      assert.ok(Number((history[0]?.settled as Row)?.textChars) > 0);
      assert.equal(events.filter((event) => event.type === "model_execution_fallback").length, 1);
      // Trace correlation across the fallback boundary: the record names the exact
      // failed request/attempt, and the continuation shares the selection ID while
      // minting its own request.
      const requestEvents = events.filter((event) => String(event.type).startsWith("model_request_")) as Row[];
      const selectionIds = new Set(requestEvents.map((event) => event.selectionId));
      assert.equal(selectionIds.size, 1);
      const selectionId = requestEvents[0]?.selectionId;
      const failed = requestEvents.find((event) => event.type === "model_request_failed") as Row;
      const completed = requestEvents.find((event) => event.type === "model_request_completed") as Row;
      const fallback = events.find((event) => event.type === "model_execution_fallback") as Row;
      assert.equal(fallback.selectionId, selectionId);
      assert.equal(fallback.requestId, failed.requestId);
      assert.equal(fallback.attemptId, failed.attemptId);
      assert.equal(fallback.attempt, failed.attempt);
      assert.equal(completed.selectionId, selectionId);
      assert.notEqual(completed.requestId, failed.requestId);
      assert.equal(history[0]?.selectionId, selectionId);
      assert.equal(history[0]?.requestId, failed.requestId);
      assert.equal(history[0]?.attemptId, failed.attemptId);
      assert.deepEqual((local.session.messages as Row[]).filter((message) => Array.isArray(message.tool_calls)), []);
      assert.equal(Object.hasOwn(local.session, "model_selection"), false);
      // The execution scope ended: a later run uses the session binding again.
      local.session.status = "awaiting_user";
      (local.session.messages as Row[]).push({ role: "user", content: "continue" });
      local.provider.complete = async () => ({ content: "second run", _finish_reason: "stop", _usage: { total_tokens: 1 } });
      await local.runner.run(local.session, { modelRetry: quick });
      assert.equal((local.session.messages as Row[]).at(-1)?.content, "second run");
      assert.equal(tempCalls, 1);
    } finally { local.close(); }
  });

  it("a selection the registry cannot resolve fails the run before any model request", async () => {
    let resolved = 0;
    const local = executionFixture({
      resolve: () => { resolved += 1; throw new ModelSelectionLookupError("provider profile not found", { providerId: TEMP_PROVIDER_ID, modelId: "GLM-5.3-Turbo" }); },
    });
    try {
      await assert.rejects(local.runner.run(local.session, { executionModel: local.scope, modelRetry: quick }), ModelSelectionLookupError);
      assert.equal(resolved, 1);
      assert.equal(local.session.status, "pending");
      assert.equal(Object.hasOwn(local.session, "execution_model_fallbacks"), false);
      assert.equal(Object.hasOwn(local.session, "model_selection"), false);
    } finally { local.close(); }
  });

  it("an unresolvable declared target skips to the session selection instead of hiding the model failure", async () => {
    const resolutions: string[] = [];
    const sessionAdapter: AgentProvider = { runtimeProfile: "standard", toolCalling: "native", model: "GLM-5.3", async complete() { return { content: "recovered on session selection", _finish_reason: "stop", _usage: { total_tokens: 2 } }; } };
    const tempAdapter: AgentProvider = { runtimeProfile: "standard", toolCalling: "native", model: "GLM-5.3-Turbo", async complete() { throw new ProviderRequestError({ status: 500, stage: "response" }); } };
    const local = fixture([], []);
    local.session.model_selection = { provider_id: SESSION_PROVIDER_ID, model: "GLM-5.3", reasoning_effort: null };
    try {
      const scope: ExecutionModelScope = {
        selection: { providerId: TEMP_PROVIDER_ID, modelId: "GLM-5.3-Turbo" },
        fallback: { ...declaration, target: { providerId: "builtin:missing", modelId: "GLM-4" } },
        resolveProvider: (selection) => {
          resolutions.push(`${selection.providerId}/${selection.modelId}`);
          if (selection.providerId === TEMP_PROVIDER_ID) return tempAdapter;
          if (selection.providerId === "builtin:missing") {
            const error = new Error("provider profile not found");
            error.name = "ValueError";
            throw error;
          }
          return sessionAdapter;
        },
      };
      await local.runner.run(local.session, { executionModel: scope, modelRetry: quick });
      assert.deepEqual(resolutions, ["account:temp-execution/GLM-5.3-Turbo", "builtin:missing/GLM-4", "builtin:session/GLM-5.3"]);
      const history = local.session.execution_model_fallbacks as Row[];
      assert.equal(history[0]?.applied, true);
      assert.equal(history[0]?.toSource, "session_selection");
      assert.deepEqual(history[0]?.skipped, [{ source: "declared_target", providerId: "builtin:missing", modelId: "GLM-4", error: "provider profile not found" }]);
      assert.equal((local.session.messages as Row[]).at(-1)?.content, "recovered on session selection");
      // The session's own default selection is exactly what it was.
      assert.deepEqual(local.session.model_selection, { provider_id: SESSION_PROVIDER_ID, model: "GLM-5.3", reasoning_effort: null });
    } finally { local.close(); }
  });

  it("nowhere to fall back keeps the original error and still settles the accepted stream", async () => {
    const events: AgentEvent[] = [];
    // The temporary selection resolves to the run's own session binding: no other target exists.
    const shared: AgentProvider = { runtimeProfile: "standard", toolCalling: "native", model: "GLM-5.3", async complete() { throw new ProviderRequestError({ status: 500, stage: "response" }); } };
    const local = fixture([], [], { provider: shared, onEvent: (event) => { events.push(event); } });
    try {
      const scope: ExecutionModelScope = {
        selection: { providerId: TEMP_PROVIDER_ID, modelId: "GLM-5.3-Turbo" },
        fallback: declaration,
        resolveProvider: () => shared,
      };
      await assert.rejects(local.runner.run(local.session, { executionModel: scope, modelRetry: quick }), ProviderRequestError);
      const history = local.session.execution_model_fallbacks as Row[];
      assert.equal(history.length, 1);
      assert.equal(history[0]?.applied, false);
      assert.equal(history[0]?.reason, "execution_request_failed");
      assert.equal(events.filter((event) => event.type === "model_execution_fallback_unavailable").length, 1);
      assert.equal(Object.hasOwn(local.session, "model_selection"), false);
    } finally { local.close(); }
  });

  it("falls back at most once: the fallback model's own failure ends the turn with its real error", async () => {
    let sessionCalls = 0;
    const tempAdapter: AgentProvider = { runtimeProfile: "standard", toolCalling: "native", model: "GLM-5.3-Turbo", async complete() { throw new ProviderRequestError({ status: 500, stage: "response" }); } };
    const local = fixture([], []);
    local.provider.complete = async () => { sessionCalls += 1; throw new ProviderRequestError({ status: 503, stage: "response" }); };
    try {
      const scope: ExecutionModelScope = {
        selection: { providerId: TEMP_PROVIDER_ID, modelId: "GLM-5.3-Turbo" },
        fallback: declaration,
        resolveProvider: () => tempAdapter,
      };
      await assert.rejects(local.runner.run(local.session, { executionModel: scope, modelRetry: { ...quick, maxAttempts: 1 } }), ProviderRequestError);
      assert.equal(sessionCalls, 1);
      assert.equal((local.session.execution_model_fallbacks as Row[]).length, 1);
      assert.equal((local.session.execution_model_fallbacks as Row[])[0]?.applied, true);
    } finally { local.close(); }
  });

  it("a run without a fallback declaration retries through the ordinary budget", async () => {
    let calls = 0;
    const tempAdapter: AgentProvider = { runtimeProfile: "standard", toolCalling: "native", model: "GLM-5.3-Turbo",
      async complete() { calls += 1; return calls === 1 ? { content: "", _finish_reason: "unknown", _usage: { total_tokens: 0 } } : { content: "after retry", _finish_reason: "stop", _usage: { total_tokens: 2 } }; } };
    const local = fixture([], []);
    try {
      const scope: ExecutionModelScope = { selection: { providerId: TEMP_PROVIDER_ID, modelId: "GLM-5.3-Turbo" }, resolveProvider: () => tempAdapter };
      await local.runner.run(local.session, { executionModel: scope, modelRetry: { ...quick, maxAttempts: 2 } });
      assert.equal(calls, 2);
      assert.equal(Object.hasOwn(local.session, "execution_model_fallbacks"), false);
    } finally { local.close(); }
  });
});
