/** F08.05: diagnosable termination, exclusive write leases, budget attribution, cross-task recovery. */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  CANCELLED, DEFAULT_TASK_RESERVE, FAILED, LEASE_TTL_MS, RUNNING, TaskBudget, TaskLeases, TaskRegistry,
  TERMINATION_REASONS, isTermination, recoverLifecycles, terminateTask, terminationReason,
} from "../src/index.ts";

const SID = "ab".repeat(16);
type Row = Record<string, unknown>;
const startTask = (registry: TaskRegistry, taskId: string) =>
  registry.record(taskId, { parentSession: SID, agent: null, prompt: "p", root: null });
const term = (row: Row | null | undefined) => {
  const termination = row?.termination;
  return isTermination(termination) ? termination : null;
};
const fixedClock = (start = 1_000) => {
  let now = start;
  return { advance: (ms: number) => { now += ms; }, now: () => now };
};

describe("task lifecycle units", () => {
  describe("exclusive write leases", () => {
    it("holds a resource for at most one task and refuses a different holder", () => {
      const leases = new TaskLeases();
      const first = leases.acquire("writer", "task-a");
      assert.ok(first.ok);
      assert.equal(first.lease.holder, "task-a");
      assert.equal(first.lease.generation, 1);
      const refused = leases.acquire("writer", "task-b");
      assert.equal(refused.ok, false);
      assert.equal(refused.lease.holder, "task-a");
    });

    it("re-acquire by the same holder is idempotent and never bumps the generation", () => {
      const leases = new TaskLeases();
      assert.ok(leases.acquire("writer", "task-a").ok);
      const again = leases.acquire("writer", "task-a");
      assert.ok(again.ok);
      assert.equal(again.takeover, false);
      assert.equal(again.lease.generation, 1);
    });

    it("a released resource moves to the next holder with generation + 1", () => {
      const leases = new TaskLeases();
      assert.ok(leases.acquire("writer", "task-a").ok);
      assert.ok(leases.release("writer", "task-a"));
      const next = leases.acquire("writer", "task-b");
      assert.ok(next.ok);
      assert.equal(next.takeover, true);
      assert.equal(next.lease.generation, 2);
    });

    it("an expired lease is taken over with generation + 1; a null TTL never expires", () => {
      const clock = fixedClock();
      const leases = new TaskLeases().clock(clock.now);
      assert.ok(leases.acquire("writer", "task-a", { ttlMs: 100 }).ok);
      assert.ok(leases.acquire("pinned", "task-a", { ttlMs: null }).ok);
      clock.advance(150);
      const expired = leases.acquire("writer", "task-b");
      assert.ok(expired.ok);
      assert.equal(expired.takeover, true);
      assert.equal(expired.lease.generation, 2);
      clock.advance(10_000_000);
      assert.equal(leases.acquire("pinned", "task-b").ok, false);
    });

    it("renew extends the expiry only for the holding task", () => {
      const clock = fixedClock();
      const leases = new TaskLeases().clock(clock.now);
      assert.ok(leases.acquire("writer", "task-a", { ttlMs: 100 }).ok);
      clock.advance(50);
      assert.equal(leases.renew("writer", "task-b", 200), false);
      assert.equal(leases.renew("writer", "task-a", 200), true);
      clock.advance(150);
      assert.equal(leases.acquire("writer", "task-b").ok, false);
      clock.advance(100);
      assert.equal(leases.acquire("writer", "task-b").ok, true);
    });

    it("release reports the lease and fires onRelease; a wrong holder releases nothing", () => {
      const seen: string[] = [];
      const leases = new TaskLeases().onRelease((lease) => seen.push(lease.resource));
      assert.ok(leases.acquire("writer", "task-a").ok);
      assert.equal(leases.release("writer", "task-b"), null);
      const released = leases.release("writer", "task-a");
      assert.equal(released?.holder, "task-a");
      assert.deepEqual(seen, ["writer"]);
      assert.equal(leases.get("writer"), null);
    });

    it("releaseTask frees every lease of one task and leaves other holders alone", () => {
      const seen: string[] = [];
      const leases = new TaskLeases().onRelease((lease) => seen.push(lease.resource));
      assert.ok(leases.acquire("r1", "task-a").ok);
      assert.ok(leases.acquire("r2", "task-a").ok);
      assert.ok(leases.acquire("r3", "task-b").ok);
      const released = leases.releaseTask("task-a");
      assert.deepEqual(released.map((lease) => lease.resource).sort(), ["r1", "r2"]);
      assert.deepEqual(seen.sort(), ["r1", "r2"]);
      assert.equal(leases.get("r3")?.holder, "task-b");
    });

    it("revokeExpired returns only expired leases; accessors reflect live state", () => {
      const clock = fixedClock();
      const leases = new TaskLeases().clock(clock.now);
      assert.ok(leases.acquire("r1", "task-a", { ttlMs: 100 }).ok);
      assert.ok(leases.acquire("r2", "task-a", { ttlMs: null }).ok);
      assert.ok(leases.acquire("r3", "task-b", { ttlMs: LEASE_TTL_MS }).ok);
      clock.advance(150);
      const revoked = leases.revokeExpired();
      assert.deepEqual(revoked.map((lease) => lease.resource), ["r1"]);
      assert.equal(leases.get("r1"), null);
      assert.deepEqual(leases.heldBy("task-a").map((lease) => lease.resource), ["r2"]);
      assert.equal(leases.list().length, 2);
    });
  });

  describe("turn budget", () => {
    it("reserves up front and refuses without recording when over budget", () => {
      const budget = new TaskBudget(12);
      assert.equal(budget.reserve("task-a", 8), true);
      assert.equal(budget.remaining(), 4);
      assert.equal(budget.reserve("task-b", 8), false);
      assert.equal(budget.entries().length, 1);
      assert.equal(budget.overBudget(4), false);
      assert.equal(budget.overBudget(5), true);
    });

    it("settle replaces the reservation with real consumption", () => {
      const budget = new TaskBudget(20);
      assert.ok(budget.reserve("task-a", 8));
      const settled = budget.settle("task-a", 3);
      assert.equal(settled?.charged, 3);
      assert.equal(settled?.settled, true);
      assert.equal(budget.remaining(), 17);
    });

    it("settle without units charges the reservation; unknown tasks settle to null", () => {
      const budget = new TaskBudget(20);
      assert.ok(budget.reserve("task-a", 8));
      assert.equal(budget.settle("task-a")?.charged, 8);
      assert.equal(budget.settle("missing"), null);
    });

    it("attribution reports reserved vs charged per task", () => {
      const budget = new TaskBudget(20);
      assert.ok(budget.reserve("task-a", 8));
      assert.ok(budget.reserve("task-b", 5));
      budget.settle("task-b", 2);
      assert.deepEqual(budget.attribution(), { total: 20, charged: 10, tasks: { "task-a": 8, "task-b": 2 } });
    });

    it("returned entries are copies; DEFAULT_TASK_RESERVE is the default reservation", () => {
      const budget = new TaskBudget(32);
      assert.ok(budget.reserve("task-a"));
      assert.equal(DEFAULT_TASK_RESERVE, 8);
      assert.equal(budget.remaining(), 24);
      const entry = budget.entry("task-a");
      assert.ok(entry);
      entry.settled = true;
      assert.equal(budget.entry("task-a")?.settled, false);
    });
  });

  describe("terminateTask funnel", () => {
    it("targeted cancel: cancelled status, diagnosable reason, no lease residue", () => {
      const registry = new TaskRegistry(), leases = new TaskLeases();
      const tid = TaskRegistry.newId();
      startTask(registry, tid);
      registry.update(tid, { workerActive: true });
      assert.ok(leases.acquire("writer", tid).ok);
      const row = terminateTask(registry, leases, tid, { cancelled: true, reason: TERMINATION_REASONS.task_cancel, detail: "superseded" });
      assert.equal(row?.status, CANCELLED);
      assert.equal(term(row)?.reason, TERMINATION_REASONS.task_cancel);
      assert.equal(term(row)?.detail, "superseded");
      assert.equal(typeof term(row)?.at, "number");
      assert.equal(row?.workerActive, false);
      assert.deepEqual(row?.releasedLeases, ["writer"]);
      assert.equal(leases.get("writer"), null);
      const next = leases.acquire("writer", "other-task");
      assert.ok(next.ok);
    });

    it("child failure: failed status with default child_error reason and released lease", () => {
      const registry = new TaskRegistry(), leases = new TaskLeases();
      const tid = TaskRegistry.newId();
      startTask(registry, tid);
      assert.ok(leases.acquire("writer", tid).ok);
      const row = terminateTask(registry, leases, tid, { cancelled: false, ok: false, error: "boom", steps: 2 });
      assert.equal(row?.status, FAILED);
      assert.equal(row?.error, "boom");
      assert.equal(term(row)?.reason, TERMINATION_REASONS.child_error);
      assert.deepEqual(row?.releasedLeases, ["writer"]);
      assert.ok(leases.acquire("writer", "other-task").ok);
    });

    it("clean success leaves no termination record", () => {
      const registry = new TaskRegistry(), leases = new TaskLeases();
      const tid = TaskRegistry.newId();
      startTask(registry, tid);
      const row = terminateTask(registry, leases, tid, { cancelled: false, ok: true, summary: "done", steps: 3 });
      assert.equal(row?.status, "completed");
      assert.equal(row?.termination, undefined);
      assert.deepEqual(row?.releasedLeases, []);
    });

    it("an already-terminal task is returned unchanged and unknown tasks return null", () => {
      const registry = new TaskRegistry();
      const tid = TaskRegistry.newId();
      startTask(registry, tid);
      registry.cancel(tid);
      const row = terminateTask(registry, null, tid, { cancelled: true, reason: TERMINATION_REASONS.task_cancel, detail: "late" });
      assert.equal(row?.status, CANCELLED);
      assert.equal(row?.termination, undefined);
      assert.equal(terminateTask(registry, null, "task-missing", { cancelled: true }), null);
    });

    it("keeps an explicit reason and slices detail to 500 characters", () => {
      const registry = new TaskRegistry(), leases = new TaskLeases();
      const tid = TaskRegistry.newId();
      startTask(registry, tid);
      const row = terminateTask(registry, leases, tid, { cancelled: false, ok: false, reason: TERMINATION_REASONS.crash_recovery, detail: "x".repeat(600) });
      assert.equal(term(row)?.reason, TERMINATION_REASONS.crash_recovery);
      assert.equal(term(row)?.detail.length, 500);
    });
  });

  describe("termination guards", () => {
    it("isTermination accepts only known reasons with a timestamp", () => {
      assert.equal(isTermination({ reason: "parent_stop", detail: "", at: 1 }), true);
      assert.equal(isTermination({ reason: "mystery", detail: "", at: 1 }), false);
      assert.equal(isTermination({ reason: "parent_stop" }), false);
      assert.equal(isTermination(null), false);
      assert.equal(isTermination("cancelled"), false);
    });

    it("terminationReason reads a registry row's termination", () => {
      assert.equal(terminationReason({ termination: { reason: "shutdown_timeout", detail: "", at: 2 } }), "shutdown_timeout");
      assert.equal(terminationReason({}), null);
      assert.equal(terminationReason(null), null);
    });
  });

  describe("cross-task recovery", () => {
    it("terminates running orphans with crash_recovery and revokes expired leases of dead holders", () => {
      const registry = new TaskRegistry(), leases = new TaskLeases().clock(() => 1_000);
      const orphan = TaskRegistry.newId(), done = TaskRegistry.newId();
      startTask(registry, orphan);
      registry.update(orphan, { workerActive: true });
      startTask(registry, done);
      registry.finish(done, { ok: true, summary: "done", error: "", steps: 1 });
      assert.ok(leases.acquire("writer", orphan).ok);
      assert.ok(leases.acquire("stale", done, { ttlMs: 100 }).ok);
      const report = recoverLifecycles(registry, leases, { now: () => 5_000 });
      assert.deepEqual(report.recovered, [orphan]);
      assert.deepEqual(report.reasons, { [orphan]: TERMINATION_REASONS.crash_recovery });
      assert.deepEqual(report.revokedLeases, [`${done}:stale`]);
      assert.deepEqual(report.releasedLeases, ["writer"]);
      const row = registry.get(orphan);
      assert.equal(row?.status, FAILED);
      assert.equal(row?.workerActive, false);
      assert.equal(term(row)?.reason, TERMINATION_REASONS.crash_recovery);
      assert.equal(leases.get("writer"), null);
      assert.equal(leases.get("stale"), null);
      assert.ok(leases.acquire("writer", "next-task").ok);
      assert.ok(leases.acquire("stale", "next-task").ok);
    });

    it("recovers registry state even with no leases attached", () => {
      const registry = new TaskRegistry();
      const orphan = TaskRegistry.newId();
      startTask(registry, orphan);
      const report = recoverLifecycles(registry, null);
      assert.deepEqual(report.recovered, [orphan]);
      assert.equal(term(registry.get(orphan))?.reason, TERMINATION_REASONS.crash_recovery);
    });
  });

  it("keeps the running guard import honest", () => {
    const registry = new TaskRegistry();
    const tid = TaskRegistry.newId();
    startTask(registry, tid);
    assert.equal(registry.get(tid)?.status, RUNNING);
  });
});
