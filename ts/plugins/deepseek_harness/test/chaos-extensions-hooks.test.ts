/** H11.03 — Cross-plugin extensions×hooks stress: no deadlock; cleanup always. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CHAOS_SCENARIOS, healthyModel } from "../src/chaos/scenarios.ts";
import { runChaosStress } from "../src/chaos/stress-runner.ts";

describe("chaos extensions×hooks (H11.03)", () => {
  it("completes under budget and always cleans slot pool", async () => {
    const scenarios = CHAOS_SCENARIOS.filter((s) => s.kind === "timeout" || s.kind === "rate_limit").slice(0, 2);
    const report = await runChaosStress({
      scenarios,
      concurrency: 2,
      callsPerScenario: 4,
      model: healthyModel(),
    });
    assert.ok(report.maxConcurrentObserved <= 2);
    assert.equal(report.results.length, scenarios.length);
    assert.ok(report.totalCalls === scenarios.length * 4);
    // Cleanup: every started call must be accounted as success/invalid/failed.
    for (const r of report.results) {
      const accounted = r.stats.succeeded + r.stats.invalidResponses + r.stats.failed;
      assert.equal(accounted, r.stats.started);
    }
  });
});
