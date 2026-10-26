/**
 * Harness benchmark runner skeleton (H06.01).
 *
 * Runs a set of harness benchmark cases (`BenchCase`: id + iterations + a pure
 * `run` workload) and reports per-case timings plus a deterministic aggregate:
 *
 *  - every case is measured independently: a case whose `run` throws, or whose
 *    definition is invalid (duplicate id, non-positive iterations), is reported
 *    as a failed result and never aborts the remaining cases;
 *  - timing goes through an injectable `clock` (`() => number` ticks), so tests
 *    replay runs deterministically and repeated runs of the same case list
 *    produce byte-identical reports;
 *  - each result carries a digest of the workload's last return value (via the
 *    canonical serializer), so a fixture that silently changes behaviour shows
 *    up as a digest change even when timings are inconclusive;
 *  - the summary ranks cases by mean ticks per iteration; ties break on case
 *    id, keeping `formatBenchReport` output stable.
 *
 * Pure computation only: no I/O, no randomness; the only clock is injected.
 */
import { canonicalJson } from "../prefix-cache.ts";

const CASE_ID = /^[a-z][a-z0-9_]{0,63}$/;

/** One benchmark case: a pure workload measured `iterations` times. */
export interface BenchCase {
  readonly id: string;
  readonly description: string;
  /** How many times `run` is measured; must be a positive integer. */
  readonly iterations: number;
  /** The workload under measurement; must be side-effect free. */
  readonly run: () => unknown;
}

/** Timing numbers for one case, in `clock` ticks (not wall units). */
export interface BenchCaseTimings {
  readonly totalTicks: number;
  readonly minTicks: number;
  readonly maxTicks: number;
  readonly meanTicks: number;
}

export interface BenchCaseResult {
  readonly id: string;
  readonly ok: boolean;
  readonly iterations: number;
  readonly timings: BenchCaseTimings | null;
  /** Canonical digest of the last return value; null for failed cases. */
  readonly valueDigest: string | null;
  /** Present exactly when `ok` is false. */
  readonly error: string | null;
}

export interface BenchRunSummary {
  readonly total: number;
  readonly ok: number;
  readonly failed: number;
  readonly totalTicks: number;
  /** Case ids ordered by ascending mean ticks (fastest first); failed cases excluded. */
  readonly ranking: readonly string[];
}

export interface BenchRunReport {
  readonly results: readonly BenchCaseResult[];
  readonly summary: BenchRunSummary;
}

export interface BenchRunOptions {
  /** Tick source measured around each iteration; defaults to a zero clock. */
  readonly clock?: () => number;
}

const defaultClock = (): number => 0;

const digestOf = (value: unknown): string => canonicalJson(value);

/**
 * Measure one well-formed case: `iterations` timed executions of `run`.
 * Returns a failed result (with the thrown message) instead of propagating.
 *
 * Called directly (outside `runBenchCases`) an unusable iteration count is
 * reported as a failed result too: measuring a case zero times would otherwise
 * yield a timing row with `meanTicks: NaN`, which serializes to `null` and
 * silently poisons every downstream aggregate.
 */
export function runBenchCase(benchCase: BenchCase, clock: () => number = defaultClock): BenchCaseResult {
  if (!Number.isSafeInteger(benchCase.iterations) || benchCase.iterations < 1) {
    return { id: benchCase.id, ok: false, iterations: 0, timings: null, valueDigest: null, error: "iterations must be a positive integer" };
  }
  let total = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = 0;
  let last: unknown;
  for (let index = 0; index < benchCase.iterations; index += 1) {
    const start = clock();
    try {
      last = benchCase.run();
    } catch (error) {
      return { id: benchCase.id, ok: false, iterations: benchCase.iterations, timings: null, valueDigest: null, error: (error as Error).message };
    }
    const elapsed = Math.max(0, clock() - start);
    total += elapsed;
    if (elapsed < min) min = elapsed;
    if (elapsed > max) max = elapsed;
  }
  const timings: BenchCaseTimings = {
    totalTicks: total,
    minTicks: min,
    maxTicks: max,
    meanTicks: total / benchCase.iterations,
  };
  return { id: benchCase.id, ok: true, iterations: benchCase.iterations, timings, valueDigest: digestOf(last), error: null };
}

const summarize = (results: readonly BenchCaseResult[]): BenchRunSummary => {
  const okResults = results.filter((result) => result.ok);
  const ranked = [...okResults].sort((left, right) => {
    const leftMean = (left.timings as BenchCaseTimings).meanTicks;
    const rightMean = (right.timings as BenchCaseTimings).meanTicks;
    return leftMean !== rightMean ? leftMean - rightMean : (left.id < right.id ? -1 : 1);
  });
  return {
    total: results.length,
    ok: okResults.length,
    failed: results.length - okResults.length,
    totalTicks: okResults.reduce((sum, result) => sum + (result.timings as BenchCaseTimings).totalTicks, 0),
    ranking: ranked.map((result) => result.id),
  };
};

/**
 * Run a list of benchmark cases (H06.01 acceptance: one call, a whole set).
 *
 * Cases run in list order. A duplicate id, a malformed id or a non-positive
 * iteration count is reported as that case's own failure; a throwing workload
 * is caught by `runBenchCase`. In either case the run continues.
 */
export function runBenchCases(cases: readonly BenchCase[], options: BenchRunOptions = {}): BenchRunReport {
  const clock = options.clock ?? defaultClock;
  const results: BenchCaseResult[] = [];
  const seen = new Set<string>();
  for (const benchCase of cases) {
    if (typeof benchCase.id !== "string" || !CASE_ID.test(benchCase.id)) {
      results.push({ id: String(benchCase.id), ok: false, iterations: 0, timings: null, valueDigest: null, error: "case id must be a lowercase snake id" });
      continue;
    }
    if (seen.has(benchCase.id)) {
      results.push({ id: benchCase.id, ok: false, iterations: 0, timings: null, valueDigest: null, error: `duplicate case id ${benchCase.id}` });
      continue;
    }
    seen.add(benchCase.id);
    if (!Number.isSafeInteger(benchCase.iterations) || benchCase.iterations < 1) {
      results.push({ id: benchCase.id, ok: false, iterations: 0, timings: null, valueDigest: null, error: "iterations must be a positive integer" });
      continue;
    }
    results.push(runBenchCase(benchCase, clock));
  }
  return { results, summary: summarize(results) };
}

const formatTimings = (result: BenchCaseResult): string => {
  if (!result.ok || result.timings === null) return `error: ${result.error ?? "unknown"}`;
  return `${result.timings.meanTicks.toFixed(2)} mean ticks (min ${result.timings.minTicks}, max ${result.timings.maxTicks}, total ${result.timings.totalTicks})`;
};

/**
 * Render a report as a stable multi-line string: one `id  status  timings`
 * line per case in run order, then a summary footer. Equal reports always
 * format byte-identically, so CLI output can be diffed.
 */
export function formatBenchReport(report: BenchRunReport): string {
  const lines = report.results.map((result) => `${result.id}  ${result.ok ? "ok" : "FAILED"}  ${formatTimings(result)}`);
  const { summary } = report;
  lines.push(`summary: ${summary.ok}/${summary.total} ok, ${summary.failed} failed, ${summary.totalTicks} ticks total`);
  lines.push(summary.ranking.length ? `ranking (fastest first): ${summary.ranking.join(", ")}` : "ranking (fastest first): -");
  return lines.join("\n");
}
