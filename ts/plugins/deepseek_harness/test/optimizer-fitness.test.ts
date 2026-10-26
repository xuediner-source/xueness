/** H10.03: optimizer fitness folds an H06 bench report with an H02 verify summary. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BenchCaseResult, BenchRunReport, BenchRunSummary } from "../src/bench/runner.ts";
import type { GateOutcome, VerifySummary } from "../src/builtins/auto-verify.ts";
import {
  benchScoreOf,
  compareFitness,
  createFitnessEvaluator,
  DEFAULT_FITNESS_WEIGHTS,
  foldFitness,
  formatFitness,
  speedScoreOf,
  verifyScoreOf,
  type OptimizerGenome,
} from "../src/optimizer/fitness.ts";

const genome = (id: string, paths: readonly string[] = []): OptimizerGenome => ({ id, prompt: `prompt for ${id}`, paths });

const benchReport = (ok: number, failed: number, totalTicks = 0): BenchRunReport => {
  const summary: BenchRunSummary = {
    total: ok + failed,
    ok,
    failed,
    totalTicks,
    ranking: [],
  };
  const mk = (index: number, good: boolean): BenchCaseResult => ({
    id: `case_${index}`,
    ok: good,
    iterations: 1,
    timings: good ? { totalTicks, minTicks: totalTicks, maxTicks: totalTicks, meanTicks: totalTicks } : null,
    valueDigest: good ? "digest" : null,
    error: good ? null : "boom",
  });
  const results = [...Array(ok).keys()].map((i) => mk(i, true)).concat([...Array(failed).keys()].map((i) => mk(100 + i, false)));
  return { results, summary };
};

const outcome = (gate: string, passed: boolean): GateOutcome => ({
  gate,
  passed,
  exitCode: passed ? 0 : 1,
  timedOut: false,
  durationMs: 1,
  diagnostics: passed ? null : `gate ${gate} failed (exit 1)`,
});

const verifySummary = (passed: readonly boolean[]): VerifySummary => ({
  passed: passed.every(Boolean),
  outcomes: passed.map((p, i) => outcome(`gate_${i}`, p)),
  summary: "synthetic",
});

describe("component folds (H10.03)", () => {
  it("verifyScoreOf ratios gates and treats an empty selection as fully passed", () => {
    assert.equal(verifyScoreOf(verifySummary([true, true])), 1);
    assert.equal(verifyScoreOf(verifySummary([true, false, true])), 0.666667);
    assert.equal(verifyScoreOf(verifySummary([])), 1);
  });

  it("benchScoreOf ratios ok cases and treats an empty suite as full quality", () => {
    assert.equal(benchScoreOf(benchReport(3, 1)), 0.75);
    assert.equal(benchScoreOf(benchReport(0, 2)), 0);
    assert.equal(benchScoreOf(benchReport(0, 0)), 1);
  });

  it("speedScoreOf decays smoothly with total ticks and never goes negative", () => {
    assert.equal(speedScoreOf(benchReport(1, 0, 0), 1000), 1);
    assert.equal(speedScoreOf(benchReport(1, 0, 1000), 1000), 0.5);
    assert.equal(speedScoreOf(benchReport(1, 0, 3000), 1000), 0.25);
    const huge = speedScoreOf(benchReport(1, 0, Number.MAX_SAFE_INTEGER), 1000);
    assert.ok(huge >= 0 && huge < 0.001);
  });
});

describe("foldFitness (H10.03)", () => {
  it("computes the documented weighted sum for an eligible candidate", () => {
    const breakdown = foldFitness(benchReport(3, 1, 1000), verifySummary([true, true]), { speedScaleTicks: 1000 });
    const expected = 0.5 * 1 + 0.3 * 0.75 + 0.2 * 0.5;
    assert.equal(breakdown.verifyPassed, true);
    assert.equal(breakdown.eligible, true);
    assert.equal(breakdown.score, Math.round(expected * 1e6) / 1e6);
  });

  it("pins the score to 0 for any verify-failing candidate regardless of bench speed", () => {
    const breakdown = foldFitness(benchReport(10, 0, 0), verifySummary([true, false]));
    assert.equal(breakdown.verifyPassed, false);
    assert.equal(breakdown.eligible, false);
    assert.equal(breakdown.score, 0);
  });

  it("is deterministic: identical inputs fold to identical breakdowns", () => {
    const a = foldFitness(benchReport(2, 0, 40), verifySummary([true]), { speedScaleTicks: 80 });
    const b = foldFitness(benchReport(2, 0, 40), verifySummary([true]), { speedScaleTicks: 80 });
    assert.deepEqual(a, b);
  });

  it("honours custom non-negative weights", () => {
    const breakdown = foldFitness(benchReport(0, 4, 999), verifySummary([true]), { weights: { verify: 1, bench: 0, speed: 0 } });
    assert.equal(breakdown.score, 1);
  });
});

describe("createFitnessEvaluator (H10.03 acceptance)", () => {
  it("runs bench then verify and folds both results for one genome", async () => {
    const seen: string[] = [];
    const evaluator = createFitnessEvaluator({
      bench: (g) => {
        seen.push(`bench:${g.id}`);
        return benchReport(2, 0, 500);
      },
      verify: (g) => {
        seen.push(`verify:${g.id}`);
        return verifySummary([true, true, false]);
      },
    });
    const evaluation = await evaluator.evaluate(genome("cand_1", ["skills/alpha.md"]));
    assert.deepEqual(seen, ["bench:cand_1", "verify:cand_1"]);
    assert.equal(evaluation.genomeId, "cand_1");
    assert.equal(evaluation.benchReport.summary.ok, 2);
    assert.equal(evaluation.verifySummary.outcomes.length, 3);
    assert.equal(evaluation.breakdown.verifyScore, 0.666667);
    assert.equal(evaluation.breakdown.score, 0);
    assert.equal(evaluation.breakdown.eligible, false);
  });

  it("forwards the configured weights and speed scale into every evaluation", async () => {
    const evaluator = createFitnessEvaluator({
      bench: () => benchReport(1, 0, 100),
      verify: () => verifySummary([true]),
      weights: { verify: 0, bench: 0.5, speed: 0.5 },
      speedScaleTicks: 100,
    });
    const evaluation = await evaluator.evaluate(genome("cand_2"));
    assert.equal(evaluation.breakdown.score, 0.5 * 1 + 0.5 * 0.5);
  });

  it("rejects invalid weights, scales and missing probes", async () => {
    assert.throws(() => createFitnessEvaluator({ bench: undefined as never, verify: () => verifySummary([]) }), /required functions/);
    assert.throws(
      () => createFitnessEvaluator({ bench: () => benchReport(0, 0), verify: () => verifySummary([]), weights: { verify: -1, bench: 0, speed: 0 } }),
      /weight verify/,
    );
    assert.throws(
      () => createFitnessEvaluator({ bench: () => benchReport(0, 0), verify: () => verifySummary([]), speedScaleTicks: 0 }),
      /speedScaleTicks/,
    );
  });

  it("defaults the weights to the published constant", () => {
    assert.deepEqual(DEFAULT_FITNESS_WEIGHTS, { verify: 0.5, bench: 0.3, speed: 0.2 });
  });
});

describe("compareFitness total order (H10.03)", () => {
  const evaluationOf = (id: string, opts: { verify?: readonly boolean[]; ok?: number; failed?: number; ticks?: number }) => {
    const bench = benchReport(opts.ok ?? 2, opts.failed ?? 0, opts.ticks ?? 10);
    const verify = verifySummary(opts.verify ?? [true]);
    return { genomeId: id, breakdown: foldFitness(bench, verify), benchReport: bench, verifySummary: verify };
  };

  it("ranks an eligible candidate above an ineligible one even at zero bench", () => {
    const eligible = evaluationOf("a", { verify: [true], ok: 0, failed: 3 });
    const blocked = evaluationOf("b", { verify: [false] });
    assert.ok(compareFitness(eligible, blocked) < 0);
  });

  it("ranks by score, then ok cases, then ticks, then genome id", () => {
    const high = evaluationOf("a", { ok: 4, ticks: 10 });
    const low = evaluationOf("b", { ok: 3, ticks: 10 });
    assert.ok(compareFitness(high, low) < 0);

    const sameScoreFaster = evaluationOf("a", { ok: 2, ticks: 5 });
    const sameScoreSlower = evaluationOf("b", { ok: 2, ticks: 50 });
    assert.ok(compareFitness(sameScoreFaster, sameScoreSlower) < 0);

    const left = evaluationOf("aaa", { ticks: 5 });
    const right = evaluationOf("bbb", { ticks: 5 });
    assert.ok(compareFitness(left, right) < 0);
    assert.ok(compareFitness(right, left) > 0);
    assert.equal(compareFitness(left, { ...left, genomeId: "aaa" }), 0);
  });
});

describe("formatFitness (H10.03)", () => {
  it("renders a stable single-line score card", () => {
    const evaluation = {
      genomeId: "cand_9",
      breakdown: foldFitness(benchReport(4, 0, 0), verifySummary([true])),
      benchReport: benchReport(4, 0),
      verifySummary: verifySummary([true]),
    };
    assert.equal(formatFitness(evaluation), "cand_9  eligible  score 1 (verify 1, bench 1, speed 1)");
  });
});
