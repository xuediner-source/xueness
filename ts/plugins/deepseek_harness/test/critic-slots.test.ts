import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CriticSlotScheduler,
  SlotPool,
  type SwarmEvent,
} from "../src/swarm/critic-slots.ts";
import type { HarnessModel, ModelResponse } from "../src/builtins/critic-solver.ts";

interface Recorder extends HarnessModel {
  prompts: { role: string; prompt: string }[];
  active: number;
  maxActive: number;
  delay: number;
}

/** Model that records concurrency and plays back queued replies. */
function recorder(id: string, replies: string[], delay = 0): Recorder {
  const model: Recorder = {
    id,
    prompts: [],
    active: 0,
    maxActive: 0,
    delay,
    async complete(request): Promise<ModelResponse> {
      model.prompts.push({ role: request.role, prompt: request.prompt });
      model.active += 1;
      model.maxActive = Math.max(model.maxActive, model.active);
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      const text = replies[(model.prompts.length - 1) % replies.length] ?? "";
      model.active -= 1;
      return { text, usage: { promptTokens: 10, completionTokens: 5 } };
    },
  };
  return model;
}

const patchJson = (content: string) =>
  `{"path": "src/app.ts", "content": ${JSON.stringify(content)}, "summary": "fix"}`;
const acceptJson = '{"verdict": "accept", "score": 0.9, "reasons": ["ok"]}';

describe("SlotPool", () => {
  it("enforces per-kind capacity and queues acquirers FIFO", async () => {
    const pool = new SlotPool("critic", 2);
    const first = await pool.acquire();
    const second = await pool.acquire();
    assert.equal(pool.busyCount, 2);
    let thirdResolved = false;
    const thirdPromise = pool.acquire().then((slot) => {
      thirdResolved = true;
      return slot;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(thirdResolved, false);
    pool.release(first);
    const third = await thirdPromise;
    assert.equal(third.id, first.id, "released slot is handed to the waiting acquirer");
    pool.release(second);
    pool.release(third);
    assert.equal(pool.busyCount, 0);
    assert.deepEqual(
      pool.snapshot().map((slot) => slot.completed),
      [2, 1],
      "the recycled slot completed two jobs, the other one",
    );
  });

  it("rejects non-positive sizes", () => {
    assert.throws(() => new SlotPool("solver", 0), /size >= 1/);
  });
});

describe("CriticSlotScheduler separation", () => {
  it("schedules critic reviews independently of solver slots", async () => {
    const events: SwarmEvent[] = [];
    const solver = recorder("solver", [patchJson("a"), patchJson("b"), patchJson("c")], 5);
    const critic = recorder("critic", [acceptJson], 10);
    const scheduler = new CriticSlotScheduler({
      solver,
      critic,
      solverSlots: 3,
      criticSlots: 1,
      onEvent: (event) => events.push(event),
    });

    const outcomes = await scheduler.run(["task a", "task b", "task c"]);

    assert.equal(outcomes.length, 3);
    const stats = scheduler.stats();
    assert.equal(stats.solver.length, 3);
    assert.equal(stats.critic.length, 1);
    assert.ok(stats.maxConcurrent.solver <= 3);
    assert.ok(stats.maxConcurrent.critic <= 1);
    assert.ok(solver.maxActive <= 3, `solver concurrency ${solver.maxActive} exceeded its pool`);
    assert.equal(critic.maxActive, 1, "critic pool of 1 must never run two reviews at once");
    assert.ok(solver.maxActive >= 2, "3 solver slots should overlap solver calls");
    assert.ok(
      outcomes.every((outcome) => outcome.criticSlotId === "critic-0"),
      "all reviews ran on the critic pool",
    );
    assert.deepEqual(
      new Set(outcomes.map((outcome) => outcome.solverSlotId)),
      new Set(["solver-0", "solver-1", "solver-2"]),
      "solver work spread across solver slots",
    );
    const kinds = events.map((event) => (event.type === "job-start" ? event.kind : null)).filter(Boolean);
    assert.deepEqual([...new Set(kinds)].sort(), ["critic", "solver"]);
  });

  it("keeps a slow critic from blocking solver progress and vice versa", async () => {
    const solver = recorder("solver", [patchJson("x")], 1);
    const critic = recorder("critic", [acceptJson], 30);
    const scheduler = new CriticSlotScheduler({ solver, critic, solverSlots: 1, criticSlots: 1 });
    const runPromise = scheduler.run(["only task"]);
    const solverDone = solver.prompts.length >= 1;
    await runPromise;
    assert.ok(solverDone || solver.prompts.length >= 1);
    assert.equal(scheduler.stats().completedReviews, 1);
    assert.equal(solver.prompts.length, 1);
    assert.equal(critic.prompts.length, 1);
    assert.equal(critic.prompts[0]!.role, "critic");
    assert.equal(solver.prompts[0]!.role, "solver");
  });

  it("reports outcomes per task and rejects empty task lists entries", async () => {
    const solver = recorder("solver", [patchJson("body")]);
    const critic = recorder("critic", ['{"verdict": "reject", "score": 0.2, "reasons": ["no"]}']);
    const scheduler = new CriticSlotScheduler({ solver, critic, solverSlots: 2, criticSlots: 2 });
    const outcomes = await scheduler.run(["task"]);
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]!.review.verdict, "reject");
    assert.equal(outcomes[0]!.patch?.content, "body");
    await assert.rejects(scheduler.run([""]), /non-empty tasks/);
  });
});

describe("SlotPool release invariant", () => {
  it("rejects releasing a slot that is not acquired", async () => {
    const pool = new SlotPool("critic", 1);
    const slot = await pool.acquire();
    pool.release(slot);
    assert.throws(() => pool.release(slot), /not acquired/);
    const again = await pool.acquire();
    assert.equal(again.id, slot.id);
    assert.equal(pool.busyCount, 1, "a double release must not hand one slot to two holders");
    pool.release(again);
  });
});

describe("CriticSlotScheduler failure containment", () => {
  it("isolates a throwing solver and still reports one outcome per task", async () => {
    const solver: HarnessModel = {
      id: "solver-boom",
      async complete(request): Promise<ModelResponse> {
        if (request.prompt === "poison") throw new Error("solver died");
        return { text: patchJson("ok") };
      },
    };
    const critic = recorder("critic", [acceptJson]);
    const scheduler = new CriticSlotScheduler({ solver, critic, solverSlots: 2, criticSlots: 1 });

    const outcomes = await scheduler.run(["poison", "fine"]);

    assert.equal(outcomes.length, 2, "a crashed solver job must not drop its outcome");
    assert.equal(outcomes[0]!.review.malformed, true);
    assert.match(outcomes[0]!.review.reasons.join(" "), /solver failed: solver died/);
    assert.equal(outcomes[1]!.review.verdict, "accept");
    assert.equal(scheduler.stats().completedReviews, 2);
    assert.deepEqual(
      scheduler.stats().solver.map((slot) => slot.state),
      ["idle", "idle"],
      "no solver slot may stay busy after a crashed job",
    );
  });

  it("isolates a throwing critic call", async () => {
    const solver = recorder("solver", [patchJson("a")]);
    const critic: HarnessModel = { id: "critic-boom", async complete() { throw new Error("critic died"); } };
    const scheduler = new CriticSlotScheduler({ solver, critic, solverSlots: 1, criticSlots: 1 });

    const outcomes = await scheduler.run(["task"]);

    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]!.review.malformed, true);
    assert.match(outcomes[0]!.review.reasons.join(" "), /critic failed: critic died/);
    assert.deepEqual(scheduler.stats().critic.map((slot) => slot.state), ["idle"]);
  });
});
