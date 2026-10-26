import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  JobCoordinator,
  type CoordinatorEvent,
} from "../src/swarm/job-runner.ts";
import type { HarnessModel, ModelResponse } from "../src/builtins/critic-solver.ts";

const patchJson = (content: string) =>
  `{"path": "src/app.ts", "content": ${JSON.stringify(content)}, "summary": "fix"}`;

interface Flaky extends HarnessModel {
  failuresRemaining: Map<string, number>;
  started: string[];
}

/** Fails the first N calls per task, then returns a valid patch. */
function flakyModel(failuresPerTask: Record<string, number>): Flaky {
  const model: Flaky = {
    id: "flaky",
    failuresRemaining: new Map(Object.entries(failuresPerTask)),
    started: [],
    async complete(request): Promise<ModelResponse> {
      model.started.push(request.prompt);
      const remaining = model.failuresRemaining.get(request.prompt) ?? 0;
      if (remaining > 0) {
        model.failuresRemaining.set(request.prompt, remaining - 1);
        throw new Error(`boom on ${request.prompt}`);
      }
      return { text: patchJson(`body for ${request.prompt}`), usage: { promptTokens: 5, completionTokens: 5 } };
    },
  };
  return model;
}

describe("JobCoordinator failure isolation", () => {
  it("retries a failed slot job and marks it failed only after retries are exhausted", async () => {
    const model = flakyModel({ poison: 99 });
    const events: CoordinatorEvent[] = [];
    const coordinator = new JobCoordinator({
      solver: model,
      solverSlots: 1,
      maxRetries: 2,
      onEvent: (event) => events.push(event),
    });

    const result = await coordinator.run(["poison"]);

    assert.equal(result.ok, false);
    const job = result.jobs[0]!;
    assert.equal(job.state, "failed");
    assert.equal(job.attempts, 3, "initial attempt + 2 retries");
    assert.match(job.error ?? "", /boom on poison/);
    assert.equal(result.progress.failed, 1);
    assert.equal(result.progress.settled, 1);
    const retries = events.filter((event) => event.type === "job-retry");
    assert.equal(retries.length, 2);
    const failed = events.filter((event) => event.type === "job-failed");
    assert.equal(failed.length, 1);
    assert.equal(events.at(-1)?.type, "job-failed");
    assert.deepEqual(
      coordinator.slotStatuses().map((status) => status.busy),
      [0, 0],
      "failed job must not leak its slot",
    );
  });

  it("one poisoned job never drags down sibling slots", async () => {
    const model = flakyModel({ poison: 99, fine: 0, also: 0 });
    const coordinator = new JobCoordinator({ solver: model, solverSlots: 3, maxRetries: 1 });

    const result = await coordinator.run(["poison", "fine", "also"]);

    assert.equal(result.ok, false);
    const byTask = new Map(result.jobs.map((job) => [job.task, job]));
    assert.equal(byTask.get("poison")?.state, "failed");
    assert.equal(byTask.get("fine")?.state, "succeeded");
    assert.equal(byTask.get("also")?.state, "succeeded");
    assert.equal(byTask.get("fine")?.patch?.path, "src/app.ts");
    assert.deepEqual(result.progress, { total: 3, pending: 0, running: 0, succeeded: 2, failed: 1, settled: 3 });
  });

  it("recovers a transient failure via retry", async () => {
    const model = flakyModel({ flaky: 1, solid: 0 });
    const coordinator = new JobCoordinator({ solver: model, solverSlots: 2, maxRetries: 1 });

    const result = await coordinator.run(["flaky", "solid"]);

    assert.equal(result.ok, true);
    const flaky = result.jobs.find((job) => job.task === "flaky");
    assert.equal(flaky?.state, "succeeded");
    assert.equal(flaky?.attempts, 2, "first attempt failed, retry succeeded");
    assert.equal(flaky?.error, "boom on flaky", "failure reason is kept for audit");
    assert.equal(result.progress.succeeded, 2);
  });

  it("reports live progress while jobs are in flight", async () => {
    let release: (() => void) | undefined;
    const model: HarnessModel = {
      id: "gated",
      async complete(request): Promise<ModelResponse> {
        if (request.prompt === "slow") await new Promise<void>((resolve) => (release = resolve));
        return { text: patchJson("x") };
      },
    };
    const coordinator = new JobCoordinator({ solver: model, solverSlots: 2, maxRetries: 0 });
    const runPromise = coordinator.run(["slow", "fast"]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const mid = coordinator.progress();
    assert.equal(mid.total, 2);
    assert.equal(mid.settled >= 1 && mid.settled < 2, true, `expected one settled job mid-run, got ${mid.settled}`);
    release?.();
    const result = await runPromise;
    assert.deepEqual(result.progress.settled, 2);
    assert.equal(result.ok, true);
  });

  it("validates options and task inputs", async () => {
    const model: HarnessModel = { id: "m", async complete() { return { text: patchJson("x") }; } };
    assert.throws(() => new JobCoordinator({ solver: model, maxRetries: -1 }), /maxRetries >= 0/);
    const coordinator = new JobCoordinator({ solver: model });
    await assert.rejects(coordinator.run(["ok", ""]), /non-empty tasks/);
  });
});

describe("JobCoordinator retry backoff", () => {
  it("releases the solver slot while a job waits to retry", async () => {
    const calls: string[] = [];
    const model: HarnessModel = {
      id: "slow-retry",
      async complete(request): Promise<ModelResponse> {
        calls.push(request.prompt);
        if (request.prompt === "poison" && calls.filter((c) => c === "poison").length === 1) {
          throw new Error("boom");
        }
        return { text: patchJson("x") };
      },
    };
    const coordinator = new JobCoordinator({ solver: model, solverSlots: 1, maxRetries: 1, retryDelayMs: 40 });
    const runPromise = coordinator.run(["poison", "other"]);
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.deepEqual(
      coordinator.slotStatuses().map((status) => status.busy),
      [0, 0],
      "a job backing off must not hold its solver slot idle",
    );
    // Sibling progressed past the retry window because the slot was free.
    assert.deepEqual(calls, ["poison", "other"]);

    const result = await runPromise;
    assert.equal(result.ok, true);
    assert.equal(result.jobs.find((job) => job.task === "poison")?.attempts, 2);
  });
});
