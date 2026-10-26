/**
 * H11.05 — Chaos report + flake detector over stress-run results.
 */
import { canonicalJson } from "../prefix-cache.ts";
import type { StressRunReport, ScenarioStressResult } from "./stress-runner.ts";
import { expectedChaosFaultKinds, type ChaosFaultKind } from "./scenarios.ts";

export interface FlakeFlag {
  readonly scenarioId: string;
  readonly reason: string;
  readonly rate: number;
}

export interface ChaosReport {
  readonly generatedAt: string;
  readonly concurrency: number;
  readonly totalCalls: number;
  readonly totalFailures: number;
  readonly hardFail: boolean;
  readonly flakes: readonly FlakeFlag[];
  readonly results: readonly ScenarioStressResult[];
  readonly markdown: string;
  readonly json: string;
}

export interface ChaosReportOptions {
  readonly now?: () => string;
  /** Failure rate above which a scenario is a hard fail (default 0.5). */
  readonly hardFailRate?: number;
  /** Mixed success/fail without a single faultKind → flake (default true). */
  readonly detectFlakes?: boolean;
}

export function buildChaosReport(run: StressRunReport, options: ChaosReportOptions = {}): ChaosReport {
  const now = options.now?.() ?? new Date().toISOString();
  const hardFailRate = options.hardFailRate ?? 0.5;
  const detectFlakes = options.detectFlakes ?? true;
  const flakes: FlakeFlag[] = [];
  let hardFail = false;

  for (const result of run.results) {
    const total = result.stats.started || 1;
    const failRate = (result.stats.failed + result.stats.invalidResponses) / total;
    // A scenario is only allowed to throw the fault it injects. A thunk that
    // rejects with anything else — a dropped connection, a wiring bug, a
    // mis-wrapped model — is a harness defect, not the injected fault, so it
    // must fail the gate even when the injected fault is also observed.
    const expected = expectedChaosFaultKinds(result.kind as ChaosFaultKind);
    const outOfFamily = result.stats.faultKinds.some((kind) => !expected.includes(kind as ChaosFaultKind));
    // Failures carrying no `ChaosError` kind at all are un-injected errors, and
    // a body family (partial/malformed/empty) is never expected to throw.
    const unexpectedThrow = result.stats.failed > 0 && (result.stats.faultKinds.length === 0 || expected.length === 0);
    const bodyInvalid =
      result.kind === "partial_json" || result.kind === "malformed_json" || result.kind === "empty_body";
    if (outOfFamily || unexpectedThrow) {
      hardFail = true;
      flakes.push({
        scenarioId: result.scenarioId,
        reason: outOfFamily
          ? `unexpected fault kinds: ${result.stats.faultKinds.join(",")} (expected ${expected.join(",") || "none"})`
          : "failures not attributable to the injected fault",
        rate: failRate,
      });
    }
    if (failRate >= hardFailRate && !bodyInvalid && result.stats.succeeded > 0 && result.stats.failed > 0) {
      // Expected-fault scenarios that throw are not hard fails — only unexpected mixed outcomes.
      hardFail = true;
    }
    if (detectFlakes && result.stats.succeeded > 0 && result.stats.failed > 0) {
      flakes.push({
        scenarioId: result.scenarioId,
        reason: "mixed success and failure under identical scenario",
        rate: failRate,
      });
    }
    if (detectFlakes && result.stats.faultKinds.length > 2) {
      flakes.push({
        scenarioId: result.scenarioId,
        reason: `non-deterministic fault kinds: ${result.stats.faultKinds.join(",")}`,
        rate: failRate,
      });
    }
  }

  const body = {
    generatedAt: now,
    concurrency: run.concurrency,
    totalCalls: run.totalCalls,
    totalFailures: run.totalFailures,
    maxConcurrentObserved: run.maxConcurrentObserved,
    hardFail,
    flakes,
    results: run.results,
  };
  const json = canonicalJson(body);
  const mdLines = [
    `# Chaos stress report`,
    ``,
    `- generatedAt: ${now}`,
    `- concurrency: ${run.concurrency}`,
    `- totalCalls: ${run.totalCalls}`,
    `- totalFailures: ${run.totalFailures}`,
    `- hardFail: ${hardFail}`,
    `- flakes: ${flakes.length}`,
    ``,
    `| scenario | kind | started | ok | invalid | failed | ms |`,
    `| --- | --- | ---: | ---: | ---: | ---: | ---: |`,
  ];
  for (const r of run.results) {
    mdLines.push(`| ${r.scenarioId} | ${r.kind} | ${r.stats.started} | ${r.stats.succeeded} | ${r.stats.invalidResponses} | ${r.stats.failed} | ${r.durationMs} |`);
  }
  if (flakes.length) {
    mdLines.push(``, `## Flakes`);
    for (const f of flakes) mdLines.push(`- ${f.scenarioId}: ${f.reason} (rate=${f.rate.toFixed(3)})`);
  }
  return {
    generatedAt: now,
    concurrency: run.concurrency,
    totalCalls: run.totalCalls,
    totalFailures: run.totalFailures,
    hardFail,
    flakes: Object.freeze(flakes),
    results: run.results,
    markdown: mdLines.join("\n") + "\n",
    json,
  };
}
