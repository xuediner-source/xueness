import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { it } from "node:test";
import { recoverRuntimeProjection, reduceSessionRuntimeEvents, type SessionRuntimeEvent } from "@xueness/contracts";
import { SessionStore } from "@xueness/sessions";
import type { AgentContext, AgentEvent, AgentExtension } from "@xueness/agent";
import { createSessionRuntimeEventsApi } from "../src/runtime-event-api.ts";
import { sessionsRuntimeEventsExtension } from "../src/runtime-event-extension.ts";
import { RuntimeEventLogError, createSessionRuntimeEventLog } from "../src/runtime-event-log.ts";

const sid = "a".repeat(32);
function temp(): { root: string; stateDir: string } {
  const root = mkdtempSync(join(tmpdir(), "xueness-runtime-events-")), stateDir = join(root, "state");
  mkdirSync(stateDir);
  return { root, stateDir };
}
function event(sequenceNumber: number, type: SessionRuntimeEvent["type"], payload: Record<string, unknown> = {}): SessionRuntimeEvent {
  return { schema: "xueness.session-runtime.v1", id: `event-${sequenceNumber}`, sessionId: sid, type, timestamp: "2026-10-22T00:00:00.000Z", sequenceNumber, payload };
}

it("recovers a bounded projection across cold instances and pages", () => {
  const { root, stateDir } = temp();
  try {
    const log = createSessionRuntimeEventLog(stateDir, sid);
    log.append({ type: "RunStarted", turnId: "turn-1", payload: { streamRecoveryAnchor: { streamId: "stream-old", status: "interrupted" } } });
    log.append({ type: "AssistantDelta", turnId: "turn-1", payload: { streamId: "stream-1", text: "hello" } });
    log.append({ type: "ToolCall", turnId: "turn-1", payload: { toolCallId: "call-1", name: "read" } });
    log.append({ type: "ToolResult", turnId: "turn-1", payload: { toolCallId: "call-1", name: "read", ok: true } });
    log.append({ type: "AssistantMessage", turnId: "turn-1", payload: { text: "done" } });
    log.append({ type: "RunSettled", turnId: "turn-1", payload: { status: "completed", returned: true } });
    const cold = createSessionRuntimeEventLog(stateDir, sid), first = cold.readPage({ after: 0, limit: 3 });
    const snapshot = recoverRuntimeProjection(first);
    const second = createSessionRuntimeEventLog(stateDir, sid).readPage({ after: first.next, epoch: first.epoch, limit: 3 });
    const recovered = recoverRuntimeProjection(second, snapshot);
    assert.equal(recovered.lastSequenceNumber, 6);
    assert.equal(recovered.status, "completed");
    assert.equal(recovered.transcript.at(-1)?.text, "done");
    assert.deepEqual(recovered.tools.map(({ id, status }) => ({ id, status })), [{ id: "call-1", status: "succeeded" }]);
    assert.equal(recovered.stream, null);
    assert.equal(recovered.streamRecoveryAnchor, undefined);
    assert.equal(second.head, 6);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("skips duplicate and backward events while marking sequence gaps", () => {
  const start = event(1, "RunStarted"), delta = event(3, "AssistantDelta", { streamId: "s", text: "x" });
  const state = reduceSessionRuntimeEvents([start, delta, delta, event(2, "AssistantDelta", { streamId: "s", text: "old" })]);
  assert.equal(state.lastSequenceNumber, 3);
  assert.deepEqual(state.gaps, [{ expected: 2, received: 3 }]);
  assert.equal(state.stream?.assistantText, "x");
});

it("serializes appends from independent worker instances without reusing sequence numbers", async () => {
  const { root, stateDir } = temp();
  try {
    const moduleUrl = new URL("../src/runtime-event-log.ts", import.meta.url).href;
    const code = `const { parentPort, workerData } = require("node:worker_threads");\n(async () => { const { SessionRuntimeEventLog } = await import(workerData.moduleUrl); const log = new SessionRuntimeEventLog(workerData.stateDir, workerData.sid); for (let i = 0; i < workerData.count; i++) log.append({ type: "TurnPhase", payload: { phase: "worker" } }); parentPort.postMessage("done"); })().catch((error) => { throw error; });`;
    const workers = Array.from({ length: 4 }, () => new Worker(code, { eval: true, workerData: { moduleUrl, stateDir, sid, count: 8 } }));
    await Promise.all(workers.map((worker) => new Promise<void>((resolve, reject) => {
      worker.once("message", () => resolve()); worker.once("error", reject); worker.once("exit", (code) => { if (code !== 0) reject(new Error(`worker exited ${code}`)); });
    })));
    const page = createSessionRuntimeEventLog(stateDir, sid).readPage({ limit: 500 });
    assert.equal(page.head, 32);
    assert.deepEqual(page.events.map((row) => row.sequenceNumber), Array.from({ length: 32 }, (_, i) => i + 1));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("repairs only a torn final line and rejects a complete corrupt record", () => {
  const { root, stateDir } = temp();
  try {
    const log = createSessionRuntimeEventLog(stateDir, sid);
    log.append({ type: "RunStarted", payload: {} });
    appendFileSync(log.path, "{\"unfinished\":");
    assert.equal(createSessionRuntimeEventLog(stateDir, sid).readPage().head, 1);
    assert.ok(readFileSync(log.path, "utf8").endsWith("\n"));
    appendFileSync(log.path, "{not-json}\n");
    assert.throws(() => createSessionRuntimeEventLog(stateDir, sid).readPage(), RuntimeEventLogError);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("enforces workspace, epoch, and forward-cursor checks on the runtime endpoint", async () => {
  const { root, stateDir } = temp();
  try {
    const store = new SessionStore(stateDir), session = await store.new("runtime", root, { sessionId: sid });
    const log = createSessionRuntimeEventLog(stateDir, sid); log.append({ type: "RunStarted", payload: {} });
    const api = createSessionRuntimeEventsApi({ store, stateDir, webRuns: join(root, "web-runs"), projectDir: root, enabled: () => true });
    const path = ["api", "sessions", sid, "events.runtime"];
    const dispatch = (query: Record<string, unknown>) => api.dispatch("GET", path, query, {});
    const missingEpoch = await dispatch({ after: ["1"] });
    assert.equal(missingEpoch?.[0], 400);
    const wrongEpoch = await dispatch({ after: ["0"], epoch: ["0".repeat(36)] });
    assert.equal(wrongEpoch?.[0], 409);
    const ahead = await dispatch({ after: ["2"], epoch: [log.metadata().epoch] });
    assert.equal(ahead?.[0], 409);
    const allowed = await dispatch({ after: ["0"], limit: ["1"] });
    assert.equal(allowed?.[0], 200);
    assert.equal((allowed?.[1] as { head: number }).head, 1);
    const stream = await api.dispatch("GET", path, { after: ["0"], limit: ["1"] }, {}, { accept: "text/event-stream" });
    assert.equal(stream?.[0], 200);
    assert.match((stream?.[1] as Buffer).toString("utf8"), new RegExp(`^id: re1\\.${log.metadata().epoch}\\.1\\n`));
    const deniedApi = createSessionRuntimeEventsApi({ store, stateDir, webRuns: join(root, "web-runs"), projectDir: join(root, "elsewhere"), enabled: () => true });
    assert.equal((await deniedApi.dispatch("GET", path, {}, {}))?.[0], 403);
    assert.equal(session.id, sid);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("keeps runtime hook events free of tool inputs, results, and private session fields", async () => {
  const { root, stateDir } = temp();
  try {
    const session = { id: sid, status: "running", steps: 1, active_turn_id: "turn-1", streaming: { id: "stream-1", status: "streaming", text: "secret stream text", _read_state: { secret: true } }, reasoning_history: [{ text: "secret hidden reasoning" }] };
    const context = { session, store: {} as AgentContext["store"], provider: {} as AgentContext["provider"], stateDir, root, signal: new AbortController().signal, deadline: 1, options: {}, save: async () => {}, enabled: () => true, emit: () => {} } as unknown as AgentContext;
    const ext = sessionsRuntimeEventsExtension() as AgentExtension & { recordEvent(context: AgentContext, event: AgentEvent): void };
    await ext.beforeRun?.(context); await ext.runStarted?.(context);
    ext.recordEvent(context, { type: "tool_call", id: "call-1", name: "read", subject: "secret tool input" });
    ext.recordEvent(context, { type: "tool_result", id: "call-1", name: "read", ok: false, error: "secret tool result", result: { private: true } });
    await ext.settleRun?.(context, true);
    const log = createSessionRuntimeEventLog(stateDir, sid);
    log.append({ type: "ToolCall", payload: { toolCallId: "call-2", name: "read", input: "secret direct input", subject: "private" } });
    const page = log.readPage({ limit: 500 }), serialized = JSON.stringify(page.events);
    assert.equal(serialized.includes("secret"), false);
    assert.equal(serialized.includes("_read_state"), false);
    assert.deepEqual(page.events.find((row) => row.type === "ToolCall")?.payload, { toolCallId: "call-1", name: "read" });
    assert.deepEqual(page.events.find((row) => row.type === "ToolResult")?.payload, { toolCallId: "call-1", name: "read", ok: false });
    assert.equal(page.events[0]?.type, "RunStarted");
    assert.equal(log.metadata().lastSequenceNumber, 5);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("projects the model trace ledger with correlated IDs while usage stays honest and secrets never land", async () => {
  const { root, stateDir } = temp();
  try {
    const session = { id: sid, status: "running", steps: 1, active_turn_id: "turn-1", streaming: null };
    const context = { session, store: {} as AgentContext["store"], provider: {} as AgentContext["provider"], stateDir, root, signal: new AbortController().signal, deadline: 1, options: {}, save: async () => {}, enabled: () => true, emit: () => {} } as unknown as AgentContext;
    const ext = sessionsRuntimeEventsExtension() as AgentExtension & { recordEvent(context: AgentContext, event: AgentEvent): void };
    await ext.beforeRun?.(context); await ext.runStarted?.(context);
    ext.recordEvent(context, { type: "model_request_started", requestId: "req-1", attemptId: "att-1", selectionId: "sel-1", attempt: 1, maxAttempts: 3, modelId: "GLM-5.3", providerKind: "openai" });
    ext.recordEvent(context, { type: "model_request_failed", requestId: "req-1", attemptId: "att-1", selectionId: "sel-1", attempt: 1, maxAttempts: 3, reason: "server_error", errorCode: "model_server_error", message: "provider said Bearer sk-secret-123 is invalid", retryable: true, terminal: false, statusCode: 503, durationMs: 40 });
    ext.recordEvent(context, { type: "model_retry_scheduled", requestId: "req-1", attemptId: "att-1", selectionId: "sel-1", attempt: 1, nextAttempt: 2, maxAttempts: 3, delayMs: 120, reason: "server_error", errorCode: "model_server_error", message: "retry because sk-secret-123", statusCode: 503 });
    ext.recordEvent(context, { type: "model_request_started", requestId: "req-1", attemptId: "att-2", selectionId: "sel-1", attempt: 2, maxAttempts: 3 });
    ext.recordEvent(context, { type: "model_request_completed", requestId: "req-1", attemptId: "att-2", selectionId: "sel-1", attempt: 2, maxAttempts: 3, durationMs: 1500.5, queuedMs: 40.25, response: { contentChars: 12, toolCalls: 0 }, usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cache_read_input_tokens: "not-a-number" } });
    ext.recordEvent(context, { type: "model_request_completed", requestId: "req-2", attemptId: "att-3", selectionId: "sel-1", attempt: 1, response: { contentChars: 3, toolCalls: 0 } });
    ext.recordEvent(context, { type: "model_execution_fallback", selectionId: "sel-1", requestId: "req-2", attemptId: "att-3", attempt: 1, applied: true, from: { providerId: "account:temp", modelId: "GLM-5.3-Turbo" }, to: { providerId: "builtin:session", modelId: "GLM-5.3" }, toSource: "session_selection", reason: "execution_request_failed", providerErrorCode: "3402", statusCode: 400, settled: { streamId: "stream-9", textChars: 7, reasoningChars: 0, toolSnapshots: 1, truncated: false }, skipped: [{ source: "declared_target", providerId: "builtin:missing", modelId: "GLM-4", error: "lookup failed for Bearer sk-secret-123" }] });
    session.status = "completed";
    await ext.settleRun?.(context, true);
    const page = createSessionRuntimeEventLog(stateDir, sid).readPage({ limit: 500 });
    const serialized = JSON.stringify(page.events);
    // Failure messages and skipped-candidate errors are not ledger material.
    assert.equal(serialized.includes("secret"), false);
    assert.equal(serialized.includes("Bearer"), false);
    const requests = page.events.filter((row) => row.type === "ModelRequest");
    assert.deepEqual(requests.map((row) => [row.payload.phase, row.payload.selectionId, row.payload.requestId, row.payload.attemptId]),
      [["started", "sel-1", "req-1", "att-1"], ["failed", "sel-1", "req-1", "att-1"], ["started", "sel-1", "req-1", "att-2"], ["completed", "sel-1", "req-1", "att-2"], ["completed", "sel-1", "req-2", "att-3"]]);
    assert.deepEqual(requests[3]?.payload.usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
    assert.equal(requests[3]?.payload.durationMs, 1500.5);
    assert.equal(requests[3]?.payload.queuedMs, 40.25);
    // A completion without provider usage keeps the field absent (unknown), never zero-filled.
    assert.equal(Object.hasOwn(requests[4]!.payload, "usage"), false);
    const retry = page.events.find((row) => row.type === "ModelRetry");
    assert.deepEqual(retry?.payload, { requestId: "req-1", attemptId: "att-1", selectionId: "sel-1", attempt: 1, nextAttempt: 2, maxAttempts: 3, delayMs: 120, statusCode: 503, reason: "server_error", errorCode: "model_server_error" });
    const fallback = page.events.find((row) => row.type === "ModelExecutionFallback");
    assert.deepEqual(fallback?.payload, {
      applied: true, selectionId: "sel-1", requestId: "req-2", attemptId: "att-3", attempt: 1,
      reason: "execution_request_failed", providerErrorCode: "3402", statusCode: 400,
      fromProviderId: "account:temp", fromModelId: "GLM-5.3-Turbo", toProviderId: "builtin:session", toModelId: "GLM-5.3", toSource: "session_selection",
      skippedCount: 1, settled: { streamId: "stream-9", textChars: 7, reasoningChars: 0, toolSnapshots: 1, truncated: false },
    });
    // Diagnostic rows only: the recovery projection consumes none of them.
    const recovered = recoverRuntimeProjection(page);
    assert.equal(recovered.status, "completed");
    assert.equal(recovered.transcript.length, 0);
    assert.equal(Object.hasOwn(recovered.lastModelRequest ?? {}, "usage"), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("keeps the complete ledger while bounding each page to 500 events", () => {
  const { root, stateDir } = temp();
  try {
    const log = createSessionRuntimeEventLog(stateDir, sid);
    for (let i = 0; i < 501; i++) log.append({ type: "TurnPhase", payload: { phase: "idle" } });
    const first = log.readPage({ after: 0, limit: 500 });
    assert.equal(first.events.length, 500); assert.equal(first.hasMore, true); assert.equal(first.head, 501);
    const second = log.readPage({ after: first.next, epoch: first.epoch, limit: 500 });
    assert.equal(second.events.length, 1); assert.equal(second.hasMore, false);
    assert.equal(log.readPage({ after: 0, limit: 500 }).head, 501);
    assert.throws(() => log.readPage({ limit: 501 }), /limit/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
