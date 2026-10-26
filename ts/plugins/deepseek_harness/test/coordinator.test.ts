/** H07.01 + H07.02: swarm coordinator slots and non-overlapping file sharding. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SlotAcquisitionError,
  SwarmCoordinator,
  type WorktreeSlot,
} from "../src/swarm/coordinator.ts";
import {
  ShardingError,
  planShards,
  shardPaths,
  shardWeightSpread,
  shardsAreDisjoint,
  shardsCover,
} from "../src/swarm/sharding.ts";

describe("H07.01 SwarmCoordinator", () => {
  it("registers N parallel worktree agent slots", () => {
    const coord = new SwarmCoordinator(["/wt/a", "/wt/b", "/wt/c"]);
    assert.equal(coord.parallelism, 3);
    const ids = coord.listSlots().map((s: WorktreeSlot) => s.id);
    assert.deepEqual(ids, ["wt-1", "wt-2", "wt-3"]);
    for (const slot of coord.listSlots()) {
      assert.equal(slot.status, "idle");
      assert.equal(slot.agentId, null);
    }
  });

  it("supports incremental registration after construction", () => {
    const coord = new SwarmCoordinator();
    assert.equal(coord.parallelism, 0);
    coord.registerSlot("/wt/a");
    coord.registerSlot("/wt/b");
    assert.equal(coord.parallelism, 2);
    assert.equal(coord.mutationCount, 2);
  });

  it("hands each slot to exactly one agent while busy (exclusive ownership)", () => {
    const coord = new SwarmCoordinator(["/wt/a", "/wt/b"]);
    const l1 = coord.acquireStrict("agent-1");
    const l2 = coord.acquireStrict("agent-2");
    assert.equal(l1.slot.agentId, "agent-1");
    assert.equal(l2.slot.agentId, "agent-2");
    assert.notEqual(l1.slot.id, l2.slot.id);
    const busy = coord.listSlots().filter((s) => s.status === "busy");
    assert.equal(busy.length, 2);
    l1.release();
    l2.release();
  });

  it("returns null from acquire once all N slots are busy", () => {
    const coord = new SwarmCoordinator(["/wt/a", "/wt/b"]);
    const l1 = coord.acquire("agent-1");
    const l2 = coord.acquire("agent-2");
    assert.ok(l1 && l2);
    assert.equal(coord.acquire("agent-3"), null);
    l1.release();
    l2.release();
  });

  it("drains queued waiters FIFO on release", () => {
    const coord = new SwarmCoordinator(["/wt/a"]);
    const first = coord.acquireStrict("agent-1");
    const grants: string[] = [];
    coord.waitForSlot("agent-2", (_err, lease) => grants.push(lease!.slot.agentId!));
    coord.waitForSlot("agent-3", (_err, lease) => grants.push(lease!.slot.agentId!));
    assert.deepEqual(grants, []);
    first.release();
    assert.deepEqual(grants, ["agent-2"]);
    assert.equal(coord.listSlots()[0]!.agentId, "agent-2");
    coord.release("wt-1");
    assert.deepEqual(grants, ["agent-2", "agent-3"]);
  });

  it("waitForSlot grants immediately when a slot is free", () => {
    const coord = new SwarmCoordinator(["/wt/a"]);
    let got: string | null = null;
    coord.waitForSlot("agent-1", (_err, lease) => (got = lease!.slot.agentId!));
    assert.equal(got, "agent-1");
  });

  it("abortWaiters rejects queued agents without granting slots", () => {
    const coord = new SwarmCoordinator(["/wt/a"]);
    coord.acquireStrict("agent-1");
    let err: Error | null = null;
    coord.waitForSlot("agent-2", (e) => (err = e!));
    const rejected = coord.abortWaiters("stop");
    assert.equal(rejected, 1);
    assert.ok(err !== null);
    assert.ok((err as object) instanceof SlotAcquisitionError);
    assert.equal((err as Error).message, "stop");
    assert.equal(coord.listSlots()[0]!.agentId, "agent-1");
  });

  it("release is idempotent per lease and errors on idle slots", () => {
    const coord = new SwarmCoordinator(["/wt/a"]);
    const lease = coord.acquireStrict("agent-1");
    lease.release();
    lease.release(); // second call is a no-op, not an error
    assert.throws(() => coord.release("wt-1"), /not busy/);
  });

  it("retireSlot removes capacity but refuses busy slots", () => {
    const coord = new SwarmCoordinator(["/wt/a", "/wt/b"]);
    coord.retireSlot("wt-2");
    assert.equal(coord.parallelism, 1);
    const lease = coord.acquireStrict("agent-1");
    assert.throws(() => coord.retireSlot("wt-1"), /busy/);
    lease.release();
  });

  it("rejects empty agent ids and unknown slots", () => {
    const coord = new SwarmCoordinator(["/wt/a"]);
    assert.throws(() => coord.acquire(""), /agentId/);
    assert.throws(() => coord.release("wt-404"), /unknown slot/);
  });

  it("snapshot exposes per-slot ownership state", () => {
    const coord = new SwarmCoordinator(["/wt/a", "/wt/b"]);
    const lease = coord.acquireStrict("agent-9");
    assert.deepEqual(coord.snapshot(), {
      "wt-1": { path: "/wt/a", status: "busy", agentId: "agent-9" },
      "wt-2": { path: "/wt/b", status: "idle", agentId: null },
    });
    lease.release();
  });

  it("uses the injected clock for claim timestamps deterministically", () => {
    let tick = 100;
    const coord = new SwarmCoordinator(["/wt/a"], { now: () => tick });
    const lease = coord.acquireStrict("agent-1");
    assert.equal(lease.slot.claimedAt, 100);
    tick = 200;
    lease.release();
    const second = coord.acquireStrict("agent-2");
    assert.equal(second.slot.claimedAt, 200);
    second.release();
  });
});

describe("H07.02 sharding", () => {
  it("partitions files into non-overlapping shards covering every input", () => {
    const files = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"].map((path) => ({ path }));
    const shards = planShards(files, 3);
    assert.equal(shards.length, 3);
    assert.ok(shardsAreDisjoint(shards), "shard file scopes must not overlap");
    assert.ok(shardsCover(shards, files.map((f) => f.path)), "shards must cover all files");
  });

  it("keeps shards disjoint when shardCount exceeds file count", () => {
    const shards = shardPaths(["only.ts"], 4);
    assert.equal(shards.length, 4);
    assert.ok(shardsAreDisjoint(shards));
    assert.ok(shardsCover(shards, ["only.ts"]));
    assert.equal(shards.filter((s) => s.files.length === 0).length, 3);
  });

  it("balances weight across shards (greedy LPT ordering)", () => {
    const files = [
      { path: "big.ts", weight: 10 },
      { path: "mid1.ts", weight: 6 },
      { path: "mid2.ts", weight: 5 },
      { path: "small1.ts", weight: 2 },
      { path: "small2.ts", weight: 1 },
    ];
    const shards = planShards(files, 2);
    assert.ok(shardsAreDisjoint(shards));
    assert.equal(shardWeightSpread(shards), 0); // LPT lands [big,small1]=12 vs [mid1,mid2,small2]=12
    const total = shards.reduce((sum, s) => sum + s.weight, 0);
    assert.equal(total, 24);
  });

  it("defaults missing weights to 1", () => {
    const shards = planShards([{ path: "a.ts" }, { path: "b.ts", weight: 5 }], 2);
    assert.equal((shards[0]?.weight ?? 0) + (shards[1]?.weight ?? 0), 6);
  });

  it("is deterministic across repeated plans", () => {
    const files = Array.from({ length: 9 }, (_, i) => ({ path: `f${i}.ts`, weight: (i * 7) % 5 }));
    const first = planShards(files, 3);
    const second = planShards([...files].reverse(), 3);
    assert.deepEqual(second, first);
  });

  it("rejects duplicate paths in strict mode but tolerates them otherwise", () => {
    const input = [{ path: "a.ts" }, { path: "a.ts" }];
    assert.throws(() => planShards(input, 2), ShardingError);
    const lenient = planShards(input, 2, { strict: false });
    assert.ok(shardsAreDisjoint(lenient));
    assert.ok(shardsCover(lenient, ["a.ts"]));
  });

  it("validates shardCount, paths, and weights", () => {
    assert.throws(() => shardPaths(["a.ts"], 0), ShardingError);
    assert.throws(() => shardPaths(["a.ts"], 1.5), ShardingError);
    assert.throws(() => shardPaths([""], 1), ShardingError);
    assert.throws(() => planShards([{ path: "a.ts", weight: -1 }], 1), ShardingError);
  });

  it("handles an empty file scope with empty shards", () => {
    const shards = planShards([], 2);
    assert.equal(shards.length, 2);
    assert.ok(shards.every((s) => s.files.length === 0 && s.weight === 0));
    assert.ok(shardsAreDisjoint(shards));
  });

  it("detects overlap and coverage failures explicitly", () => {
    const overlapping = [
      { index: 0, files: ["a.ts", "b.ts"], weight: 2 },
      { index: 1, files: ["b.ts"], weight: 1 },
    ] as const;
    assert.equal(shardsAreDisjoint(overlapping), false);
    assert.equal(shardsCover(overlapping, ["a.ts"]), false);
    assert.equal(shardsCover(overlapping, ["a.ts", "b.ts", "c.ts"]), false);
    // Overlap makes coverage fail even when the unique path set matches:
    // the duplicated path is rejected as an unknown/duplicate.
    assert.equal(shardsCover(overlapping, ["a.ts", "b.ts"]), false);
    assert.equal(shardsCover(overlapping, ["a.ts", "b.ts", "b.ts"]), false);
  });

  it("end-to-end: coordinator parallelism sizes the shard count", () => {
    const coord = new SwarmCoordinator(["/wt/a", "/wt/b", "/wt/c"]);
    const paths = Array.from({ length: 12 }, (_, i) => `src/mod${i}.ts`);
    const shards = shardPaths(paths, coord.parallelism);
    assert.equal(shards.length, 3);
    assert.ok(shardsAreDisjoint(shards));
    assert.ok(shardsCover(shards, paths));
    const leases = shards.map((_, i) => coord.acquireStrict(`agent-${i}`));
    assert.equal(leases.length, 3);
    assert.equal(coord.acquire("agent-overflow"), null);
    for (const lease of leases) lease.release();
  });
});
