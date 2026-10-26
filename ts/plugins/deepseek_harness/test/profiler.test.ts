/** H06.03: token / cache / latency profiler — raw values plus measurement conditions. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createBenchProfiler, type ProfiledCall } from "../src/bench/profiler.ts";
import { stablePrefix, type StableRequest } from "../src/prefix-cache.ts";

const turn = (role: string, content: string) => ({ role, content });

const request = (messages: readonly { role: string; content: string }[]): StableRequest => ({
  system: "You are a bench harness.",
  messages,
});

/** Manual clock: tests push exact millisecond readings. */
const scriptedClock = (ticks: readonly number[]) => {
  let index = 0;
  return () => {
    const value = ticks[Math.min(index, ticks.length - 1)] ?? 0;
    index += 1;
    return value;
  };
};

const baseCall = (over: Partial<ProfiledCall> = {}): ProfiledCall => ({
  label: "case",
  model: "deepseek-v4.1",
  session: "s1",
  request: request([turn("user", "hello")]),
  latencyMs: 100,
  ...over,
});

describe("createBenchProfiler.record", () => {
  it("emits raw token values from a reported usage block", () => {
    const profiler = createBenchProfiler();
    const sample = profiler.record(baseCall({ usage: { promptTokens: 210, completionTokens: 90, cachedTokens: 140 } }));
    assert.equal(sample.promptTokens, 210);
    assert.equal(sample.completionTokens, 90);
    assert.equal(sample.totalTokens, 300);
    assert.equal(sample.cachedTokens, 140);
    assert.ok(Math.abs(sample.providerCacheHitRate - 140 / 210) < 1e-6, `providerCacheHitRate ${sample.providerCacheHitRate}`);
    assert.equal(sample.conditions.tokenSource, "reported");
    assert.equal(sample.conditions.providerCacheReported, true);
  });

  it("estimates tokens deterministically from prefix length when usage is absent", () => {
    const profiler = createBenchProfiler({ charsPerToken: 4 });
    const sample = profiler.record(baseCall());
    const expected = Math.ceil(stablePrefix(baseCall().request).length / 4);
    assert.equal(sample.promptTokens, expected);
    assert.equal(sample.completionTokens, 0);
    assert.equal(sample.conditions.tokenSource, "estimated");
    assert.equal(sample.conditions.providerCacheReported, false);
  });

  it("marks a session's first call cold with zero hit, and an appended turn warm", () => {
    const profiler = createBenchProfiler();
    const first = profiler.record(baseCall({ request: request([turn("user", "solve case A")]) }));
    assert.equal(first.conditions.firstCall, true);
    assert.equal(first.conditions.cacheState, "cold");
    assert.equal(first.cacheHitChars, 0);
    assert.equal(first.cacheHitRate, 0);

    const second = profiler.record(
      baseCall({ request: request([turn("user", "solve case A"), turn("assistant", "ok"), turn("user", "next")]) }),
    );
    assert.equal(second.conditions.firstCall, false);
    assert.equal(second.conditions.cacheState, "warm");
    assert.equal(second.cacheHitChars, first.cacheTotalChars);
    assert.ok(second.cacheHitRate > 0 && second.cacheHitRate < 1, "append reuses the old prefix but adds new bytes");
  });

  it("classifies a rewritten history as partial with the exact shared byte count", () => {
    const profiler = createBenchProfiler();
    profiler.record(baseCall({ request: request([turn("user", "alpha beta gamma"), turn("user", "tail")]) }));
    const sample = profiler.record(
      baseCall({ request: request([turn("user", "alpha beta gamma"), turn("user", "other tail")]) }),
    );
    assert.equal(sample.conditions.cacheState, "partial");
    assert.ok(sample.cacheHitChars > 0);
    assert.ok(sample.cacheHitRate > 0 && sample.cacheHitRate < 1);
  });

  it("keeps sessions independent and tags samples with sequence numbers", () => {
    const profiler = createBenchProfiler();
    profiler.record(baseCall({ session: "a", label: "one" }));
    const other = profiler.record(baseCall({ session: "b", label: "one" }));
    const again = profiler.record(baseCall({ session: "a", label: "two", request: request([turn("user", "hello"), turn("user", "more")]) }));
    assert.equal(other.conditions.firstCall, true);
    assert.equal(other.sequence, 1);
    assert.equal(again.sequence, 2);
    assert.equal(again.conditions.cacheState, "warm");
  });

  it("defaults the session id to a model:label composite", () => {
    const profiler = createBenchProfiler();
    const sample = profiler.record({ label: "lint", model: "deepseek-r1", request: request([turn("user", "x")]), latencyMs: 5 });
    assert.equal(sample.session, "deepseek-r1:lint");
  });
});

describe("createBenchProfiler.measure", () => {
  it("clocks latency via the injected now() delta, in raw ms", async () => {
    const clock = scriptedClock([1000, 1042]);
    const profiler = createBenchProfiler({ now: clock });
    const sample = await profiler.measure(baseCall({ latencyMs: undefined }), async () => "done");
    assert.equal(sample.latencyMs, 42);
  });

  it("never reports a negative latency when the clock is coarse", async () => {
    const profiler = createBenchProfiler({ now: scriptedClock([7, 7]) });
    const sample = await profiler.measure(baseCall({ latencyMs: undefined }), async () => {});
    assert.equal(sample.latencyMs, 0);
  });

  it("uses the deterministic tick clock when none is injected", async () => {
    const profiler = createBenchProfiler();
    const sample = await profiler.measure(baseCall({ latencyMs: undefined }), async () => {});
    assert.equal(sample.latencyMs, 1);
  });
});

describe("createBenchProfiler.summary", () => {
  it("aggregates tokens, cache states and latency per model and overall", () => {
    const profiler = createBenchProfiler();
    profiler.record(baseCall({ usage: { promptTokens: 100, completionTokens: 50 }, latencyMs: 100 }));
    profiler.record(
      baseCall({
        label: "followup",
        request: request([turn("user", "hello"), turn("user", "again")]),
        usage: { promptTokens: 120, completionTokens: 30, cachedTokens: 100 },
        latencyMs: 40,
      }),
    );
    profiler.record(baseCall({ model: "deepseek-r1", session: "r1", usage: { promptTokens: 200, completionTokens: 80 }, latencyMs: 200 }));

    const { models, overall } = profiler.summary();
    assert.deepEqual(models.map((row) => row.model), ["deepseek-r1", "deepseek-v4.1"]);
    const v41 = models[1] as (typeof models)[number];
    assert.equal(v41.calls, 2);
    assert.equal(v41.promptTokens, 220);
    assert.equal(v41.completionTokens, 80);
    assert.equal(v41.totalTokens, 300);
    assert.equal(v41.cachedTokens, 100);
    assert.equal(v41.coldCalls, 1);
    assert.equal(v41.warmCalls, 1);
    assert.equal(v41.latency.minMs, 40);
    assert.equal(v41.latency.maxMs, 100);
    assert.equal(v41.latency.medianMs, 40);
    assert.equal(v41.latency.meanMs, 70);
    assert.ok(v41.cacheHitRate > 0 && v41.cacheHitRate <= 1);

    assert.equal(overall.calls, 3);
    assert.equal(overall.totalTokens, 580);
    assert.equal(overall.latency.p95Ms, 200);
    assert.equal(overall.latency.count, 3);
  });

  it("is deterministic: identical sequence and clock produce identical summaries", () => {
    const run = () => {
      const profiler = createBenchProfiler({ now: scriptedClock([10, 35, 36, 80]) });
      profiler.record(baseCall({ latencyMs: 12, usage: { promptTokens: 50 } }));
      profiler.record(baseCall({ label: "warm", request: request([turn("user", "hello"), turn("user", "x")]), latencyMs: 8 }));
      profiler.record(baseCall({ model: "deepseek-r1", session: "r1", latencyMs: 44, usage: { promptTokens: 60, completionTokens: 5 } }));
      return profiler.summary();
    };
    assert.deepEqual(run(), run());
  });

  it("computes p95 from the sorted distribution, not the recording order", () => {
    const profiler = createBenchProfiler();
    const latencies = [500, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160, 170, 180, 190, 200, 210, 900];
    latencies.forEach((latencyMs, index) => {
      profiler.record(baseCall({ session: `s${index}`, label: `c${index}`, latencyMs }));
    });
    const { overall } = profiler.summary();
    assert.equal(overall.latency.p95Ms, 500);
    assert.equal(overall.latency.maxMs, 900);
    assert.equal(overall.latency.minMs, 10);
  });
});

describe("createBenchProfiler state management", () => {
  it("exposes samples in recording order and resets cleanly", () => {
    const profiler = createBenchProfiler();
    profiler.record(baseCall({ label: "a", latencyMs: 1 }));
    profiler.record(baseCall({ label: "b", latencyMs: 2 }));
    assert.deepEqual(profiler.samples().map((sample) => sample.label), ["a", "b"]);
    profiler.reset();
    assert.equal(profiler.samples().length, 0);
    assert.equal(profiler.summary().overall.calls, 0);
    assert.equal(profiler.summary().overall.latency.count, 0);
  });

  it("treats a post-reset call as a fresh first call", () => {
    const profiler = createBenchProfiler();
    profiler.record(baseCall());
    profiler.reset();
    const sample = profiler.record(baseCall());
    assert.equal(sample.conditions.firstCall, true);
    assert.equal(sample.conditions.cacheState, "cold");
  });
});
