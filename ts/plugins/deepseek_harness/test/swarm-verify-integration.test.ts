/** H07.05 — swarm ↔ harness verify integration. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SwarmVerifyPipeline,
  runSwarmWithVerify,
  type VerifyEvent,
} from "../src/swarm/verify-integration.ts";
import type { GateDefinition, GateRun } from "../src/builtins/auto-verify.ts";
import type { HarnessModel, ModelResponse } from "../src/builtins/critic-solver.ts";

const patchJson = (path: string) => `{"path": "${path}", "content": "x", "summary": "fix ${path}"}`;

/** Solver model that tracks how many calls are in flight at once. */
function trackingSolver(paths: readonly string[]): { model: HarnessModel; maxConcurrent: number } {
  const state = { active: 0, maxConcurrent: 0 };
  const known = new Set(paths);
  const model: HarnessModel = {
    id: "solver",
    async complete(request): Promise<ModelResponse> {
      const mine = known.has(request.prompt) ? request.prompt : paths[0]!;
      state.active += 1;
      state.maxConcurrent = Math.max(state.maxConcurrent, state.active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      state.active -= 1;
      return { text: patchJson(mine), usage: { promptTokens: 10, completionTokens: 4 } };
    },
  };
  return { model, get maxConcurrent() { return state.maxConcurrent; } };
}

/**
 * Gate runner that holds each call open briefly so passes overlap, and
 * records concurrency plus which gate ran for which cwd-independent context.
 */
function overlappingRunner(results: Record<string, GateRun> = {}): {
  run: (gate: GateDefinition, cwd: string, timeoutMs: number) => Promise<GateRun>;
  maxConcurrent: () => number;
  calls: { gate: string; timeoutMs: number }[];
} {
  const state = { active: 0, maxConcurrent: 0 };
  const calls: { gate: string; timeoutMs: number }[] = [];
  return {
    calls,
    maxConcurrent: () => state.maxConcurrent,
    async run(gate, _cwd, timeoutMs) {
      calls.push({ gate: gate.name, timeoutMs });
      state.active += 1;
      state.maxConcurrent = Math.max(state.maxConcurrent, state.active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      state.active -= 1;
      return results[gate.name] ?? { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    },
  };
}

const gate = (name: string, watch?: readonly string[]): GateDefinition => ({
  name,
  command: ["echo", name],
  ...(watch ? { watch } : {}),
});

describe("SwarmVerifyPipeline (H07.05)", () => {
  it("swarm completion triggers verify for every succeeded job with at least 2 slots in parallel", async () => {
    const paths = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"];
    const solver = trackingSolver(paths);
    const runner = overlappingRunner();
    const events: VerifyEvent[] = [];

    const result = await runSwarmWithVerify(
      {
        solver: solver.model,
        gates: [gate("typecheck"), gate("test")],
        solverSlots: 2,
        verifySlots: 2,
        run: runner.run,
        defaultTimeoutMs: 5000,
        onEvent: (event) => events.push(event),
      },
      paths,
    );

    assert.equal(result.ok, true);
    assert.equal(result.progress.succeeded, 4, "all four swarm jobs succeed");
    assert.ok(solver.maxConcurrent >= 2, `solver slots must run >= 2 in parallel (got ${solver.maxConcurrent})`);
    assert.equal(result.verify.triggered, 4, "every succeeded job triggers a verify pass");
    assert.equal(result.verify.passed, 4);
    assert.equal(result.verify.failed, 0);
    assert.ok(
      result.verify.maxConcurrent >= 2,
      `verify passes must overlap on >= 2 slots (got ${result.verify.maxConcurrent})`,
    );
    assert.equal(runner.maxConcurrent(), result.verify.maxConcurrent);
    // Verify is scoped per job: each edited path selects all always-run gates.
    assert.equal(runner.calls.length, 8, "4 jobs x 2 gates");
    assert.deepEqual(
      events.filter((event) => event.type === "verify-start").map((event) => [...(event as { edited: readonly string[] }).edited]),
      paths.map((path) => [path]),
    );
    assert.equal(events.at(-1)?.type, "verify-done");
  });

  it("scopes each verify pass to the gates watching the job's edited path", async () => {
    const runner = overlappingRunner();
    const result = await runSwarmWithVerify(
      {
        solver: { id: "s", async complete(request) { return { text: patchJson("ts/only.ts") }; } },
        gates: [gate("tsc", ["ts"]), gate("py", ["py"]), gate("always")],
        run: runner.run,
      },
      ["task"],
    );

    assert.equal(result.ok, true);
    assert.deepEqual(
      runner.calls.map((call) => call.gate).sort(),
      ["always", "tsc"],
      "py gate must not run for a ts-only edit",
    );
  });

  it("a failed job never triggers verify and never drags its siblings down", async () => {
    const solver: HarnessModel = {
      id: "flaky",
      async complete(request): Promise<ModelResponse> {
        if (request.prompt === "poison") throw new Error("boom");
        return { text: patchJson(`src/${request.prompt}.ts`) };
      },
    };
    const runner = overlappingRunner();
    const result = await runSwarmWithVerify(
      { solver, gates: [gate("typecheck")], maxRetries: 0, run: runner.run },
      ["poison", "fine", "also-fine"],
    );

    assert.equal(result.ok, false);
    assert.equal(result.progress.failed, 1);
    assert.equal(result.verify.triggered, 2, "only the succeeded jobs verify");
    assert.equal(result.verify.skipped, 1, "failed job skips verify");
    const failed = result.jobs.find((job) => job.id === "job-0")!;
    assert.equal(failed.state, "failed");
    assert.equal(failed.verify, null);
    assert.deepEqual(failed.edited, []);
    assert.equal(result.jobs.filter((job) => job.verify !== null).length, 2);
  });

  it("a failing gate fails the swarm report without aborting sibling verify passes", async () => {
    const runner = overlappingRunner({ typecheck: { exitCode: 1, stdout: "boom\nboom\nboom\nboom\n", stderr: "", timedOut: false } });
    const events: VerifyEvent[] = [];
    const result = await runSwarmWithVerify(
      {
        solver: { id: "s", async complete(request) { return { text: patchJson(`src/${request.prompt}.ts`) }; } },
        gates: [gate("typecheck")],
        run: runner.run,
        onEvent: (event) => events.push(event),
      },
      ["one", "two"],
    );

    assert.equal(result.ok, false, "verify failure fails the swarm even though jobs succeeded");
    assert.equal(result.progress.failed, 0);
    assert.equal(result.verify.passed, 0);
    assert.equal(result.verify.failed, 2);
    const first = result.jobs[0]!;
    assert.equal(first.verify?.passed, false);
    assert.match(first.verify?.outcomes[0]?.diagnostics ?? "", /gate typecheck failed/);
    assert.match(first.verify?.outcomes[0]?.diagnostics ?? "", /repeated 4 times/);
    assert.equal(events.filter((event) => event.type === "verify-done" && !event.passed).length, 2);
  });

  it("retries jobs before verifying and validates options", async () => {
    let attempts = 0;
    const solver: HarnessModel = {
      id: "retry",
      async complete(): Promise<ModelResponse> {
        attempts += 1;
        if (attempts === 1) throw new Error("transient");
        return { text: patchJson("src/fixed.ts") };
      },
    };
    const runner = overlappingRunner();
    const result = await runSwarmWithVerify(
      { solver, gates: [gate("typecheck")], maxRetries: 1, run: runner.run },
      ["flaky"],
    );
    assert.equal(result.ok, true);
    assert.equal(result.jobs[0]?.attempts, 2, "verify only runs after the retry succeeds");
    assert.equal(result.verify.triggered, 1);

    assert.throws(
      () => new SwarmVerifyPipeline({ solver, gates: [gate("g")], verifySlots: 0 }),
      /verifySlots/,
    );
  });
});
