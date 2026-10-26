/** F08.05: coordinator integration — targeted cancel, parent stop, budget attribution, crash recovery. */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { LEASE_TTL_MS, mergeSubagentNotices, pendingSubagentNotices, TaskBudget, TaskCoordinator, TaskLeases, TaskRegistry, terminateTask } from "../src/index.ts";

const SID = "ab".repeat(16);
const OTHER = "cd".repeat(16);
type Row = Record<string, unknown>;
const term = (row: Row | null | undefined): { reason?: string; detail?: string } | undefined =>
  row?.termination as { reason?: string; detail?: string } | undefined;
const session = (): Row => ({ id: SID, messages: [], archived_messages: [], task_runs: [] });
const record = (registry: TaskRegistry, parent = SID) => {
  const id = TaskRegistry.newId();
  registry.record(id, { parentSession: parent, agent: null, prompt: "p", root: null });
  return id;
};
const parking = async (_taskId: string, stopped: () => boolean): Promise<Row> => {
  for (let i = 0; i < 2_000 && !stopped(); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  return stopped() ? { ok: false, error: "observed cancellation", steps: 1 } : { ok: true, summary: "done", steps: 1 };
};
const quick = async (): Promise<Row> => {
  await new Promise((resolve) => setTimeout(resolve, 20));
  return { ok: true, summary: "quick findings", steps: 0 };
};
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("coordinator parent-child lifecycle", () => {
  it("targeted cancel reaches exactly that child and releases only its lease", async () => {
    const registry = new TaskRegistry();
    const coordinator = new TaskCoordinator(session(), registry);
    const leases = new TaskLeases(), budget = new TaskBudget(64);
    coordinator.attachLifecycle({ leases, budget });
    const a = coordinator.dispatch("call-a", { prompt: "investigate a" }, parking);
    const b = coordinator.dispatch("call-b", { prompt: "investigate b" }, quick);
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    const ta = String(a.task_id), tb = String(b.task_id);
    assert.ok(leases.acquire("writer", ta).ok);
    const cancelled = coordinator.cancelTask(ta, "superseded by B");
    assert.equal(cancelled.ok, true);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(term(cancelled)?.reason, "task_cancel");
    assert.equal(term(cancelled)?.detail, "superseded by B");
    assert.deepEqual(cancelled.released_leases, ["writer"]);
    await wait(40);
    const rowA = registry.get(ta), rowB = registry.get(tb);
    assert.equal(rowA?.status, "cancelled");
    assert.equal(term(rowA)?.reason, "task_cancel");
    assert.equal(rowA?.workerActive, false);
    assert.equal(rowB?.status, "completed");
    assert.equal(term(rowB), undefined);
    assert.equal(leases.get("writer"), null);
    assert.ok(leases.acquire("writer", "other-task").ok);
    await coordinator.close();
    assert.equal(budget.entry(ta)?.settled, true);
    assert.equal(budget.entry(tb)?.settled, true);
  });

  it("cancelTask refuses unknown and foreign tasks; terminal tasks answer already_terminal", () => {
    const registry = new TaskRegistry();
    const coordinator = new TaskCoordinator(session(), registry);
    assert.equal(coordinator.cancelTask("task-missing").ok, false);
    const foreign = record(registry, OTHER);
    assert.equal(coordinator.cancelTask(foreign).ok, false);
    const done = record(registry);
    registry.finish(done, { ok: true, summary: "", error: "", steps: 0 });
    const again = coordinator.cancelTask(done);
    assert.equal(again.ok, true);
    assert.equal(again.already_terminal, true);
    assert.equal(registry.get(done)?.status, "completed");
  });

  it("parent stop cancels running children with parent_stop and keeps the reason durable", async () => {
    const registry = new TaskRegistry();
    const state = session();
    const coordinator = new TaskCoordinator(state, registry);
    const leases = new TaskLeases();
    coordinator.attachLifecycle({ leases, budget: new TaskBudget(16) });
    let stopped = true;
    coordinator.configure({ shouldStop: () => stopped, enabled: () => true });
    const refused = coordinator.dispatch("call-refused", { prompt: "too late" }, parking);
    assert.equal(refused.ok, false);
    assert.equal(refused.error, "delegation stopped");
    stopped = false;
    const dispatched = coordinator.dispatch("call-a", { prompt: "investigate" }, parking);
    assert.equal(dispatched.ok, true);
    const ta = String(dispatched.task_id);
    assert.ok(leases.acquire("writer", ta).ok);
    stopped = true;
    coordinator.sync();
    const row = registry.get(ta);
    assert.equal(row?.status, "cancelled");
    assert.equal(term(row)?.reason, "parent_stop");
    assert.equal(row?.workerActive, false);
    assert.equal(leases.get("writer"), null);
    const durable = (Array.isArray(state.task_runs) ? state.task_runs : []).find((run) => (run as Row)?.id === ta) as Row | undefined;
    assert.equal(term(durable)?.reason, "parent_stop");
    await coordinator.close();
  });

  it("a failed child keeps its diagnosable reason and leaves no exclusive write lock", async () => {
    const registry = new TaskRegistry();
    const coordinator = new TaskCoordinator(session(), registry);
    const leases = new TaskLeases(), budget = new TaskBudget(16);
    coordinator.attachLifecycle({ leases, budget });
    const dispatched = coordinator.dispatch("call-a", { prompt: "will fail" }, async (taskId: string) => {
      assert.ok(leases.acquire("writer", taskId).ok);
      return { ok: false, summary: "", error: "boom", steps: 1 };
    });
    assert.equal(dispatched.ok, true);
    const ta = String(dispatched.task_id);
    await wait(20);
    await coordinator.close();
    const row = registry.get(ta);
    assert.equal(row?.status, "failed");
    assert.equal(row?.error, "boom");
    assert.equal(term(row)?.reason, "child_error");
    assert.equal(leases.get("writer"), null);
    const next = leases.acquire("writer", "other-task");
    assert.ok(next.ok);
    const entry = budget.entry(ta);
    assert.equal(entry?.settled, true);
    assert.equal(entry?.charged, 2);
  });

  it("budget gating refuses new children without creating rows or leaking worker slots", async () => {
    const registry = new TaskRegistry();
    const coordinator = new TaskCoordinator(session(), registry);
    coordinator.attachLifecycle({ leases: new TaskLeases(), budget: new TaskBudget(8) });
    const first = coordinator.dispatch("call-1", { prompt: "spends the turn" }, quick);
    assert.equal(first.ok, true);
    for (const call of ["call-2", "call-3", "call-4"]) {
      const refused = coordinator.dispatch(call, { prompt: "over budget" }, quick);
      assert.equal(refused.ok, false);
      assert.equal(refused.retryable, false);
      assert.ok(String(refused.error).includes("turn budget exhausted"));
    }
    assert.equal(registry.list().length, 1);
    await wait(40);
    const fifth = coordinator.dispatch("call-5", { prompt: "still budget-capped" }, quick);
    assert.equal(fifth.ok, false);
    assert.ok(String(fifth.error).includes("turn budget exhausted"));
    await coordinator.close();
    const small = new TaskCoordinator(session(), new TaskRegistry());
    small.attachLifecycle({ leases: new TaskLeases(), budget: new TaskBudget(7) });
    const tight = small.dispatch("call-1", { prompt: "cannot even start" }, quick);
    assert.equal(tight.ok, false);
    assert.ok(String(tight.error).includes("turn budget exhausted"));
    assert.equal(small.budget()?.remaining(), 7);
    await small.close();
  });

  it("a resumed child drops the previous attempt's outcome: no stale termination, completion reminded", async () => {
    const registry = new TaskRegistry();
    const state = session();
    const coordinator = new TaskCoordinator(state, registry);
    const first = coordinator.dispatch("call-a", { prompt: "will fail" }, async () => ({ ok: false, summary: "", error: "boom", steps: 1 }));
    const tid = String(first.task_id);
    await wait(20);
    coordinator.sync();
    await mergeSubagentNotices({ session: state, save: async () => {} });
    coordinator.sync();
    const failed = (state.task_runs as Row[]).find((run) => run.id === tid) as Row;
    assert.equal(failed.notified, true, "the failure was reminded once");
    assert.equal(term(failed)?.reason, "child_error");
    assert.equal(registry.restart(tid), true);
    coordinator.sync();
    const running = registry.get(tid);
    assert.equal(running?.status, "running");
    assert.equal(running?.notified, undefined, "the earlier delivery stamp does not survive the restart");
    assert.equal(term(running), undefined, "the earlier failure reason does not describe this run");
    terminateTask(registry, null, tid, { cancelled: false, ok: true, summary: "second attempt", error: "", steps: 1 });
    coordinator.sync();
    const done = (state.task_runs as Row[]).find((run) => run.id === tid) as Row;
    assert.equal(done.status, "completed");
    assert.equal(term(done), undefined, "a clean re-run keeps no stale termination reason");
    assert.deepEqual(pendingSubagentNotices(state).map((notice) => notice.status), ["completed"], "the resumed completion is reminded instead of being swallowed");
    await coordinator.close();
  });

  it("worker slots are per coordinator, so one saturated session cannot starve another", async () => {
    const busy = new TaskCoordinator(session(), new TaskRegistry());
    const other = new TaskCoordinator({ id: OTHER, messages: [], archived_messages: [], task_runs: [] }, new TaskRegistry());
    const held = async (): Promise<Row> => new Promise<Row>(() => undefined);
    for (const call of ["call-1", "call-2", "call-3", "call-4"]) assert.equal(busy.dispatch(call, { prompt: "hold a slot" }, held).ok, true);
    assert.equal(busy.dispatch("call-5", { prompt: "over the limit" }, quick).ok, false);
    const independent = other.dispatch("call-1", { prompt: "not this session's limit" }, quick);
    assert.equal(independent.ok, true, "a second session keeps its own four slots");
    await other.close();
  });

  it("cross-task recovery: a leftover running row terminates as crash_recovery; its lease survives only to TTL", () => {
    const registry = new TaskRegistry();
    const orphan = record(registry);
    registry.update(orphan, { workerActive: true });
    const leases = new TaskLeases().clock(() => 1_000);
    assert.ok(leases.acquire("writer", orphan).ok);
    const state = { ...session(), subagent_coordination: { [orphan]: { call_id: "call-orphan", collected: false, turn: 0 } } };
    const coordinator = new TaskCoordinator(state, registry);
    const row = registry.get(orphan);
    assert.equal(row?.status, "failed");
    assert.equal(term(row)?.reason, "crash_recovery");
    assert.equal(row?.workerActive, false);
    coordinator.attachLifecycle({ leases });
    assert.equal(leases.acquire("writer", "task-next").ok, false);
    leases.clock(() => 1_000 + LEASE_TTL_MS + 1);
    const takeover = leases.acquire("writer", "task-next");
    assert.ok(takeover.ok);
    assert.equal(takeover.takeover, true);
  });
});
