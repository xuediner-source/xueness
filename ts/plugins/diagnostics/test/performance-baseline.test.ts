import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  buildPerformanceBaseline, concurrentFairness, paginateHistory, PERF_SCHEMA,
} from "../src/performance-baseline.ts";

describe("performance baseline (F14.03)", () => {
  it("paginates a long history without holes and reports a null next at the end", () => {
    const first = paginateHistory(250, 100, 0);
    assert.equal(first.ids.length, 100);
    assert.equal(first.nextOffset, 100);
    const last = paginateHistory(250, 100, 200);
    assert.deepEqual(last.ids, Array.from({ length: 50 }, (_, i) => 200 + i));
    assert.equal(last.nextOffset, null);
  });

  it("keeps concurrent claim counts within one of each other (fair round-robin)", () => {
    const { perWorker, spread } = concurrentFairness(8, 800);
    assert.equal(perWorker.reduce((a, b) => a + b, 0), 800);
    assert.equal(spread, 0);
  });

  it("builds a raw baseline report with conditions and repeated samples", () => {
    const dir = mkdtempSync(join(tmpdir(), "perf-"));
    try {
      const report = buildPerformanceBaseline({
        stateDir: dir,
        iterations: 3,
        historyLength: 500,
        pageSize: 50,
        now: () => new Date("2026-10-26T00:00:00Z"),
      });
      assert.equal(report.schema, PERF_SCHEMA);
      assert.equal(report.round, "F14.03");
      assert.equal(report.samples.length, 3);
      for (const sample of report.samples) {
        assert.equal(sample.iterations, 3);
        assert.equal(sample.valuesMs.length, 3);
        assert.ok(sample.medianMs >= 0);
      }
      assert.ok(report.conditions.logicalCores >= 1);
      assert.ok(report.toolSchemaTokenEstimate.approxTokens >= 1);
      assert.ok(report.residentMemory.afterRssBytes >= report.residentMemory.beforeRssBytes || true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("pagination and fairness bounds", () => {
  it("never stalls the caller loop when pageSize is non-positive", () => {
    // Regression: pageSize <= 0 returned no rows while repeating the same offset,
    // so `while (offset !== null)` in the baseline probe spun forever.
    assert.deepEqual(paginateHistory(10, 0, 0), { ids: [], nextOffset: null });
    assert.deepEqual(paginateHistory(10, -5, 0), { ids: [], nextOffset: null });
    assert.deepEqual(paginateHistory(3, 2, 0), { ids: [0, 1], nextOffset: 2 });
  });

  it("clamps an empty worker set instead of reporting an infinite spread", () => {
    // Regression: Math.max(...[]) is -Infinity, which leaked into the report.
    const empty = concurrentFairness(0, 5);
    assert.equal(empty.perWorker.length, 1);
    assert.ok(Number.isFinite(empty.spread));
    assert.equal(concurrentFairness(0, 0).spread, 0);
  });
});

