import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_BATCH_CONCURRENCY, parallelEligible, planBatches, runBatches, type ScheduledCall } from "../src/batch-scheduler.ts";

const safe = (id: string, extra: Partial<ScheduledCall> = {}): ScheduledCall => ({ id, concurrencySafe: true, readOnly: true, ...extra });
const sizes = (groups: readonly { end: number; start: number }[]): number[] => groups.map((group) => group.end - group.start);
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("batch scheduler planning (C-TOOL-07)", () => {
  it("defaults to a cap of 10 parallel calls per group", () => {
    assert.equal(DEFAULT_BATCH_CONCURRENCY, 10);
    const calls = Array.from({ length: 25 }, (_, index) => safe(`c${index}`));
    const groups = planBatches({ calls });
    assert.deepEqual(sizes(groups), [10, 10, 5]);
    assert.ok(groups.every((group) => group.parallel));
    assert.deepEqual(groups.map((group) => group.start), [0, 10, 20]);
  });

  it("honours a configurable cap and rejects invalid ones", () => {
    assert.deepEqual(sizes(planBatches({ calls: Array.from({ length: 10 }, (_, index) => safe(`c${index}`)), concurrencyCap: 3 })), [3, 3, 3, 1]);
    assert.deepEqual(sizes(planBatches({ calls: Array.from({ length: 3 }, (_, index) => safe(`c${index}`)), concurrencyCap: 1 })), [1, 1, 1]);
    for (const bad of [0, -2, 2.5]) assert.throws(() => planBatches({ calls: [], concurrencyCap: bad }), TypeError);
  });

  it("isolates barriers: mutating, destructive and implicit-only calls run alone", () => {
    const groups = planBatches({ calls: [safe("r1"), { id: "w1", mutating: true }, safe("r2")] });
    assert.deepEqual(groups.map(({ parallel }) => parallel), [true, false, true]);
    assert.deepEqual(sizes(groups), [1, 1, 1]);
    // A destructive call is a barrier even when concurrencySafe was declared.
    assert.equal(parallelEligible({ concurrencySafe: true, destructive: true }), false);
    assert.equal(parallelEligible(safe("r")), true);
    // readOnly without explicit concurrencySafe never qualifies: parallelism is explicit-only.
    assert.equal(parallelEligible({ readOnly: true }), false);
    assert.deepEqual(planBatches({ calls: [{ id: "ro", readOnly: true }] }).map(({ parallel }) => parallel), [false]);
    // An eligibility override (e.g. a registry lookup) drives grouping when provided.
    const override = planBatches({ calls: [{ name: "read" }, { name: "write" }], eligible: (call) => call.name === "read" });
    assert.deepEqual(override.map(({ parallel }) => parallel), [true, false]);
  });

  it("treats a call with dependsOn as a barrier and never fabricates edges", () => {
    const groups = planBatches({ calls: [safe("c0"), safe("c1"), { ...safe("c2"), dependsOn: ["c0"] }, safe("c3")] });
    // c2 must wait for c0, so it is a barrier even though eligible; unknown ids add no ordering beyond that.
    assert.deepEqual(groups.map(({ start, end, parallel }) => [start, end, parallel]), [[0, 2, true], [2, 3, false], [3, 4, true]]);
    // Default calls (no dependsOn field) carry no edges and still group.
    assert.ok(planBatches({ calls: [safe("a"), safe("b")] })[0]?.parallel);
  });

  it("stops parallel expansion while suspended (approval suspension, stop, blocked effects)", () => {
    const calls = [safe("c0"), safe("c1"), safe("c2")];
    const held = planBatches({ calls, suspended: () => true });
    assert.deepEqual(held.map(({ parallel }) => parallel), [false, false, false]);
    const released = planBatches({ calls, suspended: () => false });
    assert.deepEqual(released.map(({ parallel }) => parallel), [true]);
    assert.equal(released[0]?.end, 3);
  });
});

describe("batch scheduler execution (C-TOOL-07)", () => {
  it("runs parallel groups with bounded concurrency and preserves result order", async () => {
    const calls = Array.from({ length: 12 }, (_, index) => safe(`c${index}`));
    const groups = planBatches({ calls, concurrencyCap: 4 });
    const results: string[] = new Array(calls.length);
    let inFlight = 0;
    let maxInFlight = 0;
    await runBatches({
      calls, groups,
      execute: async (call, index) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await delay(index % 3 === 0 ? 30 : 10);
        results[index] = `done:${call.id}`;
        inFlight -= 1;
      },
    });
    assert.ok(maxInFlight <= 4, `max in-flight ${maxInFlight}`);
    assert.deepEqual(results, calls.map((call) => `done:${call.id}`));
  });

  it("runs barriers strictly after the group before them", async () => {
    const events: string[] = [];
    const calls: ScheduledCall[] = [safe("r1"), safe("r2"), { id: "w1", mutating: true }, safe("r3")];
    const groups = planBatches({ calls });
    assert.deepEqual(groups.map(({ parallel }) => parallel), [true, false, true]);
    await runBatches({
      calls, groups,
      execute: async (call) => {
        events.push(`start:${call.id}`);
        await delay(15);
        events.push(`end:${call.id}`);
      },
    });
    assert.ok(events.indexOf("start:w1") > events.indexOf("end:r1") && events.indexOf("start:w1") > events.indexOf("end:r2"), "barrier waits for the parallel group");
    assert.ok(events.indexOf("start:r3") > events.indexOf("end:w1"), "later calls wait for the barrier");
  });

  it("propagates execute rejections to the caller", async () => {
    const calls: ScheduledCall[] = [safe("c0"), safe("c1")];
    await assert.rejects(runBatches({ calls, groups: planBatches({ calls }), execute: async () => { throw new Error("boom"); } }), /boom/);
  });
});
