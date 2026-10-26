/** H06.05: regression report generation — summaries, comparisons, JSON/MD output. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  compareBenchRuns,
  renderRegressionMarkdown,
  serializeRegressionReport,
  summarizeBenchRun,
  type BenchCaseResult,
  type BenchRunSummary,
} from "../src/bench/report.ts";

const caseResult = (caseId: string, overrides: Partial<BenchCaseResult> = {}): BenchCaseResult => ({
  caseId,
  ok: true,
  metrics: { latencyMs: 100, tokensIn: 1000, tokensOut: 500, cacheHits: 80, cacheMisses: 20 },
  ...overrides,
});

const run = (label: string, cases: readonly BenchCaseResult[], model = "deepseek-v4.1"): BenchRunSummary => ({
  label,
  model,
  createdAt: "2026-10-26T00:00:00.000Z",
  cases,
});

describe("summarizeBenchRun (H06.05)", () => {
  it("folds totals, cache hit rate and success rate over all cases", () => {
    const summary = summarizeBenchRun(
      run("base", [
        caseResult("a", { metrics: { latencyMs: 100, tokensIn: 1000, tokensOut: 500, cacheHits: 80, cacheMisses: 20 } }),
        caseResult("b", { ok: false, metrics: { latencyMs: 300, tokensIn: 500, tokensOut: 100, cacheHits: 0, cacheMisses: 100 } }),
      ]),
    );
    assert.equal(summary.label, "base");
    assert.equal(summary.totals.cases, 2);
    assert.equal(summary.totals.passed, 1);
    assert.equal(summary.totals.failed, 1);
    assert.equal(summary.totals.latencyMs, 400);
    assert.equal(summary.totals.tokensIn, 1500);
    assert.equal(summary.totals.tokensOut, 600);
    assert.equal(summary.totals.cacheHitRate, 80 / 200);
    assert.equal(summary.totals.successRate, 0.5);
  });

  it("computes per-case means over passed cases only", () => {
    const summary = summarizeBenchRun(
      run("base", [
        caseResult("a", { metrics: { latencyMs: 100, tokensIn: 1000, tokensOut: 500, cacheHits: 80, cacheMisses: 20 } }),
        caseResult("b", { metrics: { latencyMs: 300, tokensIn: 2000, tokensOut: 1500, cacheHits: 180, cacheMisses: 20 } }),
      ]),
    );
    assert.equal(summary.perCase.latencyMs, 200);
    assert.equal(summary.perCase.tokensIn, 1500);
    assert.equal(summary.perCase.cacheMisses, 20);
  });

  it("folds an empty run to zeroes without dividing by zero", () => {
    const summary = summarizeBenchRun(run("empty", []));
    assert.equal(summary.totals.cases, 0);
    assert.equal(summary.totals.cacheHitRate, 0);
    assert.equal(summary.totals.successRate, 0);
    assert.equal(summary.perCase.latencyMs, 0);
  });
});

describe("compareBenchRuns (H06.05)", () => {
  const baseline = run("baseline", [
    caseResult("a", { metrics: { latencyMs: 100, tokensIn: 1000, tokensOut: 500, cacheHits: 80, cacheMisses: 20 } }),
    caseResult("b", { metrics: { latencyMs: 100, tokensIn: 1000, tokensOut: 500, cacheHits: 80, cacheMisses: 20 } }),
  ]);

  it("marks a slower, token-heavier current run as regressed", () => {
    const current = run("current", [
      caseResult("a", { metrics: { latencyMs: 300, tokensIn: 2000, tokensOut: 500, cacheHits: 80, cacheMisses: 20 } }),
      caseResult("b", { metrics: { latencyMs: 300, tokensIn: 2000, tokensOut: 500, cacheHits: 80, cacheMisses: 20 } }),
    ]);
    const report = compareBenchRuns(baseline, current);
    const latency = report.metrics.find((item) => item.metric === "latencyMs");
    const tokensIn = report.metrics.find((item) => item.metric === "tokensIn");
    const tokensOut = report.metrics.find((item) => item.metric === "tokensOut");
    assert.equal(latency?.verdict, "regressed");
    assert.equal(latency?.deltaRatio, 2);
    assert.equal(tokensIn?.verdict, "regressed");
    assert.equal(tokensOut?.verdict, "unchanged");
    assert.equal(report.healthy, false);
  });

  it("marks a cache-hit improvement as improved and stays healthy", () => {
    const current = run("current", [
      caseResult("a", { metrics: { latencyMs: 100, tokensIn: 1000, tokensOut: 500, cacheHits: 95, cacheMisses: 5 } }),
      caseResult("b", { metrics: { latencyMs: 100, tokensIn: 1000, tokensOut: 500, cacheHits: 95, cacheMisses: 5 } }),
    ]);
    const report = compareBenchRuns(baseline, current);
    const hitRate = report.metrics.find((item) => item.metric === "cacheHitRate");
    assert.equal(hitRate?.verdict, "improved");
    assert.equal(report.healthy, true);
  });

  it("treats changes inside the threshold as unchanged and honors a custom threshold", () => {
    const nudged = run("current", [
      caseResult("a", { metrics: { latencyMs: 105, tokensIn: 1000, tokensOut: 500, cacheHits: 80, cacheMisses: 20 } }),
      caseResult("b", { metrics: { latencyMs: 105, tokensIn: 1000, tokensOut: 500, cacheHits: 80, cacheMisses: 20 } }),
    ]);
    assert.equal(compareBenchRuns(baseline, nudged).metrics.find((item) => item.metric === "latencyMs")?.verdict, "unchanged");
    const strict = compareBenchRuns(baseline, nudged, { regressionRatio: 0.01 });
    assert.equal(strict.metrics.find((item) => item.metric === "latencyMs")?.verdict, "regressed");
  });

  it("reports ok -> failed flips, added and removed cases, and unmarks health", () => {
    const current = run("current", [
      caseResult("a", { ok: false, error: "boom", metrics: { latencyMs: 100, tokensIn: 1000, tokensOut: 500, cacheHits: 80, cacheMisses: 20 } }),
      caseResult("c"),
    ]);
    const report = compareBenchRuns(baseline, current);
    assert.deepEqual(report.flippedToFailed, ["a"]);
    assert.deepEqual(report.addedCases, ["c"]);
    assert.deepEqual(report.removedCases, ["b"]);
    assert.equal(report.healthy, false);
  });

  it("treats a zero baseline with a non-zero current value as an infinite jump", () => {
    const cold = run("cold", [caseResult("a", { metrics: { latencyMs: 0, tokensIn: 0, tokensOut: 0, cacheHits: 0, cacheMisses: 100 } })]);
    const warm = run("warm", [caseResult("a", { metrics: { latencyMs: 50, tokensIn: 0, tokensOut: 0, cacheHits: 0, cacheMisses: 100 } })]);
    const latency = compareBenchRuns(cold, warm).metrics.find((item) => item.metric === "latencyMs");
    assert.equal(latency?.deltaRatio, Number.POSITIVE_INFINITY);
    assert.equal(latency?.verdict, "regressed");
  });
});

describe("report artifacts (H06.05)", () => {
  it("serializes byte-stable JSON that round-trips through parse", () => {
    const report = compareBenchRuns(
      run("baseline", [caseResult("a")]),
      run("current", [caseResult("a", { metrics: { latencyMs: 200, tokensIn: 1000, tokensOut: 500, cacheHits: 80, cacheMisses: 20 } })]),
    );
    const first = serializeRegressionReport(report);
    const second = serializeRegressionReport(compareBenchRuns(
      run("baseline", [caseResult("a")]),
      run("current", [caseResult("a", { metrics: { latencyMs: 200, tokensIn: 1000, tokensOut: 500, cacheHits: 80, cacheMisses: 20 } })]),
    ));
    assert.equal(first, second);
    const parsed = JSON.parse(first) as { healthy: boolean; metrics: { metric: string; verdict: string }[] };
    assert.equal(parsed.healthy, false);
    assert.equal(parsed.metrics.length, 5);
    assert.equal(parsed.metrics.find((item) => item.metric === "latencyMs")?.verdict, "regressed");
  });

  it("renders a Markdown document with the verdict, table and case drift", () => {
    const report = compareBenchRuns(
      run("baseline", [caseResult("a"), caseResult("b")]),
      run("current", [caseResult("a", { ok: false, error: "boom" }), caseResult("c")]),
    );
    const markdown = renderRegressionMarkdown(report);
    assert.match(markdown, /^# Bench regression report: baseline -> current$/m);
    assert.match(markdown, /Verdict: regressed/);
    assert.match(markdown, /\| metric \| direction \| baseline \| current \| delta \| verdict \|/);
    assert.match(markdown, /\| latencyMs \| lower-is-better \|/);
    assert.match(markdown, /Flipped to failed: a/);
    assert.match(markdown, /Added cases: c/);
    assert.match(markdown, /Removed cases: b/);
  });

  it("renders none markers for a clean report", () => {
    const report = compareBenchRuns(run("same", [caseResult("a")]), run("same2", [caseResult("a")]));
    const markdown = renderRegressionMarkdown(report);
    assert.match(markdown, /Verdict: healthy/);
    assert.match(markdown, /Flipped to failed: none/);
    assert.match(markdown, /Added cases: none/);
    assert.match(markdown, /Removed cases: none/);
  });
});
