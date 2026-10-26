import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  defaultResponseValid,
  runChaosStress,
  type StressRunReport,
} from "../src/chaos/stress-runner.ts";
import {
  CHAOS_SCENARIOS,
  chaosScenarioById,
  healthyModel,
  type ChaosScenario,
} from "../src/chaos/scenarios.ts";
import type { HarnessModel, ModelResponse } from "../src/builtins/critic-solver.ts";

function requireScenario(id: string): ChaosScenario {
  const scenario = chaosScenarioById(id);
  assert.ok(scenario, `missing scenario ${id}`);
  return scenario;
}

function soleResult(report: StressRunReport) {
  const result = report.results[0];
  assert.ok(result, "expected exactly one scenario result");
  return result;
}

/** Tracks how many calls are live at once; used to verify the slot budget. */
function countingModel(delayMs = 6): HarnessModel & { active: number; maxActive: number; calls: number } {
  const state = { active: 0, maxActive: 0, calls: 0 };
  const model: HarnessModel & typeof state = {
    ...state,
    id: "counting",
    async complete(): Promise<ModelResponse> {
      model.calls += 1;
      model.active += 1;
      model.maxActive = Math.max(model.maxActive, model.active);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      model.active -= 1;
      return { text: '{"verdict": "accept"}', usage: { promptTokens: 1, completionTokens: 1 } };
    },
  };
  return model;
}

describe("H11.02 stress runner", () => {
  it("runs every catalog scenario under the budget and reports per-scenario stats", async () => {
    const report = await runChaosStress({ concurrency: 3, callsPerScenario: 5 });
    assert.equal(report.results.length, CHAOS_SCENARIOS.length);
    assert.equal(report.concurrency, 3);
    assert.equal(report.callsPerScenario, 5);
    assert.equal(report.totalCalls, CHAOS_SCENARIOS.length * 5);
    for (const result of report.results) {
      const { started, succeeded, invalidResponses, failed } = result.stats;
      assert.equal(started, 5, `${result.scenarioId} must start every call`);
      assert.equal(succeeded + invalidResponses + failed, started, `${result.scenarioId} buckets must sum to started`);
    }
  });

  it("bounds concurrency: observed high-water never exceeds the slot budget", async () => {
    const model = countingModel(6);
    const report = await runChaosStress({ concurrency: 2, callsPerScenario: 4, model });
    assert.ok(report.maxConcurrentObserved >= 1, "runner must observe real parallelism");
    assert.ok(report.maxConcurrentObserved <= 2, `high-water ${report.maxConcurrentObserved} exceeded budget 2`);
    assert.ok(model.maxActive <= 2, `model saw ${model.maxActive} concurrent calls, budget was 2`);
    // Only flaky_intermittent passes through to the victim model (4 calls,
    // fault on the 3rd), so the healthy model itself is invoked exactly 3 times.
    assert.equal(model.calls, 3);
  });

  it("isolates per-scenario failures without rejecting the run", async () => {
    const report: StressRunReport = await runChaosStress({ concurrency: 4, callsPerScenario: 3 });
    const byId = new Map(report.results.map((result) => [result.scenarioId, result]));

    const timeout = byId.get("net_timeout");
    assert.ok(timeout);
    assert.equal(timeout.stats.failed, 3, "every timeout call must fail");
    assert.deepEqual(timeout.stats.faultKinds, ["timeout"]);

    const throttled = byId.get("rate_limit_429");
    assert.ok(throttled);
    assert.equal(throttled.stats.failed, 3);
    assert.deepEqual(throttled.stats.faultKinds, ["rate_limit"]);
    assert.ok(throttled.errors.length > 0 && throttled.errors.length <= 3);

    const partial = byId.get("partial_json");
    assert.ok(partial);
    assert.equal(partial.stats.invalidResponses, 3, "truncated JSON resolves but is invalid");
    assert.equal(partial.stats.failed, 0);

    const flaky = byId.get("flaky_intermittent");
    assert.ok(flaky);
    assert.equal(flaky.stats.failed + flaky.stats.invalidResponses + flaky.stats.succeeded, 3);
    assert.ok(report.totalFailures > 0, "chaos run must record the injected failures");
  });

  it("caps recorded error messages per scenario", async () => {
    const report = await runChaosStress({
      scenarios: [requireScenario("rate_limit_429")],
      callsPerScenario: 20,
      concurrency: 4,
      maxErrorsRecorded: 5,
    });
    const only = soleResult(report);
    assert.equal(only.errors.length, 5);
    assert.equal(only.stats.failed, 20);
  });

  it("rejects invalid budgets instead of silently unbounding", async () => {
    await assert.rejects(runChaosStress({ concurrency: 0 }), /concurrency >= 1/);
    await assert.rejects(runChaosStress({ callsPerScenario: 0 }), /callsPerScenario >= 1/);
  });

  it("defaultResponseValid flags blank bodies and unparseable JSON-shaped faults", () => {
    const ok = chaosScenarioById("rate_limit_429")!;
    assert.ok(defaultResponseValid(ok, '{"verdict": "accept"}'));
    assert.ok(!defaultResponseValid(ok, "  "));
    const jsonShaped = chaosScenarioById("partial_json")!;
    assert.ok(!defaultResponseValid(jsonShaped, '{"verdict": "acce'));
    assert.ok(defaultResponseValid(jsonShaped, '{"verdict": "accept"}'));
  });

  it("a scenario whose inject throws is isolated to its own bucket", async () => {
    const boom: ChaosScenario = {
      id: "boom",
      kind: "timeout",
      description: "inject() throws synchronously",
      inject(): never {
        throw new Error("wiring exploded");
      },
    };
    const report = await runChaosStress({
      scenarios: [boom, requireScenario("rate_limit_429")],
      concurrency: 2,
      callsPerScenario: 2,
    });
    const [boomResult, throttledResult] = report.results;
    assert.ok(boomResult);
    assert.ok(throttledResult);
    assert.equal(boomResult.stats.failed, 2);
    assert.deepEqual(boomResult.errors, ["inject failed: wiring exploded", "inject failed: wiring exploded"]);
    assert.equal(throttledResult.stats.failed, 2, "the neighbouring scenario is unaffected");
  });

  it("a healthy model under flaky chaos faults exactly the every-3rd call", async () => {
    const report = await runChaosStress({
      scenarios: [requireScenario("flaky_intermittent")],
      concurrency: 3,
      callsPerScenario: 4,
      model: { ...healthyModel(), async complete() { return { text: '{"ok": true}' }; } },
    });
    const only = soleResult(report);
    // the wrapper is shared per scenario, so its counter trips on call 3 only
    assert.equal(only.stats.succeeded, 3);
    assert.equal(only.stats.failed, 1);
    assert.deepEqual(only.stats.faultKinds, ["rate_limit"]);
    assert.equal(report.totalFailures, 1);
  });
});
