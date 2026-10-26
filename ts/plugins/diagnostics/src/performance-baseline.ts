/**
 * F14.03 — repeatable local performance / resource baseline.
 * Captures cold-start wall time, long-history pagination cost, concurrent
 * fairness samples, tool-schema token estimate, and resident memory. Values
 * are raw measurements plus the conditions they were taken under; nothing is
 * normalized into a rate or a pass/fail score here.
 */
import { cpus, freemem, totalmem } from "node:os";
import { runtimeSnapshot } from "./metrics.ts";

export const PERF_SCHEMA = "xueness.performance-baseline.v1";

export interface PerfConditions {
  platform: NodeJS.Platform;
  node: string;
  logicalCores: number;
  totalMemBytes: number;
  availableMemBytes: number;
  cwd: string;
}

export interface PerfSample {
  name: string;
  iterations: number;
  valuesMs: number[];
  /** Median of `valuesMs` (raw ms). */
  medianMs: number;
  notes?: string;
}

export interface PerfBaselineReport {
  schema: string;
  round: "F14.03";
  recordedAt: string;
  conditions: PerfConditions;
  samples: PerfSample[];
  residentMemory: {
    beforeRssBytes: number;
    afterRssBytes: number;
    runtime: ReturnType<typeof runtimeSnapshot>;
  };
  /** Rough tool-schema token estimate: UTF-8 bytes / 4 (raw, not billed). */
  toolSchemaTokenEstimate: { bytes: number; approxTokens: number; schemaNames: string[] };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function timeIt(iterations: number, body: () => void): number[] {
  const values: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    const start = performance.now();
    body();
    values.push(performance.now() - start);
  }
  return values;
}

/** Paginate a synthetic long history the way a transcript reader would. */
export function paginateHistory(total: number, pageSize: number, offset: number): { ids: number[]; nextOffset: number | null } {
  const start = Math.max(0, Math.floor(offset));
  const size = Math.floor(pageSize);
  // A non-positive page size yields no rows, so it must also end the walk: returning the
  // same offset would make a caller loop (`while (offset !== null)`) spin forever, and
  // promoting it to one row would serve data that was never requested.
  if (!(size > 0)) return { ids: [], nextOffset: null };
  const ids = Array.from({ length: Math.min(size, Math.max(0, Math.floor(total) - start)) }, (_, i) => start + i);
  const next = start + ids.length;
  return { ids, nextOffset: next < total ? next : null };
}

/** Fairness probe: N workers claim slots from a shared counter; report max-min claim counts. */
export function concurrentFairness(workers: number, claims: number): { perWorker: number[]; spread: number } {
  // Math.max(...[]) is -Infinity, so an empty worker set must be clamped to one lane.
  const perWorker = Array.from({ length: Math.max(1, Math.floor(workers)) }, () => 0);
  let next = 0;
  while (next < claims) {
    const slot = next % workers;
    perWorker[slot]! += 1;
    next += 1;
  }
  return { perWorker, spread: Math.max(...perWorker) - Math.min(...perWorker) };
}

export interface BuildBaselineOptions {
  stateDir: string;
  iterations?: number;
  historyLength?: number;
  pageSize?: number;
  schemaDocs?: Record<string, string>;
  now?: () => Date;
}

export function buildPerformanceBaseline(options: BuildBaselineOptions): PerfBaselineReport {
  const iterations = options.iterations ?? 5;
  const historyLength = options.historyLength ?? 10_000;
  const pageSize = options.pageSize ?? 100;
  const beforeRss = process.memoryUsage().rss;
  const cold = timeIt(iterations, () => {
    // Synthetic cold path: allocate a small module graph stand-in and drop it.
    const bag = Array.from({ length: 200 }, (_, i) => ({ i, payload: `m-${i}` }));
    void bag.length;
  });
  const page = timeIt(iterations, () => {
    let offset: number | null = 0;
    while (offset !== null) {
      const pageResult = paginateHistory(historyLength, pageSize, offset);
      offset = pageResult.nextOffset;
    }
  });
  const fairness = concurrentFairness(8, 800);
  const fairnessMs = timeIt(iterations, () => { concurrentFairness(8, 800); });
  const schemaDocs = options.schemaDocs ?? {
    remote_exec: '{"type":"object","properties":{"command":{"type":"string"}}}',
    web_search: '{"type":"object","properties":{"query":{"type":"string"}}}',
  };
  const schemaBytes = Object.values(schemaDocs).reduce((sum, doc) => sum + Buffer.byteLength(doc), 0);
  const afterRss = process.memoryUsage().rss;
  const runtime = runtimeSnapshot(options.stateDir);
  return {
    schema: PERF_SCHEMA,
    round: "F14.03",
    recordedAt: (options.now ?? (() => new Date()))().toISOString(),
    conditions: {
      platform: process.platform,
      node: process.version,
      logicalCores: cpus().length,
      totalMemBytes: totalmem(),
      availableMemBytes: freemem(),
      cwd: process.cwd(),
    },
    samples: [
      { name: "cold_start_standin", iterations, valuesMs: cold, medianMs: median(cold), notes: "synthetic module-graph stand-in" },
      { name: "long_history_pagination", iterations, valuesMs: page, medianMs: median(page), notes: `${historyLength} rows / page ${pageSize}` },
      { name: "concurrent_fairness", iterations, valuesMs: fairnessMs, medianMs: median(fairnessMs), notes: `spread=${fairness.spread} over 8 workers` },
    ],
    residentMemory: { beforeRssBytes: beforeRss, afterRssBytes: afterRss, runtime },
    toolSchemaTokenEstimate: {
      bytes: schemaBytes,
      approxTokens: Math.ceil(schemaBytes / 4),
      schemaNames: Object.keys(schemaDocs).sort(),
    },
  };
}
