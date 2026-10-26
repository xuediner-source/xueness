/**
 * Automatic regression report generator (H06.05).
 *
 * A bench run (H06.01-H06.04 runner + profiler) lands as a `BenchRunSummary`:
 * one row per case with the raw token / cache / latency measurements. This
 * module turns pairs of runs into comparable regression artifacts:
 *
 *  - `summarizeBenchRun` folds one run into totals (passed/failed, latency,
 *    tokens, cache hit rate) plus per-case means — the profiler summary shape;
 *  - `compareBenchRuns` diffs a baseline against a current run. Every tracked
 *    metric gets a signed delta ratio and a verdict (`improved`, `regressed`,
 *    `unchanged`) using a relative threshold (default 10%); cases that
 *    flipped ok -> failed are listed as hard regressions, and added / removed
 *    case ids are recorded so suite drift stays visible;
 *  - `serializeRegressionReport` emits byte-stable JSON via the deterministic
 *    serializer from prefix-cache, so equal inputs always export equal bytes
 *    and reports can be stored and diffed verbatim;
 *  - `renderRegressionMarkdown` renders the same report as a Markdown table
 *    for human review — same numbers, same verdicts, deterministic order.
 *
 * Pure computation only: no I/O, no clock, no randomness. Lower-is-better
 * metrics (latency, tokens) regress when they grow; higher-is-better metrics
 * (cache hit rate, success rate) regress when they shrink.
 */
import { canonicalJson } from "../prefix-cache.ts";

/** Raw profiler measurements attached to one bench case (H06.03 shape). */
export interface BenchCaseMetrics {
  /** Wall-clock duration of the case in milliseconds. */
  latencyMs: number;
  tokensIn: number;
  tokensOut: number;
  cacheHits: number;
  cacheMisses: number;
}

/** One executed bench case: outcome plus its raw measurements. */
export interface BenchCaseResult {
  caseId: string;
  ok: boolean;
  /** Failure message when the case threw; kept verbatim for the report. */
  error?: string;
  metrics: BenchCaseMetrics;
}

/** One full bench run: the unit a regression report compares. */
export interface BenchRunSummary {
  label: string;
  model: string;
  /** ISO timestamp stamped by the runner. */
  createdAt: string;
  cases: readonly BenchCaseResult[];
}

/** Folded totals of one run; ratios are 0-1 fractions, not percentages. */
export interface BenchRunTotals {
  cases: number;
  passed: number;
  failed: number;
  latencyMs: number;
  tokensIn: number;
  tokensOut: number;
  cacheHits: number;
  cacheMisses: number;
  /** cacheHits / (cacheHits + cacheMisses); 0 when nothing was measured. */
  cacheHitRate: number;
  /** passed / cases; 0 when the run is empty. */
  successRate: number;
}

/** A run plus its folded totals and per-case means. */
export interface BenchRunReport {
  label: string;
  model: string;
  createdAt: string;
  totals: BenchRunTotals;
  /** Mean latency / tokens per passed case; 0 when no case passed. */
  perCase: BenchCaseMetrics;
}

/** The metrics a regression report tracks, with their goodness direction. */
export type RegressionMetricKey = "latencyMs" | "tokensIn" | "tokensOut" | "cacheHitRate" | "successRate";

/** Direction a metric is better in: latency grows worse, hit rate grows better. */
export type MetricDirection = "lower-is-better" | "higher-is-better";

export const REGRESSION_METRICS: readonly { key: RegressionMetricKey; direction: MetricDirection }[] = [
  { key: "latencyMs", direction: "lower-is-better" },
  { key: "tokensIn", direction: "lower-is-better" },
  { key: "tokensOut", direction: "lower-is-better" },
  { key: "cacheHitRate", direction: "higher-is-better" },
  { key: "successRate", direction: "higher-is-better" },
];

/** Verdict of one metric comparison after applying the threshold. */
export type MetricVerdict = "improved" | "regressed" | "unchanged";

/** How one tracked metric moved between baseline and current. */
export interface MetricComparison {
  metric: RegressionMetricKey;
  direction: MetricDirection;
  baseline: number;
  current: number;
  /** (current - baseline) / baseline; Infinity when the baseline is 0 and the current value is not. */
  deltaRatio: number;
  verdict: MetricVerdict;
}

/** Options for `compareBenchRuns`. */
export interface RegressionOptions {
  /** Relative change (0-1) a metric must exceed to leave `unchanged`; default 0.1. */
  regressionRatio?: number;
}

/** The comparable regression report between two runs. */
export interface RegressionReport {
  baselineLabel: string;
  currentLabel: string;
  metrics: readonly MetricComparison[];
  /** Case ids that passed in the baseline and failed in the current run. */
  flippedToFailed: readonly string[];
  /** Case ids only present in the current run. */
  addedCases: readonly string[];
  /** Case ids only present in the baseline run. */
  removedCases: readonly string[];
  /** True when nothing regressed: no regressed metric, no flip, no failure added. */
  healthy: boolean;
}

const sum = (values: readonly number[]): number => values.reduce((acc, value) => acc + value, 0);
const roundRatio = (value: number): number => Math.round(value * 1e6) / 1e6;
const ratioOf = (part: number, whole: number): number => (whole <= 0 ? 0 : roundRatio(part / whole));

/** Fold one run into totals plus per-case means; empty runs fold to zeroes. */
export function summarizeBenchRun(run: BenchRunSummary): BenchRunReport {
  const totals: BenchRunTotals = {
    cases: run.cases.length,
    passed: run.cases.filter((item) => item.ok).length,
    failed: run.cases.filter((item) => !item.ok).length,
    latencyMs: sum(run.cases.map((item) => item.metrics.latencyMs)),
    tokensIn: sum(run.cases.map((item) => item.metrics.tokensIn)),
    tokensOut: sum(run.cases.map((item) => item.metrics.tokensOut)),
    cacheHits: sum(run.cases.map((item) => item.metrics.cacheHits)),
    cacheMisses: sum(run.cases.map((item) => item.metrics.cacheMisses)),
    cacheHitRate: ratioOf(
      sum(run.cases.map((item) => item.metrics.cacheHits)),
      sum(run.cases.map((item) => item.metrics.cacheHits + item.metrics.cacheMisses)),
    ),
    successRate: ratioOf(run.cases.filter((item) => item.ok).length, run.cases.length),
  };
  const passed = run.cases.filter((item) => item.ok);
  const mean = (pick: (item: BenchCaseResult) => number): number =>
    passed.length === 0 ? 0 : Math.round((sum(passed.map(pick)) / passed.length) * 1e6) / 1e6;
  return {
    label: run.label,
    model: run.model,
    createdAt: run.createdAt,
    totals,
    perCase: {
      latencyMs: mean((item) => item.metrics.latencyMs),
      tokensIn: mean((item) => item.metrics.tokensIn),
      tokensOut: mean((item) => item.metrics.tokensOut),
      cacheHits: mean((item) => item.metrics.cacheHits),
      cacheMisses: mean((item) => item.metrics.cacheMisses),
    },
  };
}

const metricOf = (report: BenchRunReport, key: RegressionMetricKey): number => report.totals[key];

const verdictFor = (direction: MetricDirection, deltaRatio: number, threshold: number): MetricVerdict => {
  const magnitude = Math.abs(deltaRatio);
  if (magnitude <= threshold) return "unchanged";
  const grew = deltaRatio > 0;
  return (direction === "lower-is-better" ? grew : !grew) ? "regressed" : "improved";
};

/**
 * Diff a baseline run against a current run. Metric comparisons use run
 * totals; a zero baseline with a non-zero current value is an infinite jump
 * (regression for lower-is-better, improvement for higher-is-better).
 */
export function compareBenchRuns(baseline: BenchRunSummary, current: BenchRunSummary, options: RegressionOptions = {}): RegressionReport {
  const threshold = options.regressionRatio ?? 0.1;
  const baselineReport = summarizeBenchRun(baseline);
  const currentReport = summarizeBenchRun(current);
  const metrics: MetricComparison[] = REGRESSION_METRICS.map(({ key, direction }) => {
    const before = metricOf(baselineReport, key);
    const after = metricOf(currentReport, key);
    const deltaRatio = before === 0 ? (after === 0 ? 0 : Number.POSITIVE_INFINITY) : roundRatio((after - before) / before);
    return { metric: key, direction, baseline: roundRatio(before), current: roundRatio(after), deltaRatio, verdict: verdictFor(direction, deltaRatio, threshold) };
  });
  const baselineById = new Map(baseline.cases.map((item) => [item.caseId, item]));
  const currentById = new Map(current.cases.map((item) => [item.caseId, item]));
  const flippedToFailed = baseline.cases
    .filter((item) => item.ok && currentById.get(item.caseId)?.ok === false)
    .map((item) => item.caseId);
  const addedCases = current.cases.filter((item) => !baselineById.has(item.caseId)).map((item) => item.caseId);
  const removedCases = baseline.cases.filter((item) => !currentById.has(item.caseId)).map((item) => item.caseId);
  const newFailures = currentReport.totals.failed > baselineReport.totals.failed;
  return {
    baselineLabel: baseline.label,
    currentLabel: current.label,
    metrics,
    flippedToFailed,
    addedCases,
    removedCases,
    healthy: !metrics.some((item) => item.verdict === "regressed") && flippedToFailed.length === 0 && !newFailures,
  };
}

/** Serialize a report with the canonical serializer: equal reports, equal bytes. */
export function serializeRegressionReport(report: RegressionReport): string {
  return canonicalJson(report);
}

const formatNumber = (value: number): string => (Number.isFinite(value) ? String(value) : "inf");
const percent = (ratio: number): string => (Number.isFinite(ratio) ? `${roundRatio(ratio * 100)}%` : "inf");

/** Render the report as a deterministic Markdown document (H06.05 deliverable). */
export function renderRegressionMarkdown(report: RegressionReport): string {
  const lines: string[] = [
    `# Bench regression report: ${report.baselineLabel} -> ${report.currentLabel}`,
    "",
    `Verdict: ${report.healthy ? "healthy" : "regressed"}`,
    "",
    "| metric | direction | baseline | current | delta | verdict |",
    "| --- | --- | --- | --- | --- | --- |",
    ...report.metrics.map(
      (item) =>
        `| ${item.metric} | ${item.direction} | ${formatNumber(item.baseline)} | ${formatNumber(item.current)} | ${percent(item.deltaRatio)} | ${item.verdict} |`,
    ),
    "",
    `Flipped to failed: ${report.flippedToFailed.length === 0 ? "none" : report.flippedToFailed.join(", ")}`,
    `Added cases: ${report.addedCases.length === 0 ? "none" : report.addedCases.join(", ")}`,
    `Removed cases: ${report.removedCases.length === 0 ? "none" : report.removedCases.join(", ")}`,
    "",
  ];
  return lines.join("\n");
}
