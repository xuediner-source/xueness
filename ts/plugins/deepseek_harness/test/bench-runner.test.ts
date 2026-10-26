/** H06.01/H06.02: bench runner skeleton and reproducible harness fixtures. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseHarnessPackage } from "../src/contracts.ts";
import {
  formatBenchReport,
  runBenchCase,
  runBenchCases,
  type BenchCase,
  type BenchCaseResult,
} from "../src/bench/runner.ts";
import {
  BENCH_FIXTURES,
  buildBenchFixtures,
  stableRequestFor,
  sweBenchDocument,
  sweBenchTaskLine,
  syntheticFileScopes,
  syntheticHarnessPackage,
} from "../src/bench/cases.ts";

/** Deterministic clock: every reading advances the counter by `step` ticks. */
const steppingClock = (step: number): (() => number) => {
  let ticks = 0;
  return () => {
    ticks += step;
    return ticks;
  };
};

describe("runBenchCase (H06.01)", () => {
  it("measures each iteration through the injected clock", () => {
    const result = runBenchCase({ id: "case_one", description: "", iterations: 3, run: () => 41 }, steppingClock(2));
    assert.equal(result.ok, true);
    assert.equal(result.error, null);
    assert.deepEqual(result.timings, { totalTicks: 6, minTicks: 2, maxTicks: 2, meanTicks: 2 });
    assert.equal(result.iterations, 3);
  });

  it("records a canonical digest of the last return value", () => {
    const result = runBenchCase({ id: "case_two", description: "", iterations: 1, run: () => ({ b: 2, a: 1 }) });
    assert.equal(result.valueDigest, '{"a":1,"b":2}');
  });

  it("converts a throwing workload into a failed result with the message", () => {
    const result = runBenchCase({
      id: "case_three",
      description: "",
      iterations: 2,
      run: () => {
        throw new Error("workload exploded");
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.timings, null);
    assert.equal(result.valueDigest, null);
    assert.match(result.error ?? "", /workload exploded/);
  });

  it("charges zero ticks under the default clock", () => {
    const result = runBenchCase({ id: "case_four", description: "", iterations: 2, run: () => 7 });
    assert.ok(result.ok);
    assert.deepEqual(result.timings, { totalTicks: 0, minTicks: 0, maxTicks: 0, meanTicks: 0 });
  });
});

describe("runBenchCases (H06.01)", () => {
  const cases: BenchCase[] = [
    { id: "alpha", description: "", iterations: 2, run: () => "a" },
    { id: "beta", description: "", iterations: 4, run: () => "b" },
    { id: "gamma", description: "", iterations: 1, run: () => "g" },
  ];

  it("runs a whole set of harness bench cases in order and summarizes", () => {
    const { results, summary } = runBenchCases(cases, { clock: steppingClock(3) });
    assert.deepEqual(results.map((result) => result.id), ["alpha", "beta", "gamma"]);
    assert.ok(results.every((result) => result.ok));
    assert.deepEqual(summary, { total: 3, ok: 3, failed: 0, totalTicks: 21, ranking: ["alpha", "beta", "gamma"] });
  });

  it("ranks by mean ticks per iteration, fastest first, ties broken by id", () => {
    let work = 0;
    const workClock = (): number => work;
    const mixed: BenchCase[] = [
      { id: "slow", description: "", iterations: 2, run: () => { work += 10; } },
      { id: "bb_tie", description: "", iterations: 2, run: () => { work += 5; } },
      { id: "aa_tie", description: "", iterations: 4, run: () => { work += 5; } },
      { id: "quick", description: "", iterations: 2, run: () => { work += 2; } },
    ];
    const { summary } = runBenchCases(mixed, { clock: workClock });
    assert.deepEqual(summary.ranking, ["quick", "aa_tie", "bb_tie", "slow"]);
  });

  it("isolates invalid and failing cases without aborting the rest", () => {
    const problematic: BenchCase[] = [
      { id: "Bad-Id", description: "", iterations: 1, run: () => 1 },
      { id: "alpha", description: "", iterations: 1, run: () => 1 },
      { id: "alpha", description: "", iterations: 1, run: () => 1 },
      { id: "zero_iter", description: "", iterations: 0, run: () => 1 },
      { id: "throws", description: "", iterations: 2, run: () => { throw new Error("boom"); } },
      { id: "healthy", description: "", iterations: 1, run: () => "fine" },
    ];
    const { results, summary } = runBenchCases(problematic);
    assert.equal(summary.total, 6);
    assert.equal(summary.ok, 2);
    assert.equal(summary.failed, 4);
    assert.deepEqual(summary.ranking, ["alpha", "healthy"]);
    const byId = new Map(results.map((result) => [result.id, result] as const));
    assert.match(byId.get("Bad-Id")?.error ?? "", /case id/);
    assert.match((results[2] as BenchCaseResult).error ?? "", /duplicate case id alpha/);
    assert.match(byId.get("zero_iter")?.error ?? "", /positive integer/);
    assert.match(byId.get("throws")?.error ?? "", /boom/);
    assert.equal(byId.get("healthy")?.ok, true);
  });

  it("is deterministic: equal cases and clock replay produce identical reports", () => {
    const first = runBenchCases(cases, { clock: steppingClock(5) });
    const second = runBenchCases(cases, { clock: steppingClock(5) });
    assert.deepEqual(first, second);
  });

  it("formats a stable report and handles the empty set", () => {
    const text = formatBenchReport(runBenchCases(cases, { clock: steppingClock(1) }));
    assert.match(text, /alpha  ok  /);
    assert.match(text, /summary: 3\/3 ok, 0 failed, 7 ticks total/);
    assert.match(text, /ranking \(fastest first\): alpha, beta, gamma/);
    const empty = runBenchCases([]);
    assert.deepEqual(empty.summary, { total: 0, ok: 0, failed: 0, totalTicks: 0, ranking: [] });
    assert.match(formatBenchReport(empty), /ranking \(fastest first\): -/);
  });
});

describe("bench fixtures (H06.02)", () => {
  it("exposes at least three unique, buildable fixtures", () => {
    assert.ok(BENCH_FIXTURES.length >= 3);
    const ids = BENCH_FIXTURES.map((fixture) => fixture.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const fixture of BENCH_FIXTURES) {
      assert.ok(fixture.description.length > 0);
      const benchCase = fixture.build({ iterations: 1 });
      assert.equal(benchCase.id, fixture.id);
      assert.ok(benchCase.iterations >= 1);
      assert.equal(typeof benchCase.run, "function");
    }
  });

  it("synthesizes deterministic SWE-bench documents", () => {
    assert.equal(sweBenchTaskLine(3), sweBenchTaskLine(3));
    assert.notEqual(sweBenchTaskLine(3), sweBenchTaskLine(4));
    const document = sweBenchDocument(10);
    assert.ok(document.endsWith("\n"));
    assert.equal(document.split("\n").filter((line) => line.length > 0).length, 10);
    const parsed = JSON.parse(sweBenchTaskLine(5)) as Record<string, unknown>;
    assert.equal(parsed.instance_id, "org5__repo-5");
    assert.deepEqual(parsed.FAIL_TO_PASS, ["test_mod5_fix_5"]);
  });

  it("synthesizes harness packages that pass contract validation", () => {
    for (const count of [0, 1, 7, 50]) {
      const parsed = parseHarnessPackage(syntheticHarnessPackage(count));
      assert.ok(parsed.ok, `count ${count}`);
      assert.equal(parsed.package.contributions.length, count);
    }
    const kinds = (syntheticHarnessPackage(10).contributions as { kind: string }[]).map((item) => item.kind);
    for (const kind of ["tool", "hook", "verifier", "skill", "promptTemplate"]) assert.ok(kinds.includes(kind));
  });

  it("builds stable requests and unique weighted scopes deterministically", () => {
    assert.deepEqual(stableRequestFor(1, 2), stableRequestFor(1, 2));
    assert.notDeepEqual(stableRequestFor(1, 2), stableRequestFor(2, 1));
    assert.equal(syntheticFileScopes(50).length, 50);
    assert.equal(new Set(syntheticFileScopes(200).map((file) => file.path)).size, 200);
    assert.ok(syntheticFileScopes(200).every((file) => (file.weight ?? 0) > 0));
  });

  it("fixture workloads return reproducible values across rebuilds", () => {
    const sizes = { sweBenchLines: 25, contractContributions: 25, prefixRequests: 5, prefixSessions: 3, shardFiles: 40, iterations: 2 };
    const first = buildBenchFixtures(sizes);
    const second = buildBenchFixtures(sizes);
    assert.deepEqual(first.map((benchCase) => benchCase.id), second.map((benchCase) => benchCase.id));
    for (let index = 0; index < first.length; index += 1) {
      assert.deepEqual(first[index]?.run(), second[index]?.run());
    }
  });

  it("runs the full fixture set through the runner with every case ok", () => {
    const { results, summary } = runBenchCases(
      buildBenchFixtures({ sweBenchLines: 30, contractContributions: 30, prefixRequests: 6, prefixSessions: 3, shardFiles: 60, iterations: 2 }),
      { clock: steppingClock(1) },
    );
    assert.equal(summary.failed, 0);
    assert.equal(summary.ok, results.length);
    const sweBench = results.find((result) => result.id === "swe_bench_import") as BenchCaseResult;
    assert.deepEqual(JSON.parse(sweBench.valueDigest ?? "{}"), { tasks: 30, issues: 0, first: "org0__repo-0", last: "org1__repo-29" });
    const contracts = results.find((result) => result.id === "contracts_parse") as BenchCaseResult;
    assert.deepEqual(JSON.parse(contracts.valueDigest ?? "{}"), { ok: true, contributions: 30 });
    const shardPlan = results.find((result) => result.id === "shard_plan") as BenchCaseResult;
    assert.deepEqual(JSON.parse(shardPlan.valueDigest ?? "{}"), { shards: 8, files: 60, disjoint: true });
  });
});
