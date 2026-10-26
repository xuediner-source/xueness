import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createBenchProfiler, type ProfiledCall, type ProfileSummary, type UsageReport } from "../../../plugins/deepseek_harness/src/bench/profiler.ts";
import { commonPrefixLength, stablePrefix, type StableRequest } from "../../../plugins/deepseek_harness/src/prefix-cache.ts";
import {
  buildStatusStrip,
  formatRate,
  formatTokens,
  renderStatusLine,
  stripState,
  type StatusStripRow,
} from "../src/renderer/harness-status-strip.ts";

/** Deterministic prompt blocks; lengths feed the expected prefix-cache math. */
const PROMPT_A = "x".repeat(4000);
const PROMPT_TAIL = "y";

const requestA: StableRequest = { messages: [{ role: "user", content: PROMPT_A }] };
// Pure append of one turn: request A's prefix survives byte-for-byte (H01.03 warm).
const requestB: StableRequest = { messages: [{ role: "user", content: PROMPT_A }, { role: "user", content: PROMPT_TAIL }] };
const requestC: StableRequest = { messages: [{ role: "user", content: "z".repeat(3000) }] };

function call(model: string, session: string, request: StableRequest, label: string, usage?: UsageReport): ProfiledCall {
  return { label, model, session, request, usage };
}

// Oracle: serialized prefix lengths and the shared prefix of A -> B.
const lenA = stablePrefix(requestA).length;
const lenB = stablePrefix(requestB).length;
const lenC = stablePrefix(requestC).length;
const hitB = commonPrefixLength(stablePrefix(requestA), stablePrefix(requestB));
const round6 = (value: number): number => Math.round(value * 1e6) / 1e6;

/** DeepSeek-shaped run: a solver session (cold, then warm append) and a cold critic session. */
function deepseekSummary(): ProfileSummary {
  const profiler = createBenchProfiler();
  profiler.record(call("deepseek-chat", "s1", requestA, "draft", { promptTokens: 1000, completionTokens: 120 }));
  profiler.record(call("deepseek-chat", "s1", requestB, "refine", { promptTokens: 2000, completionTokens: 80, cachedTokens: 1000 }));
  profiler.record(call("deepseek-reasoner", "c1", requestC, "review", { promptTokens: 1000, completionTokens: 200 }));
  return profiler.summary();
}

describe("H12.05 harness status strip", () => {
  it("shows one row per model plus the overall row, sorted by model", () => {
    const strip = buildStatusStrip(deepseekSummary(), { quota: { totalTokens: 10_000 } });
    assert.deepEqual(strip.rows.map((row) => row.model), ["deepseek-chat", "deepseek-reasoner", "*"]);
    assert.equal(strip.overall.model, "*");
    assert.ok(strip.byModel("deepseek-chat"));
    assert.equal(strip.byModel("deepseek-absent"), null);
  });

  it("shows token totals per model and overall (model leg of the acceptance)", () => {
    const strip = buildStatusStrip(deepseekSummary(), { quota: { totalTokens: 10_000 } });
    const solver = strip.byModel("deepseek-chat");
    assert.ok(solver);
    assert.equal(solver!.promptTokens, 3000);
    assert.equal(solver!.completionTokens, 200);
    assert.equal(solver!.totalTokens, 3200);
    assert.equal(solver!.calls, 2);
    assert.equal(solver!.medianLatencyMs, 0); // tick clock: deterministic, 0 ms deltas
    assert.equal(strip.overall.totalTokens, 4400);
    assert.equal(strip.overall.calls, 3);
    assert.ok(solver!.text.startsWith("deepseek-chat "));
  });

  it("shows quota usage: share of budget, remaining tokens, used fraction (quota leg)", () => {
    const strip = buildStatusStrip(deepseekSummary(), { quota: { totalTokens: 4000 } });
    const overall = strip.overall;
    assert.ok(overall.quota);
    assert.equal(overall.quota!.budgetTokens, 4000);
    assert.equal(overall.quota!.usedTokens, 4400);
    assert.equal(overall.quota!.remainingTokens, 0);
    assert.ok(overall.quota!.usedFraction >= 1);
    assert.equal(overall.state, "exhausted");
    // Per-model rows carry the same budget as their share: the solver alone sits exactly at the warn line (80%).
    const solver = strip.byModel("deepseek-chat");
    assert.ok(solver?.quota);
    assert.equal(solver!.quota!.usedFraction, 0.8);
    assert.equal(solver!.state, "warn");
    assert.ok(solver!.text.includes("80.0% of 4.00k"));
    assert.ok(solver!.text.includes("800 left"));
  });

  it("shows the H06 prefix-cache hit rate and the provider-reported ratio (cache leg)", () => {
    const strip = buildStatusStrip(deepseekSummary(), { quota: { totalTokens: 10_000 } });
    const solver = strip.byModel("deepseek-chat");
    assert.ok(solver);
    // A's whole prefix survived B's append, so the aggregate hit rate is lenA / (lenA + lenB).
    assert.equal(hitB, lenA); // the oracle scenario really is a warm append
    const expectedSolverRate = round6(lenA / (lenA + lenB));
    assert.equal(solver!.cacheHitRate, expectedSolverRate);
    assert.ok(solver!.text.includes(`cache ${formatRate(expectedSolverRate)}`));
    // Provider ratio is reported cache over reported prompt tokens: 1000/3000.
    assert.equal(solver!.providerCacheHitRate, 0.333333);
    assert.ok(solver!.text.includes("provider 33.3%"));
    // Overall row aggregates the same chars across both models.
    assert.equal(strip.overall.cacheHitRate, round6(lenA / (lenA + lenB + lenC)));
    // The critic session never reused a prefix and reported no provider cache.
    const critic = strip.byModel("deepseek-reasoner");
    assert.ok(critic);
    assert.equal(critic!.cacheHitRate, 0);
    assert.equal(critic!.providerCacheHitRate, null);
    assert.ok(!critic!.text.includes("provider"));
  });

  it("tracks warm/partial/cold call counts from the profiler conditions", () => {
    const strip = buildStatusStrip(deepseekSummary(), {});
    const solver = strip.byModel("deepseek-chat");
    assert.ok(solver);
    assert.equal(solver!.coldCalls, 1);
    assert.equal(solver!.warmCalls, 1);
    assert.equal(solver!.partialCalls, 0);
    assert.ok(solver!.text.includes("w1/p0/c1"));
    assert.equal(strip.overall.coldCalls, 2);
  });

  it("an empty summary renders a single idle overall row", () => {
    const profiler = createBenchProfiler();
    const strip = buildStatusStrip(profiler.summary(), { quota: { totalTokens: 1000 } });
    assert.equal(strip.rows.length, 1);
    assert.equal(strip.overall.state, "idle");
    assert.equal(strip.overall.calls, 0);
    assert.equal(strip.overall.quota?.usedFraction, 0);
    assert.equal(strip.overall.quota?.remainingTokens, 1000);
    assert.equal(strip.overall.text, "harness idle");
    assert.equal(strip.render(), "[harness] harness idle");
  });

  it("without a quota rows show plain totals and never leave ok", () => {
    const strip = buildStatusStrip(deepseekSummary(), {});
    for (const row of strip.rows) {
      assert.equal(row.quota, null);
      assert.equal(row.state, "ok");
      assert.ok(!row.text.includes(" of "));
    }
  });

  it("state thresholds: ok -> warn -> critical -> exhausted as usage grows", () => {
    const summary = deepseekSummary();
    assert.equal(stripState(0, null), "idle");
    assert.equal(stripState(10, 0.79), "ok");
    assert.equal(stripState(10, 0.8), "warn");
    assert.equal(stripState(10, 0.949), "warn");
    assert.equal(stripState(10, 0.95), "critical");
    assert.equal(stripState(10, 1), "exhausted");
    assert.equal(stripState(10, 1.5), "exhausted");
    // Same walk via full strips with tuned budgets (4400 total tokens).
    for (const [budget, expected] of [[100_000, "ok"], [5000, "warn"], [4500, "critical"], [4400, "exhausted"]] as const) {
      assert.equal(buildStatusStrip(summary, { quota: { totalTokens: budget } }).overall.state, expected, `budget ${budget}`);
    }
  });

  it("custom thresholds and title are honored", () => {
    const summary = deepseekSummary();
    // 4400/8800 = 0.5 lands between custom warn 0.4 and critical 0.6; 4400/7000 crosses critical.
    assert.equal(buildStatusStrip(summary, { quota: { totalTokens: 8800 }, warnAt: 0.4, criticalAt: 0.6 }).overall.state, "warn");
    const strip = buildStatusStrip(summary, { quota: { totalTokens: 7000 }, warnAt: 0.4, criticalAt: 0.6, title: "bench" });
    assert.equal(strip.overall.state, "critical");
    assert.ok(strip.render().startsWith("[bench]"));
    assert.equal(strip.overall.label, "bench");
  });

  it("non-positive quotas are rejected instead of rendering a broken strip", () => {
    assert.throws(() => buildStatusStrip(deepseekSummary(), { quota: { totalTokens: 0 } }), /positive token budget/);
    assert.throws(() => buildStatusStrip(deepseekSummary(), { quota: { totalTokens: -5 } }), /positive token budget/);
  });

  it("formatting helpers are deterministic and bounded", () => {
    assert.equal(formatTokens(0), "0");
    assert.equal(formatTokens(950), "950");
    assert.equal(formatTokens(3200), "3.20k");
    assert.equal(formatTokens(44_000), "44.0k");
    assert.equal(formatTokens(4_400_000), "4.40M");
    assert.equal(formatRate(0), "0.0%");
    assert.equal(formatRate(0.5), "50.0%");
    assert.equal(formatRate(0.875), "87.5%");
    assert.equal(formatRate(1.2), "100.0%"); // clamped at 100%
    assert.equal(formatRate(Number.NaN), "0.0%");
  });

  it("rows are frozen snapshots and render() is byte-stable across rebuilds", () => {
    const options = { quota: { totalTokens: 10_000 } };
    const first = buildStatusStrip(deepseekSummary(), options);
    const second = buildStatusStrip(deepseekSummary(), options);
    assert.equal(first.render(), second.render());
    assert.ok(Object.isFrozen(first.rows));
    for (const row of first.rows) assert.ok(Object.isFrozen(row));
    const solverRate = round6(lenA / (lenA + lenB));
    const overallRate = round6(lenA / (lenA + lenB + lenC));
    const expected =
      `[harness] deepseek-chat 3.20k tok (32.0% of 10.0k, 6.80k left) cache ${formatRate(solverRate)} provider 33.3% 2 calls w1/p0/c1 ok` +
      ` | deepseek-reasoner 1.20k tok (12.0% of 10.0k, 8.80k left) cache 0.0% 1 calls w0/p0/c1 ok` +
      ` | harness 4.40k tok (44.0% of 10.0k, 5.60k left) cache ${formatRate(overallRate)} provider 25.0% 3 calls w1/p0/c2 ok`;
    assert.equal(first.render(), expected);
    // And a third rebuild from a fresh profiler stays byte-identical (offline determinism).
    assert.equal(buildStatusStrip(deepseekSummary(), options).render(), expected);
  });

  it("renderStatusLine spells an idle row without token or cache legs", () => {
    const idle: StatusStripRow = {
      model: "*",
      label: "harness",
      calls: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cachedTokens: 0,
      cacheHitRate: 0,
      providerCacheHitRate: null,
      warmCalls: 0,
      coldCalls: 0,
      partialCalls: 0,
      medianLatencyMs: 0,
      quota: null,
      state: "idle",
      text: "",
    };
    assert.equal(renderStatusLine(idle), "harness idle");
  });
});
