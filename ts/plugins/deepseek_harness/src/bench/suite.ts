/**
 * Minimal bench runner (H06.06 support): executes a fixed list of pure bench
 * cases and emits the `BenchRunSummary` the report generator (H06.05) and the
 * CLI `xueness harness bench` exit path consume.
 *
 *  - `runBenchSuite` executes each scenario thunk once, measures wall-clock
 *    latency with an injectable `nowMs` clock (tests pass a deterministic
 *    step clock), and folds the scenario's own token / cache numbers into a
 *    `BenchCaseResult`; a throwing scenario becomes `ok: false` with its
 *    message instead of aborting the suite;
 *  - `defaultBenchCases` (H06.02-style fixtures) are three repeatable cases
 *    built on the real prefix stabilizer: a stable-append session (full cache
 *    hits), a prefix-churn session (mostly misses) and a canonical-JSON
 *    round-trip. Token counts are derived deterministically from the request
 *    characters, so equal inputs always produce equal summaries.
 *
 * Pure computation only: no I/O, no network, no randomness — the default
 * clock is `Date.now`, and every nondeterminism it introduces is confined to
 * the measured `latencyMs` field.
 */
import { canonicalJson, createPrefixCache, type StableRequest } from "../prefix-cache.ts";
import type { BenchCaseResult, BenchRunSummary } from "./report.ts";

/** What one scenario reports besides latency (which the runner measures). */
export interface BenchScenarioResult {
  ok: boolean;
  tokensIn: number;
  tokensOut: number;
  cacheHits: number;
  cacheMisses: number;
}

/** One executable bench case: an id plus a pure scenario thunk. */
export interface BenchCaseSpec {
  caseId: string;
  scenario: () => BenchScenarioResult;
}

export interface BenchSuiteOptions {
  label?: string;
  model?: string;
  cases?: readonly BenchCaseSpec[];
  /** Injectable monotonic clock in ms; defaults to `Date.now`. */
  nowMs?: () => number;
  /** Injectable ISO timestamp for the summary; defaults to `new Date`. */
  now?: () => string;
}

const TOKEN_CHARS = 4;
/** Deterministic token estimate: 1 token per 4 serialized characters. */
const tokensOf = (text: string): number => Math.ceil(text.length / TOKEN_CHARS);

const message = (role: "user" | "assistant", content: string) => ({ role, content });

const request = (turn: number): StableRequest => ({
  messages: [
    message("user", `xueness bench turn ${turn}: analyze the repo map and propose a patch.`),
    message("assistant", `xueness bench reply ${turn}: the prefix must stay byte-stable across turns.`),
  ],
  tools: [],
});

/** H06.02-style built-in fixtures: three repeatable, deterministic cases. */
export function defaultBenchCases(): BenchCaseSpec[] {
  return [
    {
      caseId: "prefix-stable-append",
      scenario: (): BenchScenarioResult => {
        const cache = createPrefixCache();
        let tokensIn = 0;
        let hits = 0;
        let misses = 0;
        for (let turn = 0; turn < 8; turn += 1) {
          const serialized = cache.record("bench-stable", "deepseek-v4.1", request(turn));
          tokensIn += tokensOf(canonicalJson(request(turn)));
          if (serialized.hitChars > 0) hits += 1;
          else misses += 1;
        }
        return { ok: true, tokensIn, tokensOut: 8 * 24, cacheHits: hits, cacheMisses: misses };
      },
    },
    {
      caseId: "prefix-churn",
      scenario: (): BenchScenarioResult => {
        const cache = createPrefixCache();
        let tokensIn = 0;
        let hits = 0;
        let misses = 0;
        for (let turn = 0; turn < 8; turn += 1) {
          const churned: StableRequest = { ...request(turn), messages: [...request(turn).messages, message("user", `churn ${turn}: ${"x".repeat(turn * 50)}`)] };
          const serialized = cache.record(`bench-churn-${turn}`, "deepseek-v4.1", churned);
          tokensIn += tokensOf(canonicalJson(churned));
          if (serialized.hitChars > 0) hits += 1;
          else misses += 1;
        }
        return { ok: true, tokensIn, tokensOut: 8 * 24, cacheHits: hits, cacheMisses: misses };
      },
    },
    {
      caseId: "canonical-json-roundtrip",
      scenario: (): BenchScenarioResult => {
        const payload = request(3);
        let ok = true;
        for (let round = 0; round < 16; round += 1) {
          if (JSON.parse(canonicalJson(payload)) === null) ok = false;
        }
        return { ok, tokensIn: 16 * tokensOf(canonicalJson(payload)), tokensOut: 16 * 8, cacheHits: 16, cacheMisses: 0 };
      },
    },
  ];
}

/** Execute a suite of pure scenarios into one summary; throwing cases fail, not abort. */
export function runBenchSuite(options: BenchSuiteOptions = {}): BenchRunSummary {
  const cases = options.cases ?? defaultBenchCases();
  const nowMs = options.nowMs ?? ((): number => new Date().getTime());
  const results: BenchCaseResult[] = cases.map((spec) => {
    const startedAt = nowMs();
    try {
      const result = spec.scenario();
      return { caseId: spec.caseId, ok: result.ok, metrics: { latencyMs: Math.max(0, nowMs() - startedAt), ...sliceMetrics(result) } };
    } catch (error) {
      return {
        caseId: spec.caseId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        metrics: { latencyMs: Math.max(0, nowMs() - startedAt), tokensIn: 0, tokensOut: 0, cacheHits: 0, cacheMisses: 0 },
      };
    }
  });
  return {
    label: options.label ?? "deepseek_harness-bench",
    model: options.model ?? "deepseek-v4.1",
    createdAt: options.now ? options.now() : new Date().toISOString(),
    cases: results,
  };
}

const sliceMetrics = (result: BenchScenarioResult): { tokensIn: number; tokensOut: number; cacheHits: number; cacheMisses: number } => ({
  tokensIn: result.tokensIn,
  tokensOut: result.tokensOut,
  cacheHits: result.cacheHits,
  cacheMisses: result.cacheMisses,
});
