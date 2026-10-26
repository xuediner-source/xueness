/** H11.04 — providers×subagents stress: quota/429 degrade gracefully. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CHAOS_SCENARIOS, healthyModel } from "../src/chaos/scenarios.ts";
import { runChaosStress } from "../src/chaos/stress-runner.ts";
import { buildChaosReport } from "../src/chaos/report.ts";

describe("chaos providers×subagents (H11.04)", () => {
  it("rate_limit / 429 paths resolve without rejecting the run", async () => {
    const scenarios = CHAOS_SCENARIOS.filter((s) => s.kind === "rate_limit" || s.id.includes("429")).slice(0, 2);
    assert.ok(scenarios.length >= 1, "catalog must include rate_limit/429");
    const run = await runChaosStress({
      scenarios,
      concurrency: 3,
      callsPerScenario: 3,
      model: healthyModel(),
    });
    const report = buildChaosReport(run, { now: () => "t0" });
    assert.equal(run.results.length, scenarios.length);
    for (const r of run.results) {
      assert.ok(r.stats.failed + r.stats.succeeded + r.stats.invalidResponses === r.stats.started);
    }
    assert.ok(typeof report.hardFail === "boolean");
  });
});
