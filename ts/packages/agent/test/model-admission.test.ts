import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ProviderRequestError } from "@xueness/providers";
import type { AgentEvent, Row } from "../src/index.ts";
import { ProviderAdmissionController, providerAdmissionForState } from "../../../plugins/providers/src/admission-policy.ts";
import { providerModelExecutionExtension } from "../../../plugins/providers/src/model-execution.ts";
import { reasoningOrigin } from "../../../packages/providers/src/reasoning-metadata.ts";
import { fixture } from "./fixtures.ts";

const singleAttempt = { baseDelayMs: 0, jitter: false, maxAttempts: 1, random: () => 0 };
/** Snapshot totals without the plugin's per-model AIMD detail and change ring. */
function totals(admission: ProviderAdmissionController): Record<string, number> {
  const { models, changes, ...rest } = admission.snapshot();
  void models; void changes;
  return rest;
}

function deferred<T = void>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 3000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

async function waitUntil(condition: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
}

function withModelEnvironment(values: { maxConcurrent?: string; debug?: string }): () => void {
  const previous = { maxConcurrent: process.env.XUENESS_MODEL_MAX_CONCURRENT, debug: process.env.XUENESS_MODEL_DEBUG };
  if (values.maxConcurrent === undefined) delete process.env.XUENESS_MODEL_MAX_CONCURRENT;
  else process.env.XUENESS_MODEL_MAX_CONCURRENT = values.maxConcurrent;
  if (values.debug === undefined) delete process.env.XUENESS_MODEL_DEBUG;
  else process.env.XUENESS_MODEL_DEBUG = values.debug;
  return () => {
    if (previous.maxConcurrent === undefined) delete process.env.XUENESS_MODEL_MAX_CONCURRENT;
    else process.env.XUENESS_MODEL_MAX_CONCURRENT = previous.maxConcurrent;
    if (previous.debug === undefined) delete process.env.XUENESS_MODEL_DEBUG;
    else process.env.XUENESS_MODEL_DEBUG = previous.debug;
  };
}

function setProviderIdentity(local: ReturnType<typeof fixture>): void {
  Object.defineProperties(local.provider, {
    model: { configurable: true, value: "shared-test-model" },
    base: { configurable: true, value: "https://provider.test/v1" },
  });
}

function forkSession(local: ReturnType<typeof fixture>, id: string, prompt: string): typeof local.session {
  const copy = structuredClone(local.session);
  copy.id = id;
  copy.root = local.directory;
  const user = (copy.messages as Row[]).find((message) => message.role === "user");
  assert.ok(user);
  user.content = prompt;
  return copy;
}

function modelEvents(events: AgentEvent[]): AgentEvent[] {
  return events.filter((event) => String(event.type).startsWith("model_request_"));
}

function debugRecords(stateDir: string): Row[] {
  const directory = join(stateDir, "model-debug");
  return readdirSync(directory).filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(join(directory, name), "utf8")) as Row);
}

describe("agent model request admission", () => {
  it("runs FIFO at one slot for the same state/model and publishes queued, admitted and started", async () => {
    const restoreEnv = withModelEnvironment({ maxConcurrent: "1" });
    const events: AgentEvent[] = [];
    const queueSignals = [deferred<void>(), deferred<void>()];
    let queuedCount = 0;
    const local = fixture([], [], { onEvent: (event) => {
      events.push(event);
      if (event.type === "model_request_queued") queueSignals[queuedCount++]?.resolve();
    } });
    local.hooks.extensions = [providerModelExecutionExtension()];
    setProviderIdentity(local);
    const second = forkSession(local, "b".repeat(32), "second queued request");
    const third = forkSession(local, "c".repeat(32), "third queued request");
    const firstEntered = deferred<void>();
    const releaseFirst = deferred<void>();
    const calls: string[] = [];
    local.provider.complete = async (messages) => {
      const prompt = String(messages.find((message) => message.role === "user")?.content);
      calls.push(prompt);
      if (prompt === "task") { firstEntered.resolve(); await releaseFirst.promise; }
      return { content: `answer for ${prompt}` };
    };
    const runs: Promise<unknown>[] = [];
    try {
      runs.push(local.runner.run(local.session, { modelRetry: singleAttempt }));
      await within(firstEntered.promise, "first provider request");
      const admission = providerAdmissionForState(local.store.directory);
      assert.ok(admission);
      assert.deepEqual(totals(admission), { limit: 1, active: 1, queued: 0, buckets: 1 });

      runs.push(local.runner.run(second, { modelRetry: singleAttempt }));
      await within(queueSignals[0]!.promise, "first queued request");
      await waitUntil(() => admission.snapshot().queued === 1, "first admission waiter");
      runs.push(local.runner.run(third, { modelRetry: singleAttempt }));
      await within(queueSignals[1]!.promise, "second queued request");
      await waitUntil(() => admission.snapshot().queued === 2, "second admission waiter");
      assert.deepEqual(totals(admission), { limit: 1, active: 1, queued: 2, buckets: 1 });
      releaseFirst.resolve();
      await Promise.all(runs);

      assert.deepEqual(calls, ["task", "second queued request", "third queued request"]);
      const model = modelEvents(events);
      const queued = model.filter((event) => event.type === "model_request_queued");
      const admitted = model.filter((event) => event.type === "model_request_admitted");
      const started = model.filter((event) => event.type === "model_request_started");
      assert.equal(queued.length, 2);
      assert.equal(admitted.length, 2);
      assert.equal(started.length, 3);
      assert.deepEqual(admitted.map((event) => event.requestId), queued.map((event) => event.requestId));
      assert.deepEqual(started.slice(1).map((event) => event.requestId), queued.map((event) => event.requestId));
      for (const event of queued) {
        const requestId = event.requestId;
        assert.ok(model.findIndex((row) => row.type === "model_request_queued" && row.requestId === requestId)
          < model.findIndex((row) => row.type === "model_request_admitted" && row.requestId === requestId));
        assert.ok(model.findIndex((row) => row.type === "model_request_admitted" && row.requestId === requestId)
          < model.findIndex((row) => row.type === "model_request_started" && row.requestId === requestId));
      }
      assert.deepEqual(totals(admission), { limit: 1, active: 0, queued: 0, buckets: 0 });
    } finally {
      releaseFirst.resolve();
      await Promise.allSettled(runs);
      restoreEnv();
      local.close();
    }
  });

  it("cancels a queued run without calling the provider and releases its session lease", async () => {
    const restoreEnv = withModelEnvironment({ maxConcurrent: "1" });
    const events: AgentEvent[] = [];
    const queued = deferred<AgentEvent>();
    const local = fixture([], [], { onEvent: (event) => {
      events.push(event);
      if (event.type === "model_request_queued") queued.resolve(event);
    } });
    local.hooks.extensions = [providerModelExecutionExtension()];
    setProviderIdentity(local);
    const waiting = forkSession(local, "d".repeat(32), "cancel while queued");
    const firstEntered = deferred<void>();
    const releaseFirst = deferred<void>();
    const calls: string[] = [];
    local.provider.complete = async (messages) => {
      const prompt = String(messages.find((message) => message.role === "user")?.content);
      calls.push(prompt);
      firstEntered.resolve();
      if (prompt === "task") await releaseFirst.promise;
      return { content: "first request completes" };
    };
    let firstRun: Promise<unknown> | undefined;
    let waitingRun: Promise<unknown> | undefined;
    const controller = new AbortController();
    try {
      firstRun = local.runner.run(local.session, { modelRetry: singleAttempt });
      await within(firstEntered.promise, "first provider request");
      waitingRun = local.runner.run(waiting, { signal: controller.signal, modelRetry: singleAttempt });
      const queuedEvent = await within(queued.promise, "queued model event");
      const admission = providerAdmissionForState(local.store.directory);
      assert.ok(admission);
      await waitUntil(() => admission.snapshot().queued === 1, "cancelled admission waiter");
      controller.abort("operator stopped waiting");
      await within(waitingRun, "cancelled queued run");

      assert.equal(waiting.status, "stopped");
      assert.deepEqual(calls, ["task"]);
      assert.equal(events.some((event) => event.type === "model_request_started" && event.requestId === queuedEvent.requestId), false);
      assert.deepEqual(totals(admission), { limit: 1, active: 1, queued: 0, buckets: 1 });
      const lease = await local.store.lease(String(waiting.id));
      await lease.release();

      releaseFirst.resolve();
      await within(firstRun, "first provider request completion");
      assert.deepEqual(totals(admission), { limit: 1, active: 0, queued: 0, buckets: 0 });
    } finally {
      releaseFirst.resolve();
      await Promise.allSettled([firstRun, waitingRun].filter((run): run is Promise<unknown> => !!run));
      restoreEnv();
      local.close();
    }
  });

  it("releases a failed request before backoff so a queued request runs before its retry", async () => {
    const admission = new ProviderAdmissionController(1);
    const queued = deferred<void>();
    const allowFailure = deferred<void>();
    const firstEntered = deferred<void>();
    const calls: string[] = [];
    let secondQueued = false;
    const runnerEvents: AgentEvent[] = [];
    const eventFixture = fixture([], [], { onEvent: (event) => {
      runnerEvents.push(event);
      if (event.type === "model_request_queued") { secondQueued = true; queued.resolve(); }
    } });
    setProviderIdentity(eventFixture);
    const secondSession = forkSession(eventFixture, "f".repeat(32), "queued request");
    eventFixture.provider.complete = async (messages) => {
      const prompt = String(messages.find((message) => message.role === "user")?.content);
      if (prompt === "task") {
        const attempt = calls.filter((call) => call.startsWith("retry request")).length + 1;
        calls.push(`retry request ${attempt}`);
        if (attempt === 1) { firstEntered.resolve(); await allowFailure.promise; throw new ProviderRequestError({ status: 503 }); }
        return { content: "retry completed" };
      }
      calls.push(prompt);
      return { content: "queued completed" };
    };
    const runs: Promise<unknown>[] = [];
    try {
      runs.push(eventFixture.runner.run(eventFixture.session, { modelRetry: { baseDelayMs: 120, jitter: false, maxAttempts: 2, random: () => 0 }, modelRequestAdmission: admission }));
      await within(firstEntered.promise, "first retry attempt");
      runs.push(eventFixture.runner.run(secondSession, { modelRetry: singleAttempt, modelRequestAdmission: admission }));
      await within(queued.promise, "second request queue");
      await waitUntil(() => admission.snapshot().queued === 1, "second admission waiter");
      allowFailure.resolve();
      await Promise.all(runs);
      assert.equal(secondQueued, true);
      assert.deepEqual(calls, ["retry request 1", "queued request", "retry request 2"]);
      assert.deepEqual(totals(admission), { limit: 1, active: 0, queued: 0, buckets: 0 });
      assert.equal(runnerEvents.filter((event) => event.type === "model_retry_scheduled").length, 1);
    } finally {
      allowFailure.resolve();
      await Promise.allSettled(runs);
      eventFixture.close();
    }
  });

  it("rebinds media per retry, releases each binding, and leaves the journal message intact", async () => {
    let bindings = 0;
    let releases = 0;
    const seen: Array<{ content: string; media: unknown }> = [];
    const sourcePrompts: string[] = [];
    let originalMessage: Row | undefined;
    let originalSnapshot: Row | undefined;
    const local = fixture([], [], { bindPrompt: (_context, messages) => {
      bindings += 1;
      if (bindings === 2) assert.equal(releases, 1);
      originalMessage ??= (local.session.messages as Row[]).find((message) => message.role === "user");
      if (originalMessage && !originalSnapshot) originalSnapshot = structuredClone(originalMessage);
      const source = messages.find((message) => message.role === "user");
      assert.ok(source);
      sourcePrompts.push(String(source.content));
      const bound = messages.map((message) => message.role === "user"
        ? { ...message, content: `${String(message.content)} [bound-${bindings}]` } : { ...message });
      return { messages: bound, media: { binding: bindings } as never, release() { releases += 1; } };
    } });
    setProviderIdentity(local);
    const admission = new ProviderAdmissionController(1);
    local.provider.complete = async (messages, _tools, options) => {
      seen.push({ content: String(messages.find((message) => message.role === "user")?.content), media: options?.media });
      if (seen.length === 1) throw new ProviderRequestError({ status: 503 });
      return { content: "rebound answer" };
    };
    try {
      await local.runner.run(local.session, { modelRetry: { baseDelayMs: 0, jitter: false, maxAttempts: 2 }, modelRequestAdmission: admission });
      assert.equal(bindings, 2);
      assert.equal(releases, 2);
      assert.deepEqual(sourcePrompts, ["task", "task"]);
      assert.deepEqual(seen.map((call) => call.content), ["task [bound-1]", "task [bound-2]"]);
      assert.notEqual(seen[0]?.media, seen[1]?.media);
      const user = (local.session.messages as Row[]).find((message) => message.role === "user");
      assert.equal(user, originalMessage);
      assert.deepEqual(user, originalSnapshot);
      assert.deepEqual(totals(admission), { limit: 1, active: 0, queued: 0, buckets: 0 });
    } finally { local.close(); }
  });

  it("records numeric-only completion/failure diagnostics and counts hidden reasoning", async () => {
    const restoreEnv = withModelEnvironment({ maxConcurrent: "0", debug: "1" });
    const successEvents: AgentEvent[] = [];
    const success = fixture([], [], { onEvent: (event) => { successEvents.push(event); } });
    success.hooks.extensions = [providerModelExecutionExtension()];
    success.hooks.showReasoning = () => false;
    setProviderIdentity(success);
    const hiddenSuccess = "secret successful reasoning";
    const visible = "visible successful answer";
    (success.session.messages as Row[])[1]!.content = "private request prompt";
    success.provider.stream = async (_messages, _tools, observers) => {
      observers?.onReasoningDelta?.(hiddenSuccess);
      observers?.onDelta?.(visible);
      return { content: visible, _finish_reason: "stop" };
    };

    const failureEvents: AgentEvent[] = [];
    const failure = fixture([], [], { onEvent: (event) => { failureEvents.push(event); } });
    failure.hooks.extensions = [providerModelExecutionExtension()];
    failure.hooks.showReasoning = () => false;
    setProviderIdentity(failure);
    const hiddenFailure = "secret failed reasoning";
    (failure.session.messages as Row[])[1]!.content = "private failing prompt";
    failure.provider.stream = async (_messages, _tools, observers) => {
      observers?.onReasoningDelta?.(hiddenFailure);
      throw new ProviderRequestError({ status: 401 });
    };

    try {
      await success.runner.run(success.session);
      await assert.rejects(failure.runner.run(failure.session, { modelRetry: singleAttempt }), ProviderRequestError);
      for (const [local, events, hidden] of [[success, successEvents, hiddenSuccess], [failure, failureEvents, hiddenFailure]] as const) {
        const type = local === success ? "model_request_completed" : "model_request_failed";
        const event = events.find((item) => item.type === type);
        assert.ok(event);
        const diagnostics = event.diagnostics as Row;
        assert.equal(diagnostics.reasoningChunks, 1);
        assert.equal(diagnostics.reasoningChars, hidden.length);
        assert.ok(Object.values(diagnostics).every((value) => typeof value === "number"));
        assert.equal(JSON.stringify(events).includes(hidden), false);
        assert.equal(JSON.stringify(local.session).includes(hidden), false);

        const records = debugRecords(local.store.directory);
        assert.equal(records.length, 1);
        const record = records[0]!;
        assert.equal(record.type, type);
        for (const field of ["request", "diagnostics", ...(type === "model_request_completed" ? ["response"] : [])]) {
          const metrics = record[field] as Row;
          assert.ok(Object.values(metrics).every((value) => typeof value === "number"));
        }
        const serialized = JSON.stringify(record);
        assert.equal(serialized.includes(hidden), false);
        assert.equal(serialized.includes(local === success ? "private request prompt" : "private failing prompt"), false);
      }
      const completedDiagnostics = (successEvents.find((item) => item.type === "model_request_completed")?.diagnostics as Row);
      assert.equal(completedDiagnostics.textChunks, 1);
      assert.equal(completedDiagnostics.textChars, visible.length);
      assert.equal(successEvents.some((event) => event.type === "reasoning_delta"), false);
    } finally {
      restoreEnv();
      success.close();
      failure.close();
    }
  });

  it("clears queued runs on provider disable, wall deadline, and host abort", async () => {
    for (const scenario of ["disabled", "deadline", "host"] as const) {
      const host = new AbortController();
      const local = fixture([], [], scenario === "host" ? { hostSignal: host.signal } : {});
      setProviderIdentity(local);
      const admission = new ProviderAdmissionController(1);
      const held = await admission.acquire({ model: reasoningOrigin({ model: "shared-test-model", base: "https://provider.test/v1" }) });
      let queuedHooks = 0, failedHooks = 0;
      if (scenario === "disabled") local.hooks.extensions = [{ id: "providers",
        modelRequestQueued() { queuedHooks += 1; }, modelRequestFailed() { failedHooks += 1; } }];
      let run: Promise<typeof local.session> | undefined;
      try {
        run = local.runner.run(local.session, { modelRetry: singleAttempt, modelRequestAdmission: admission,
          ...(scenario === "deadline" ? { maxWallSeconds: 0.35 } : {}) });
        await waitUntil(() => admission.snapshot().queued === 1, `${scenario} waiter`);
        if (scenario === "disabled") local.hooks.enabled = (id) => id !== "providers" && ["sessions", "files"].includes(id);
        if (scenario === "host") host.abort("host stopped");
        const result = await within(run, `${scenario} queued run`);

        assert.equal(local.requests(), 0, `${scenario} must not call provider`);
        assert.equal(admission.snapshot().queued, 0, `${scenario} must remove its waiter`);
        assert.deepEqual(totals(admission), { limit: 1, active: 1, queued: 0, buckets: 1 });
        assert.equal(result.status, scenario === "host" ? "stopped" : "paused");
        if (scenario === "deadline") assert.equal(result.pause_code, "wall_time_limit_reached");
        if (scenario === "disabled") { assert.equal(queuedHooks, 1); assert.equal(failedHooks, 0); }
        const lease = await local.store.lease(String(local.session.id));
        await lease.release();
        held.release();
        assert.deepEqual(totals(admission), { limit: 1, active: 0, queued: 0, buckets: 0 });
      } finally {
        held.release();
        if (run) await Promise.allSettled([run]);
        local.close();
      }
    }
  });
});
