/** H10.05 optimizer history. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BenchRunReport, BenchRunSummary } from "../src/bench/runner.ts";
import type { VerifySummary } from "../src/builtins/auto-verify.ts";
import { foldFitness, type FitnessEvaluation } from "../src/optimizer/fitness.ts";
import { createGenome } from "../src/optimizer/genome.ts";
import { createOptimizerHistory } from "../src/optimizer/history.ts";

const benchOf = (ok: number, failed: number, ticks: number): BenchRunReport => {
  const summary: BenchRunSummary = { total: ok + failed, ok, failed, totalTicks: ticks, ranking: [] };
  return { results: [], summary };
};

const fit = (id: string, ok: number): FitnessEvaluation => {
  const benchReport = benchOf(ok, 1 - Math.min(ok, 1), 10);
  const verifySummary: VerifySummary = { passed: true, outcomes: [], summary: "synthetic" };
  return { genomeId: id, breakdown: foldFitness(benchReport, verifySummary), benchReport, verifySummary };
};

describe("optimizer history (H10.05)", () => {
  it("tracks best and rollbacks", () => {
    const history = createOptimizerHistory();
    const g0 = createGenome({ id: "g0", prompt: "a" });
    const g1 = createGenome({ id: "g1", prompt: "b" });
    history.record({ at: "t0", genome: g0, fitness: fit("g0", 0) });
    history.record({ at: "t1", genome: g1, fitness: fit("g1", 1) });
    assert.equal(history.best()?.genome.id, "g1");
    assert.equal(history.rollbackToBest()?.id, "g1");
    assert.match(history.exportJsonl(), /"g1"/);
  });
});
