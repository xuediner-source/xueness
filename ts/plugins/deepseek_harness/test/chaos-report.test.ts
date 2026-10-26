/** H11.05 chaos report + flake detector. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildChaosReport } from "../src/chaos/report.ts";
import { ChaosError } from "../src/chaos/scenarios.ts";
import { runChaosStress, type StressRunReport } from "../src/chaos/stress-runner.ts";

const base = (overrides: Partial<StressRunReport> = {}): StressRunReport => ({
  concurrency: 2,
  callsPerScenario: 4,
  results: [
    {
      scenarioId: "timeout",
      kind: "timeout",
      stats: { started: 4, succeeded: 2, invalidResponses: 0, failed: 2, faultKinds: ["timeout"] },
      errors: ["timeout"],
      durationMs: 10,
    },
  ],
  maxConcurrentObserved: 2,
  totalCalls: 4,
  totalFailures: 2,
  durationMs: 10,
  ...overrides,
});

describe("chaos report (H11.05)", () => {
  it("flags mixed success/failure as flakes", () => {
    const report = buildChaosReport(base(), { now: () => "t0" });
    assert.equal(report.flakes.length, 1);
    assert.equal(report.flakes[0]!.scenarioId, "timeout");
    assert.match(report.markdown, /Chaos stress report/);
    assert.match(report.json, /"timeout"/);
  });

  it("marks hardFail when successes mix with unexpected failures", () => {
    const report = buildChaosReport(base());
    assert.equal(report.hardFail, true);
  });

  it("keeps a healthy catalog run green (expected faults are not hard fails)", async () => {
    const run = await runChaosStress({ concurrency: 2, callsPerScenario: 3 });
    const report = buildChaosReport(run);
    assert.equal(report.hardFail, false);
    assert.deepEqual(report.flakes.map((f) => f.scenarioId), ["flaky_intermittent"]);
  });

  it("hard-fails on failures that carry no injected fault kind", async () => {
    const run = await runChaosStress({
      concurrency: 1,
      callsPerScenario: 2,
      scenarios: [{
        id: "broken", kind: "timeout", description: "un-injected error",
        inject: (model) => ({ id: model.id, async complete() { throw new Error("boom"); } }),
      }],
    });
    const report = buildChaosReport(run);
    assert.equal(report.hardFail, true);
    assert.match(report.flakes[0]!.reason, /not attributable/);
  });

  it("hard-fails when a scenario throws a fault kind it does not inject", async () => {
    const run = await runChaosStress({
      concurrency: 1,
      callsPerScenario: 2,
      scenarios: [{
        id: "wrong-family", kind: "timeout", description: "mis-fitted fault",
        inject: (model) => ({
          id: model.id,
          async complete() { throw new ChaosError("rate_limit", "HTTP 429"); },
        }),
      }],
    });
    const report = buildChaosReport(run);
    assert.equal(report.hardFail, true);
    assert.match(report.flakes[0]!.reason, /unexpected fault kinds/);
  });

  it("treats a body family that throws as a hard fail", async () => {
    const run = await runChaosStress({
      concurrency: 1,
      callsPerScenario: 2,
      scenarios: [{
        id: "body-throw", kind: "empty_body", description: "resolved text expected, threw instead",
        inject: (model) => ({ id: model.id, async complete() { throw new ChaosError("empty_body", "no body"); } }),
      }],
    });
    assert.equal(buildChaosReport(run).hardFail, true);
  });
});
