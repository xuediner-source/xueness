/** F08.04: completion aggregation over multiple children — settled results, running stays queryable, guidance clears once collected. */
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { TaskCoordinator, TaskRegistry } from "../src/index.ts";

const SID = "ab".repeat(16);

function wired(base: string) {
  const root = join(base, "ws", SID);
  const stateDir = join(base, "state");
  const registry = new TaskRegistry();
  const session: Record<string, unknown> = { id: SID, root, messages: [], task_runs: [] };
  const coordinator = new TaskCoordinator(session, registry);
  coordinator.bindExecutor(async () => ({}), stateDir);
  function task(status: "running" | "completed" | "failed" | "cancelled") {
    const tid = TaskRegistry.newId();
    registry.record(tid, { parentSession: SID, agent: null, prompt: "p", root });
    coordinator.records[tid] = { collected: false, turn: coordinator.turn };
    if (status === "running") registry.update(tid, { workerActive: true });
    else if (status === "completed") registry.finish(tid, { ok: true, summary: "child findings", error: "", steps: 2 });
    else if (status === "failed") registry.finish(tid, { ok: false, summary: "", error: "boom", steps: 1 });
    else registry.cancel(tid);
    return tid;
  }
  return { coordinator, registry, session, task };
}

describe("completion aggregation (F08.04)", () => {
  const base = mkdtempSync(join(tmpdir(), "xueness-aggregate-"));
  after(() => rmSync(base, { recursive: true, force: true }));

  it("reports ok only when every requested child settled completed", async () => {
    const { coordinator, task } = wired(base);
    const good = task("completed"), bad = task("failed"), stopped = task("cancelled");
    const mixed = await coordinator.collect({ task_ids: [good, bad, stopped], wait_seconds: 0 });
    assert.equal(mixed.ok, false);
    assert.match(String(mixed.error), /failed or were cancelled/);
    assert.deepEqual(mixed.pending, []);
    assert.deepEqual((mixed.tasks as Record<string, unknown>[]).map((row) => row.status).sort(), ["cancelled", "completed", "failed"]);
    const good2 = task("completed");
    const clean = await coordinator.collect({ task_ids: [good2], wait_seconds: 0 });
    assert.equal(clean.ok, true);
    assert.equal("error" in clean, false);
    assert.deepEqual((clean.tasks as Record<string, unknown>[]).map((row) => row.status), ["completed"]);
  });

  it("never reads a still-running child as completion (no vacuous truth)", async () => {
    const { coordinator, task } = wired(base);
    const running = task("running"), done = task("completed");
    const outcome = await coordinator.collect({ task_ids: [running, done], wait_seconds: 0 });
    assert.equal(outcome.ok, false);
    assert.deepEqual(outcome.pending, [running]);
    // Only the settled child appears as a result; the running one stays a queryable id, not a summary.
    assert.deepEqual((outcome.tasks as Record<string, unknown>[]).map((row) => row.id), [done]);
    assert.equal("escalations" in outcome, false);
  });

  it("returns each settled child exactly once per collect and marks it collected", async () => {
    const { coordinator, task } = wired(base);
    const done = task("completed");
    const first = await coordinator.collect({ task_ids: [done], wait_seconds: 0 });
    const second = await coordinator.collect({ task_ids: [done], wait_seconds: 0 });
    assert.equal((first.tasks as unknown[]).length, 1);
    assert.deepEqual((first.tasks as Record<string, unknown>[]).map((row) => row.id), [done]);
    assert.deepEqual(second.tasks, []);
    assert.deepEqual(second.delivered, [done]);
    assert.equal(coordinator.records[done]?.collected, true);
    assert.equal(coordinator.completionGuidance(), "");
  });

  it("guidance names exactly the uncollected children, then clears as each is collected", async () => {
    const { coordinator, task } = wired(base);
    const a = task("completed"), b = task("failed");
    const before = coordinator.completionGuidance();
    assert.match(before, new RegExp(`"${a}"`));
    assert.match(before, new RegExp(`"${b}"`));
    await coordinator.collect({ task_ids: [a], wait_seconds: 0 });
    const middle = coordinator.completionGuidance();
    assert.doesNotMatch(middle, new RegExp(`"${a}"`));
    assert.match(middle, new RegExp(`"${b}"`));
    await coordinator.collect({ task_ids: [b], wait_seconds: 0 });
    assert.equal(coordinator.completionGuidance(), "");
  });
});
