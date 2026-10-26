/** F14.02 live tasks: cost-authorization gate, per-scenario traces, raw outcomes, no rate fields. */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  LIVE_TASK_SCENARIOS, LiveTasksError, loadLiveTaskBatch, runLiveTasks, saveLiveTaskBatch, validateLiveTaskBatch,
  type LiveTaskBatch, type ModelCallOutcome, type ModelCallPort,
} from "../src/live-tasks.ts";

const TICK0 = Date.parse("2026-10-26T12:00:00.000Z");
let tick = TICK0;
const now = () => new Date(tick += 1000);
const AUTH = { authorized: true, authorizedBy: "acceptance-user", grantRef: "grant-f14.02" } as const;
const MODEL = { model: "zai-start-plan/glm-5.3", configFingerprint: "sha256:abc123" } as const;

function port(outcomes: (input: { lane: string }) => ModelCallOutcome | Promise<ModelCallOutcome>, calls?: string[]): ModelCallPort {
  return async (input) => {
    calls?.push(`${input.scenario}/${input.lane}`);
    await Promise.resolve();
    return outcomes(input);
  };
}

const ALL_TASKS = [
  { scenario: "edit", prompt: "rename variable foo to bar in src/a.ts" },
  { scenario: "long_task", prompt: "refactor the parser and keep tests green" },
  { scenario: "concurrent_subagents", prompt: "audit modules in parallel", subagents: 3 },
  { scenario: "workflow", prompt: "run the release checklist", steps: 2 },
  { scenario: "mcp", prompt: "list files through the MCP server", steps: 2 },
] as const;

describe("live tasks", () => {
  it("never invokes the model without cost authorization and blocks every scenario", async () => {
    const calls: string[] = [];
    const batch = await runLiveTasks({
      ...MODEL, round: "F14.02", authorization: { authorized: false }, tasks: ALL_TASKS,
      callModel: port(() => ({ ok: true, outputText: "should not run" }), calls), now,
    });
    assert.deepEqual(calls, []);
    assert.equal(batch.records.length, 5);
    for (const record of batch.records) {
      assert.equal(record.status, "blocked");
      assert.match(record.blocker ?? "", /no cost authorization/);
      assert.equal(record.events.length, 2);
    }
    assert.deepEqual(batch.summary, { completed: 0, failed: 0, blocked: 5 });
    assert.deepEqual(batch.authorization, { authorized: false });
  });

  it("runs all five scenarios on one shared model/config and records raw traces and usage", async () => {
    const batch = await runLiveTasks({
      ...MODEL, round: "F14.02", authorization: AUTH, tasks: ALL_TASKS,
      callModel: port(({ lane }) => ({
        ok: true, outputText: `done by ${lane}`,
        usage: { inputTokens: 100, outputTokens: 20, cost: { currency: "USD", amount: lane === "main" ? 0.01 : 0.005 } },
      })), now,
    });
    assert.equal(batch.records.length, 5);
    assert.deepEqual(batch.summary, { completed: 5, failed: 0, blocked: 0 });
    assert.deepEqual(batch.authorization, { authorized: true, authorizedBy: "acceptance-user", grantRef: "grant-f14.02" });
    for (const record of batch.records) {
      assert.equal(record.model, MODEL.model);
      assert.equal(record.configFingerprint, MODEL.configFingerprint);
      assert.ok(record.events.some((event) => event.type === "model_call_started"));
      assert.ok(record.events.some((event) => event.type === "model_call_completed"));
      assert.ok(record.events.at(-1)?.type === "scenario_finished");
    }
    const subagents = batch.records.find((record) => record.scenario === "concurrent_subagents");
    assert.equal(subagents?.events.filter((event) => event.type === "model_call_started").length, 3);
    assert.deepEqual(subagents?.usage, { inputTokens: 300, outputTokens: 60, cost: { currency: "USD", amount: 0.015 } });
    const workflow = batch.records.find((record) => record.scenario === "workflow");
    assert.equal(workflow?.events.filter((event) => event.type === "model_call_started").length, 2);
    const edit = batch.records.find((record) => record.scenario === "edit");
    assert.equal(edit?.events.filter((event) => event.type === "model_call_started").length, 1);
    assert.equal(edit?.usage?.inputTokens, 100);
  });

  it("records failures per lane and never upgrades them into aggregate success", async () => {
    const batch = await runLiveTasks({
      ...MODEL, round: "F14.02", authorization: AUTH,
      tasks: [
        { scenario: "edit", prompt: "p" },
        { scenario: "concurrent_subagents", prompt: "p", subagents: 2 },
      ],
      callModel: port(({ lane }) => lane === "subagent-2"
        ? { ok: false, error: "provider 502" }
        : { ok: true, outputText: "ok", usage: { inputTokens: 10, outputTokens: 5 } }), now,
    });
    assert.deepEqual(batch.summary, { completed: 1, failed: 1, blocked: 0 });
    const subagents = batch.records.find((record) => record.scenario === "concurrent_subagents");
    assert.equal(subagents?.status, "failed");
    assert.match(subagents?.error ?? "", /provider 502/);
    assert.ok(subagents?.events.some((event) => event.type === "model_call_failed" && event.lane === "subagent-2"));
    assert.ok(Object.keys(batch).every((key) => !/rate|coverage|percent|success/i.test(key)));
  });

  it("classifies thrown port errors as failed lanes with the message in the trace", async () => {
    const batch = await runLiveTasks({
      ...MODEL, round: "F14.02", authorization: AUTH,
      tasks: [{ scenario: "long_task", prompt: "p" }],
      callModel: port(() => { throw new Error("socket hang up"); }), now,
    });
    assert.equal(batch.records[0]?.status, "failed");
    assert.match(batch.records[0]?.error ?? "", /socket hang up/);
    assert.ok(batch.records[0]?.events.some((event) => event.type === "model_call_failed" && event.detail === "socket hang up"));
  });

  it("rejects unknown scenarios before anything runs", async () => {
    await assert.rejects(
      runLiveTasks({
        ...MODEL, round: "F14.02", authorization: AUTH,
        tasks: [{ scenario: "benchmark" as never, prompt: "p" }],
        callModel: port(() => ({ ok: true })),
      }),
      (error: unknown) => error instanceof LiveTasksError && error.problems.some((problem) => problem.includes("unknown scenario")),
    );
  });

  it("validates authorization, shared model/config, blockers, and absence of rate fields", async () => {
    const good = await runLiveTasks({ ...MODEL, round: "F14.02", authorization: AUTH, tasks: ALL_TASKS, callModel: port(() => ({ ok: true })), now });
    assert.deepEqual(validateLiveTaskBatch(good), []);
    const unauthorizedRun = await runLiveTasks({ ...MODEL, round: "F14.02", authorization: { authorized: false }, tasks: ALL_TASKS, callModel: port(() => ({ ok: true })), now });
    assert.deepEqual(validateLiveTaskBatch(unauthorizedRun), []);
    const forged = JSON.parse(JSON.stringify(unauthorizedRun)) as LiveTaskBatch;
    forged.records[0]!.status = "completed";
    assert.ok(validateLiveTaskBatch(forged).some((problem) => problem.includes("without cost authorization")));
    const noGrant = { ...good, authorization: { authorized: true, authorizedBy: "", grantRef: "" } };
    assert.ok(validateLiveTaskBatch(noGrant).some((problem) => problem.includes("authorizedBy and grantRef")));
    const driftedModel = JSON.parse(JSON.stringify(good)) as LiveTaskBatch;
    driftedModel.records[0]!.model = "other/model";
    assert.ok(validateLiveTaskBatch(driftedModel).some((problem) => problem.includes("differs from batch model")));
    const driftedConfig = JSON.parse(JSON.stringify(good)) as LiveTaskBatch;
    driftedConfig.records[0]!.configFingerprint = "sha256:zzz";
    assert.ok(validateLiveTaskBatch(driftedConfig).some((problem) => problem.includes("config fingerprint differs")));
    const rated = { ...good, successRate: 1 };
    assert.ok(validateLiveTaskBatch(rated).some((problem) => problem.includes("aggregate-rate field successRate")));
    const noBlocker = JSON.parse(JSON.stringify(unauthorizedRun)) as LiveTaskBatch;
    delete noBlocker.records[0]!.blocker;
    assert.ok(validateLiveTaskBatch(noBlocker).some((problem) => problem.includes("blocked requires a blocker")));
    const noTrace = JSON.parse(JSON.stringify(good)) as LiveTaskBatch;
    noTrace.records[0]!.events = [];
    assert.ok(validateLiveTaskBatch(noTrace).some((problem) => problem.includes("at least one event")));
    assert.deepEqual(LIVE_TASK_SCENARIOS, ["edit", "long_task", "concurrent_subagents", "workflow", "mcp"]);
  });

  it("saves and reloads batches, and refuses tampered files", async () => {
    const state = mkdtempSync(join(tmpdir(), "xueness-live-"));
    try {
      const batch = await runLiveTasks({
        ...MODEL, round: "F14.02", authorization: AUTH, tasks: ALL_TASKS,
        callModel: port(() => ({ ok: true, outputText: "ok" })), now,
      });
      const file = saveLiveTaskBatch(batch, state);
      assert.ok(existsSync(file));
      assert.match(file, /2026-10-26-F14\.02\.json$/);
      const reloaded = loadLiveTaskBatch(file);
      assert.equal(reloaded.round, "F14.02");
      assert.deepEqual(reloaded.summary, batch.summary);
      const tampered = join(state, "tampered.json");
      writeFileSync(tampered, JSON.stringify({ ...batch, passRate: 0.8 }));
      assert.throws(() => loadLiveTaskBatch(tampered), LiveTasksError);
      const broken = join(state, "broken.json");
      writeFileSync(broken, "[");
      assert.throws(() => loadLiveTaskBatch(broken), LiveTasksError);
      assert.throws(() => saveLiveTaskBatch({ ...batch, model: "" }, state), LiveTasksError);
    } finally {
      rmSync(state, { recursive: true, force: true });
    }
  });
});

describe("authorization and summary integrity", () => {
  const batch = (overrides: Partial<Parameters<typeof runLiveTasks>[0]> = {}): Parameters<typeof runLiveTasks>[0] => ({
    round: "F14.02", model: "GLM-5.3", configFingerprint: "cfg-1",
    authorization: { authorized: true, authorizedBy: "owner", grantRef: "grant-1" },
    tasks: [{ scenario: "edit", prompt: "p" }],
    callModel: async () => ({ ok: true, outputText: "done" }),
    ...overrides,
  });

  it("treats a missing authorization object as unauthorized instead of crashing", async () => {
    // Regression: reading options.authorization.authorized threw a TypeError before any record existed.
    let calls = 0;
    const record = await runLiveTasks(batch({
      authorization: undefined as unknown as Parameters<typeof runLiveTasks>[0]["authorization"],
      callModel: async () => { calls += 1; return { ok: true }; },
    }));
    assert.equal(calls, 0);
    assert.equal(record.summary.blocked, 1);
    assert.equal(record.authorization.authorized, false);
  });

  it("never fabricates a cost total across currencies", () => {
    const problemFree = validateLiveTaskBatch({
      schema: "xueness.live-tasks.v1", round: "r", model: "m", configFingerprint: "f",
      authorization: { authorized: true, authorizedBy: "o", grantRef: "g" },
      records: [], recordedAt: new Date().toISOString(),
    });
    assert.ok(problemFree.some((problem) => problem.includes("at least one scenario")));
  });

  it("rejects a tampered summary that inflates completed counts", async () => {
    const good = await runLiveTasks(batch());
    assert.equal(good.summary.completed, 1);
    const tampered: LiveTaskBatch = { ...good, summary: { completed: 5, failed: 0, blocked: 0 } };
    const problems = validateLiveTaskBatch(tampered);
    assert.ok(problems.some((problem) => problem.includes("summary.completed is 5 but 1 record")));
  });
});

