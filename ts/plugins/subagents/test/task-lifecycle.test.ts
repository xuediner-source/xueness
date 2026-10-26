/** F08.02: the unified background Dispatch/Collect/Resume lifecycle table and its coordinator wiring. */
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { CANCELLED, COMPLETED, FAILED, RUNNING, nextOperations, operationHint, reconnectPlan, splitForCollect, TaskCoordinator, TaskRegistry } from "../src/index.ts";

const SID = "ab".repeat(16);
const base = mkdtempSync(join(tmpdir(), "xueness-lifecycle-"));
after(() => { rmSync(base, { recursive: true, force: true }); });

const row = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ id: "task-x", status: RUNNING, ...extra });

function deferred() {
  let resolve!: (value: Record<string, unknown>) => void;
  const promise = new Promise<Record<string, unknown>>((done) => { resolve = done; });
  return { promise, resolve };
}

async function settleTo(registry: TaskRegistry, tid: string, status: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (registry.get(tid)?.status === status) return;
    await new Promise((done) => setTimeout(done, 10));
  }
  assert.equal(registry.get(tid)?.status, status);
}

describe("lifecycle table (nextOperations)", () => {
  it("an unknown id only allows dispatch; a known-but-missing one allows nothing", () => {
    assert.deepEqual(nextOperations(null, { active: false, known: false }).operations, ["dispatch"]);
    assert.deepEqual(nextOperations(null, { active: true, known: true }).operations, []);
    assert.equal(nextOperations(null, { active: false, known: false }).resumeRequiresMessage, null);
  });

  it("running tasks collect, wait and message but never resume", () => {
    const active = nextOperations(row(), { active: true, known: true });
    assert.deepEqual(active.operations, ["collect", "wait", "send_message"]);
    const idle = nextOperations(row({ workerActive: false }), { active: false, known: true });
    assert.deepEqual(idle.operations, ["collect", "wait"]);
    assert.equal(active.operations.includes("resume"), false);
    assert.equal(active.resumeRequiresMessage, null);
  });

  it("completed tasks resume only with a followup message; failed tasks resume without one", () => {
    const done = nextOperations(row({ status: COMPLETED }), { active: false, known: true });
    assert.deepEqual(done.operations, ["collect", "resume"]);
    assert.equal(done.resumeRequiresMessage, true);
    const failed = nextOperations(row({ status: FAILED }), { active: false, known: true });
    assert.deepEqual(failed.operations, ["collect", "resume"]);
    assert.equal(failed.resumeRequiresMessage, false);
  });

  it("cancelled tasks are closed forever and non-lifecycle statuses allow nothing", () => {
    assert.deepEqual(nextOperations(row({ status: CANCELLED }), { active: false, known: true }).operations, ["collect"]);
    assert.deepEqual(nextOperations(row({ status: "paused" }), { active: false, known: true }).operations, []);
  });
});

describe("deliver-once collection (splitForCollect)", () => {
  it("splits fresh, already-delivered and still-running rows", () => {
    const records = { done: { collected: true }, open: { collected: false } };
    const split = splitForCollect(records, [
      row({ id: "fresh", status: COMPLETED }),
      row({ id: "done", status: FAILED }),
      row({ id: "open", status: RUNNING }),
      row({ id: "weird", status: "paused" }),
      {},
    ]);
    assert.deepEqual(split.fresh.map((item) => item.id), ["fresh"]);
    assert.deepEqual(split.delivered.map((item) => item.id), ["done"]);
    assert.deepEqual(split.pending, ["open"]);
  });
});

describe("reconnection (reconnectPlan)", () => {
  it("keeps terminal rows, interrupts orphaned running rows, drops ghosts", () => {
    const session = {
      task_runs: [
        row({ id: "kept", status: COMPLETED }),
        row({ id: "cut", status: RUNNING, workerActive: true }),
        row({ id: "kept2", status: "queued" }),
      ],
      subagent_coordination: { kept: {}, cut: {}, kept2: {}, ghost: {} },
    };
    assert.deepEqual(reconnectPlan(session as never), [
      { id: "kept", action: "keep", status: COMPLETED },
      { id: "cut", action: "interrupt", status: RUNNING },
      { id: "kept2", action: "keep", status: "queued" },
      { id: "ghost", action: "drop", status: "missing" },
    ]);
  });
});

describe("operation hints", () => {
  it("running and terminal tasks each name their next move", () => {
    assert.match(operationHint(row(), { active: true, known: true }), /task_collect/);
    assert.match(operationHint(row({ status: COMPLETED }), { active: false, known: true }), /terminal result ready/);
    assert.equal(typeof operationHint(null, { active: false, known: false }), "string");
  });
});

describe("coordinator dispatch/collect/resume wiring", () => {
  it("dispatch returns a receipt with a next hint; collect is deliver-once across repeats", async () => {
    const registry = new TaskRegistry();
    const session = { id: SID, messages: [], archived_messages: [], task_runs: [] };
    const coordinator = new TaskCoordinator(session, registry);
    const slow = deferred();
    const receipt = coordinator.dispatch("call-1", { prompt: "audit the registry" }, async () => await slow.promise);
    assert.equal(receipt.ok, true);
    assert.equal(receipt.background, true);
    assert.equal(receipt.status, RUNNING);
    assert.equal(typeof receipt.task_id, "string");
    assert.equal(typeof receipt.next, "string");
    assert.ok(String(receipt.next).length > 0);
    const tid = String(receipt.task_id);

    const early = await coordinator.collect({ task_ids: [tid] });
    assert.deepEqual(early.tasks, []);
    assert.deepEqual(early.pending, [tid]);

    slow.resolve({ ok: true, summary: "found three issues", error: "", steps: 3 });
    await settleTo(registry, tid, COMPLETED);
    const first = await coordinator.collect({ task_ids: [tid] });
    assert.equal(first.ok, true);
    assert.deepEqual((first.tasks as Record<string, unknown>[]).map((task: Record<string, unknown>) => [task.id, task.status, task.summary]), [[tid, COMPLETED, "found three issues"]]);
    assert.deepEqual(first.pending, []);

    const repeat = await coordinator.collect({ task_ids: [tid] });
    assert.deepEqual(repeat.tasks, []);
    assert.deepEqual(repeat.delivered, [tid]);
    assert.deepEqual(repeat.pending, []);
  });

  it("a completed task resumes only with a followup message; a failed one may retry bare", async () => {
    const registry = new TaskRegistry();
    const session = { id: SID, messages: [], archived_messages: [], task_runs: [] };
    const coordinator = new TaskCoordinator(session, registry);
    coordinator.bindExecutor(async () => ({ ok: true, summary: "", error: "", steps: 0 }), join(base, "journal"));
    const done = TaskRegistry.newId(), failed = TaskRegistry.newId();
    registry.record(done, { parentSession: SID, agent: null, prompt: "p", root: null });
    registry.finish(done, { ok: true, summary: "", error: "", steps: 1 });
    registry.record(failed, { parentSession: SID, agent: null, prompt: "p", root: null });
    registry.finish(failed, { ok: false, summary: "", error: "boom", steps: 1 });

    const bare = coordinator.resume("call-2", { task_id: done });
    assert.equal(bare.ok, false);
    assert.match(String(bare.error), /followup message/);
    const messaged = coordinator.resume("call-3", { task_id: done, message: "now verify the fix" });
    assert.equal(messaged.ok, false);
    assert.match(String(messaged.error), /child history is unavailable/);

    const retried = coordinator.resume("call-4", { task_id: failed });
    assert.equal(retried.ok, false);
    assert.match(String(retried.error), /child history is unavailable/);
  });

  it("a parent restart reconnects a saved running row as failed and collectable exactly once", async () => {
    const registry = new TaskRegistry();
    const tid = TaskRegistry.newId();
    const session = {
      id: SID, messages: [], archived_messages: [],
      task_runs: [{ id: tid, parent: SID, status: RUNNING, workerActive: true }],
      subagent_coordination: { [tid]: { call_id: "call-0", collected: false, turn: 0 } },
    };
    const coordinator = new TaskCoordinator(session, registry);
    assert.equal(registry.get(tid)?.status, FAILED);
    assert.match(String(registry.get(tid)?.error), /interrupted before result collection/);
    assert.equal(registry.get(tid)?.workerActive, false);

    const first = await coordinator.collect({ task_ids: [tid] });
    assert.deepEqual((first.tasks as Record<string, unknown>[]).map((task: Record<string, unknown>) => task.status), [FAILED]);
    const repeat = await coordinator.collect({ task_ids: [tid] });
    assert.deepEqual(repeat.tasks, []);
    assert.deepEqual(repeat.delivered, [tid]);

    const ghost = TaskRegistry.newId();
    const sessionWithGhost = {
      id: SID, messages: [], archived_messages: [], task_runs: [],
      subagent_coordination: { [ghost]: { call_id: "call-g", collected: false, turn: 0 } },
    };
    new TaskCoordinator(sessionWithGhost, new TaskRegistry());
    assert.equal(Object.hasOwn(sessionWithGhost.subagent_coordination, ghost), false);
  });
});
