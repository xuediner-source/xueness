import assert from "node:assert/strict";
import test from "node:test";
import type { AgentContext, AgentEvent, ModelRequest } from "@xueness/agent";
import { batchCallsExtension } from "../src/extension.ts";
import { BATCH_CALLS_COMPACTION_REMINDER, BATCH_CALLS_POLICY } from "../src/policy.ts";

type ContextHarness = { context: AgentContext; setEnabled(value: boolean): void; emitted: () => number };
const extension = batchCallsExtension;

function makeContext(id: string, enabled = true): ContextHarness {
  let active = enabled;
  let emitted = 0;
  const context = {
    session: { id, steps: 4, active_turn_id: `turn-${id}`, messages: [] },
    enabled: (pluginId: string) => pluginId === "batch_calls" && active,
    emit: () => { emitted += 1; },
  } as unknown as AgentContext;
  return { context, setEnabled(value) { active = value; }, emitted: () => emitted };
}

function makeRequest(): ModelRequest {
  return { messages: [], tools: [{ type: "function", function: { name: "read" } }], options: {} as ModelRequest["options"] };
}

function instructions(request: ModelRequest): string[] { return request.hostInstructions ?? []; }
const count = (rows: string[], value: string) => rows.filter((row) => row === value).length;
const completed = (operationId: string, checkpointId: string): AgentEvent => ({ type: "context/compaction_completed", operationId, checkpointId });

test("static bilingual guidance is stable and leaves tools, messages and the scheduling surface alone", async () => {
  const { context, emitted } = makeContext("batch-stable-1");
  const request = makeRequest();
  const prepared = await extension.prepareRequest!(context, request);
  const repeated = await extension.prepareRequest!(context, prepared);
  assert.equal(instructions(prepared)[0], BATCH_CALLS_POLICY);
  assert.match(BATCH_CALLS_POLICY, /批量调用/);
  assert.match(BATCH_CALLS_POLICY, /Batch calls/);
  assert.equal(count(instructions(repeated), BATCH_CALLS_POLICY), 1);
  assert.equal(prepared.tools, request.tools);
  const sessionMessages: unknown = context.session.messages;
  assert.ok(Array.isArray(sessionMessages));
  assert.equal(sessionMessages.length, 0);
  assert.equal(emitted(), 0);
  assert.doesNotMatch(BATCH_CALLS_POLICY, /bash|&&|PowerShell|cmd\.exe/i);
});

test("successful compaction dedupes operation and checkpoint ids, then consumes only at request start", async () => {
  const { context } = makeContext("batch-compaction-1");
  extension.recordEvent!(context, completed("operation-1", "checkpoint-1"));
  extension.recordEvent!(context, completed("operation-1", "checkpoint-1"));
  extension.recordEvent!(context, completed("operation-replay", "checkpoint-1"));
  let prepared = await extension.prepareRequest!(context, makeRequest());
  assert.equal(count(instructions(prepared), BATCH_CALLS_COMPACTION_REMINDER), 1);
  prepared = await extension.prepareRequest!(context, prepared);
  assert.equal(count(instructions(prepared), BATCH_CALLS_COMPACTION_REMINDER), 1);
  const rebuilt = await extension.prepareRequest!(context, makeRequest());
  assert.equal(count(instructions(rebuilt), BATCH_CALLS_COMPACTION_REMINDER), 1);

  await extension.modelRequestStarted!(context, { requestId: "started" });
  extension.recordEvent!(context, completed("operation-replay", "checkpoint-1"));
  context.session.steps = Number(context.session.steps) + 1;
  const next = await extension.prepareRequest!(context, makeRequest());
  assert.equal(count(instructions(next), BATCH_CALLS_COMPACTION_REMINDER), 0);
});

test("persisted successful compactions are observed and do not replay across turns", async () => {
  const { context } = makeContext("batch-persisted-1");
  const operationId = "a".repeat(32);
  const checkpointId = "b".repeat(32);
  context.session.compactions = [
    { removed: 0, advisory: true },
    { kind: "zcode", operationId, checkpointId, trigger: "manual" },
  ];

  const first = await extension.prepareRequest!(context, makeRequest());
  assert.equal(count(instructions(first), BATCH_CALLS_COMPACTION_REMINDER), 1);
  await extension.modelRequestStarted!(context, { requestId: "persisted-start" });
  context.session.steps = Number(context.session.steps) + 1;
  context.session.active_turn_id = "turn-batch-persisted-2";
  await extension.close!(context);

  const nextTurn = await extension.prepareRequest!(context, makeRequest());
  assert.equal(count(instructions(nextTurn), BATCH_CALLS_COMPACTION_REMINDER), 0);

  const nextCheckpoint = "c".repeat(32);
  const nextOperation = "d".repeat(32);
  context.session.compactions = [
    ...(context.session.compactions as unknown[]),
    { kind: "semantic", checkpointId: nextCheckpoint },
  ];
  extension.recordEvent!(context, completed(nextOperation, nextCheckpoint));
  const newlyCompacted = await extension.prepareRequest!(context, makeRequest());
  assert.equal(count(instructions(newlyCompacted), BATCH_CALLS_COMPACTION_REMINDER), 1);
  await extension.modelRequestStarted!(context, { requestId: "persisted-next-start" });
  context.session.steps = Number(context.session.steps) + 1;
  await extension.close!(context);
  const afterConsumption = await extension.prepareRequest!(context, makeRequest());
  assert.equal(count(instructions(afterConsumption), BATCH_CALLS_COMPACTION_REMINDER), 0);
});

test("failed compaction events never produce a reminder", async () => {
  const { context } = makeContext("batch-compaction-fail-1");
  extension.recordEvent!(context, { type: "context/compaction_failed", operationId: "failed-op", checkpointId: "failed-checkpoint" });
  extension.recordEvent!(context, { ...completed("bad-op", "bad-checkpoint"), error: "summary failed" });
  const prepared = await extension.prepareRequest!(context, makeRequest());
  assert.equal(count(instructions(prepared), BATCH_CALLS_COMPACTION_REMINDER), 0);
});

test("pending reminders are isolated by session id", async () => {
  const first = makeContext("batch-isolated-a").context;
  const second = makeContext("batch-isolated-b").context;
  extension.recordEvent!(first, completed("isolated-op", "isolated-checkpoint"));
  const other = await extension.prepareRequest!(second, makeRequest());
  const owner = await extension.prepareRequest!(first, makeRequest());
  assert.equal(count(instructions(other), BATCH_CALLS_COMPACTION_REMINDER), 0);
  assert.equal(count(instructions(owner), BATCH_CALLS_COMPACTION_REMINDER), 1);
});

test("cancellation before request start retains the reminder through close and rebuild", async () => {
  const first = makeContext("batch-cancel-1");
  extension.recordEvent!(first.context, completed("cancel-op", "cancel-checkpoint"));
  const initial = await extension.prepareRequest!(first.context, makeRequest());
  assert.equal(count(instructions(initial), BATCH_CALLS_COMPACTION_REMINDER), 1);
  await extension.close!(first.context); // No modelRequestStarted: the reminder remains pending.

  const resumed = makeContext("batch-cancel-1").context;
  const rebuilt = await extension.prepareRequest!(resumed, makeRequest());
  assert.equal(count(instructions(rebuilt), BATCH_CALLS_COMPACTION_REMINDER), 1);
  await extension.modelRequestStarted!(resumed, { requestId: "resumed" });
  resumed.session.steps = Number(resumed.session.steps) + 1;
  const following = await extension.prepareRequest!(resumed, makeRequest());
  assert.equal(count(instructions(following), BATCH_CALLS_COMPACTION_REMINDER), 0);
});

test("disabled plugin has no prompt or event effect and does not consume a pending reminder", async () => {
  const harness = makeContext("batch-disabled-1", false);
  const request = makeRequest();
  extension.recordEvent!(harness.context, completed("disabled-op", "disabled-checkpoint"));
  assert.equal(await extension.prepareRequest!(harness.context, request), request);
  harness.setEnabled(true);
  const noReminder = await extension.prepareRequest!(harness.context, makeRequest());
  assert.equal(count(instructions(noReminder), BATCH_CALLS_COMPACTION_REMINDER), 0);

  extension.recordEvent!(harness.context, completed("enabled-op", "enabled-checkpoint"));
  const pending = await extension.prepareRequest!(harness.context, makeRequest());
  assert.equal(count(instructions(pending), BATCH_CALLS_COMPACTION_REMINDER), 1);
  harness.setEnabled(false);
  await extension.modelRequestStarted!(harness.context, { requestId: "disabled-start" });
  harness.setEnabled(true);
  const retained = await extension.prepareRequest!(harness.context, makeRequest());
  assert.equal(count(instructions(retained), BATCH_CALLS_COMPACTION_REMINDER), 1);
});
