/** H06.06: bench runner execution and the `xueness harness bench` CLI/RPC exit path. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHarnessApi, harnessCommand } from "../src/index.ts";
import { defaultBenchCases, runBenchSuite } from "../src/bench/suite.ts";
import { compareBenchRuns, type BenchRunSummary } from "../src/bench/report.ts";

describe("runBenchSuite (H06.06 foundation)", () => {
  it("ships at least three repeatable default fixtures that all pass", () => {
    const specs = defaultBenchCases();
    assert.ok(specs.length >= 3);
    const stepClock = (): number => (ticks += 7);
    let ticks = 0;
    const first = runBenchSuite({ nowMs: stepClock, now: () => "2026-10-26T00:00:00.000Z" });
    ticks = 0;
    const second = runBenchSuite({ nowMs: stepClock, now: () => "2026-10-26T00:00:00.000Z" });
    assert.deepEqual(first, second);
    assert.ok(first.cases.every((item) => item.ok));
    assert.equal(first.label, "deepseek_harness-bench");
    assert.equal(first.createdAt, "2026-10-26T00:00:00.000Z");
    assert.equal(first.cases[0]?.metrics.latencyMs, 7);
  });

  it("records the stable-append fixture as cache-friendly and churn as cache-cold", () => {
    const summary = runBenchSuite({ nowMs: () => 0, now: () => "2026-10-26T00:00:00.000Z" });
    const byId = new Map(summary.cases.map((item) => [item.caseId, item]));
    assert.ok((byId.get("prefix-stable-append")?.metrics.cacheHits ?? 0) > 0);
    assert.ok((byId.get("prefix-churn")?.metrics.cacheMisses ?? 0) > 0);
  });

  it("turns a throwing scenario into a failed case instead of aborting the suite", () => {
    const summary = runBenchSuite({
      cases: [
        { caseId: "boom", scenario: () => { throw new Error("scenario exploded"); } },
        { caseId: "fine", scenario: () => ({ ok: true, tokensIn: 1, tokensOut: 1, cacheHits: 0, cacheMisses: 1 }) },
      ],
      nowMs: () => 0,
      now: () => "2026-10-26T00:00:00.000Z",
    });
    assert.equal(summary.cases.length, 2);
    assert.equal(summary.cases[0]?.ok, false);
    assert.equal(summary.cases[0]?.error, "scenario exploded");
    assert.equal(summary.cases[1]?.ok, true);
  });
});

describe("harness bench CLI/RPC exit alignment (H06.06)", () => {
  const options = { now: () => "2026-10-26T00:00:00.000Z" };

  it("runs the bench suite over RPC and returns a parseable summary row", async () => {
    const api = createHarnessApi(options);
    assert.equal(api.owns("deepseek_harness/bench"), true);
    const result = (await api.dispatch("deepseek_harness/bench", {})) as {
      ok: boolean; compared: boolean; healthy: boolean;
      summary: BenchRunSummary; report: unknown;
    };
    assert.equal(result.ok, true);
    assert.equal(result.compared, false);
    assert.equal(result.healthy, true);
    assert.ok(result.summary.cases.length >= 3);
    assert.equal(result.report, null);
  });

  it("compares against a submitted baseline and reports regressions", async () => {
    const api = createHarnessApi(options);
    // A hand-built zero-token baseline: token deltas jump to infinity against any real run.
    const baseline = {
      ...runBenchSuite({ nowMs: () => 0, now: () => "2026-10-26T00:00:00.000Z" }),
      label: "cold-baseline",
      cases: runBenchSuite({ nowMs: () => 0, now: () => "2026-10-26T00:00:00.000Z" }).cases
        .map((item) => ({ ...item, metrics: { latencyMs: 0, tokensIn: 0, tokensOut: 0, cacheHits: 0, cacheMisses: item.metrics.cacheMisses } })),
    };
    const result = (await api.dispatch("deepseek_harness/bench", { baseline })) as {
      ok: boolean; compared: boolean; healthy: boolean;
      report: { metrics: { metric: string; verdict: string }[] } | null;
    };
    assert.equal(result.compared, true);
    assert.equal(result.healthy, false);
    assert.equal(result.report?.metrics.find((item) => item.metric === "tokensIn")?.verdict, "regressed");
  });

  it("rejects a malformed baseline with invalid_input", async () => {
    const api = createHarnessApi(options);
    const result = (await api.dispatch("deepseek_harness/bench", { baseline: { label: "x" } })) as { ok: boolean; error: { code: string } };
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "invalid_input");
  });

  it("exits 0 on a healthy run with parseable output", async () => {
    const run = await harnessCommand(["bench"], options);
    assert.equal(run.code, 0);
    const parsed = JSON.parse(run.output) as { ok: boolean; healthy: boolean; summary: { cases: unknown[] } };
    assert.equal(parsed.ok, true);
    assert.equal(parsed.healthy, true);
    assert.ok(parsed.summary.cases.length >= 3);
  });

  it("exits 1 when the baseline comparison detects a regression", async () => {
    const cold = runBenchSuite({ nowMs: () => 0, now: () => "2026-10-26T00:00:00.000Z" });
    const baseline = {
      ...cold,
      label: "cold-baseline",
      cases: cold.cases.map((item) => ({ ...item, metrics: { latencyMs: 0, tokensIn: 0, tokensOut: 0, cacheHits: 0, cacheMisses: item.metrics.cacheMisses } })),
    };
    const run = await harnessCommand(["bench", JSON.stringify(baseline)], options);
    assert.equal(run.code, 1);
    const parsed = JSON.parse(run.output) as { healthy: boolean; report: { healthy: boolean } | null };
    assert.equal(parsed.healthy, false);
    assert.equal(parsed.report?.healthy, false);
  });

  it("exits 0 when the current run matches a hand-built equal baseline", async () => {
    const current = runBenchSuite({ nowMs: () => 0, now: () => "2026-10-26T00:00:00.000Z" });
    const baseline: BenchRunSummary = {
      ...current,
      label: "hand-baseline",
      cases: current.cases.map((item) => ({ ...item })),
    };
    const report = compareBenchRuns(baseline, { ...current, label: "current" });
    assert.equal(report.healthy, true);
  });

  it("exits 2 for unparseable or malformed baseline usage", async () => {
    const broken = await harnessCommand(["bench", "{not json"], options);
    assert.equal(broken.code, 2);
    const shaped = await harnessCommand(["bench", JSON.stringify({ nope: true })], options);
    assert.equal(shaped.code, 2);
    assert.match(shaped.output, /invalid_input/);
  });

  it("keeps load/list/verify exits unchanged and unknown actions at 2", async () => {
    assert.equal((await harnessCommand(["list"], options)).code, 0);
    assert.equal((await harnessCommand(["load"], options)).code, 2);
    assert.equal((await harnessCommand(["nope"], options)).code, 2);
  });
});
