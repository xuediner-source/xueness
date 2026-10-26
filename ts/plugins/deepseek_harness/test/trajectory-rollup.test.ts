/** H07.06 — swarm trajectory rollup. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SwarmTrajectoryRollup,
  parseRollup,
  summarizeSlot,
  summarizeSwarm,
} from "../src/swarm/trajectory-rollup.ts";

const line = (modelId: string, role: string, callIndex: number, promptTokens: number, cachedTokens: number): string =>
  JSON.stringify({
    type: "exchange",
    at: "x",
    session: "s",
    round: 1,
    role,
    modelId,
    callIndex,
    prompt: "p",
    response: "r",
    usage: { promptTokens, completionTokens: 1, cachedTokens },
  });

describe("trajectory rollup (H07.06)", () => {
  it("summarizes one slot and the whole swarm deterministically", () => {
    const at = "2026-10-26T00:00:00.000Z";
    const a = [line("m", "solver", 1, 100, 50), line("m", "critic", 2, 100, 80)].join("\n");
    const b = [line("m", "solver", 1, 200, 0)].join("\n");
    const inputs = [
      { slotId: "a", jobId: "j1", trajectory: a },
      { slotId: "b", jobId: "j2", trajectory: b },
    ];
    const slotA = summarizeSlot(inputs[0]!, at);
    assert.equal(slotA.type, "slot");
    assert.equal(slotA.slotId, "a");
    assert.equal(slotA.calls, 2);
    const swarm = summarizeSwarm(inputs, at);
    assert.equal(swarm.type, "swarm");
    assert.equal(swarm.slots, 2);
    assert.equal(swarm.calls, 3);
    assert.deepEqual(summarizeSwarm(inputs, at), swarm);
  });

  it("SwarmTrajectoryRollup writes slot then swarm JSONL frames", () => {
    const rollup = new SwarmTrajectoryRollup({ now: () => new Date("2026-10-26T00:00:00.000Z") });
    const traj = line("m", "solver", 1, 40, 10);
    const swarm = rollup.rollup([{ slotId: "s1", trajectory: traj }]);
    assert.equal(swarm.slots, 1);
    const frames = parseRollup(rollup.text());
    assert.equal(frames.length, 2);
    assert.equal(frames[0]!.type, "slot");
    assert.equal(frames[1]!.type, "swarm");
  });

  it("rejects duplicate slot/job keys", () => {
    const rollup = new SwarmTrajectoryRollup({ now: () => new Date("2026-10-26T00:00:00.000Z") });
    const traj = line("m", "solver", 1, 10, 0);
    assert.throws(
      () => rollup.rollup([
        { slotId: "s1", jobId: "j", trajectory: traj },
        { slotId: "s1", jobId: "j", trajectory: traj },
      ]),
      /duplicate slot trajectory/,
    );
  });
});
