/**
 * Bench runner with an embedded profiler (H06.04).
 *
 * The runner walks a list of bench cases in order, executes each case's
 * provider call, and routes every call through one shared H06.03 profiler:
 * latency is clocked around the invocation, the request's stable prefix is
 * measured against the session's previous request, and the usage block the
 * call resolves with supplies raw token counts. A single `run` therefore
 * already yields a profile summary — no second pass over the cases.
 *
 * Failure isolation: a rejected case call is reported as a failed outcome and
 * never profiled (there are no honest latency or token numbers for a call that
 * did not complete); the remaining cases still run.
 *
 * Deliberately thin: case sourcing, fixtures and report rendering belong to
 * other rounds (H06.02 / H06.05). Everything here is plain data plus the
 * injected `now` clock, so runs are reproducible under a deterministic clock.
 */
import type { StableRequest } from "../prefix-cache.ts";
import { createBenchProfiler, type BenchProfiler, type ProfileSample, type ProfileSummary, type UsageReport } from "./profiler.ts";

/** What one bench case's provider call resolves with; usage is optional and raw. */
export interface BenchCallResult {
  usage?: UsageReport;
  [extra: string]: unknown;
}

/** One executable bench case: a model request plus the call that answers it. */
export interface BenchCase {
  name: string;
  model: string;
  session?: string;
  request: StableRequest;
  /** Executes the case; may reject, which fails this case only. */
  call: () => Promise<BenchCallResult>;
}

/** The recorded outcome of one case. */
export interface BenchOutcome {
  name: string;
  model: string;
  ok: boolean;
  /** Failure message when the case call rejected; absent otherwise. */
  error?: string;
  /** The profiler sample; absent when the case failed before completing. */
  sample?: ProfileSample;
}

/** What one full bench run produced: outcomes plus the profile summary. */
export interface BenchRunResult {
  ok: boolean;
  ran: number;
  failed: number;
  outcomes: readonly BenchOutcome[];
  /** The embedded profiler's summary over exactly the successful calls. */
  profile: ProfileSummary;
}

export interface BenchRunnerOptions {
  /** Deterministic clock shared by every case; feeds the profiler's timing. */
  now?: () => number;
  /** Inject an existing profiler (tests / composition); a fresh one otherwise. */
  profiler?: BenchProfiler;
}

export interface BenchRunner {
  /** Run the cases in order and produce outcomes plus the profile summary. */
  run(cases: readonly BenchCase[]): Promise<BenchRunResult>;
  /** The embedded profiler, inspectable after (or between) runs. */
  profiler: BenchProfiler;
}

/** Read the usage block off a resolved case result, tolerating odd shapes. */
function usageOf(result: unknown): UsageReport | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const usage = (result as { usage?: unknown }).usage;
  if (typeof usage !== "object" || usage === null) return undefined;
  return usage as UsageReport;
}

/**
 * Build a runner around one profiler. Every successful case is timed with
 * `profiler.measure`, so latency, cache-hit and token numbers come from a
 * single measurement path — the runner adds no timing of its own.
 */
export function createBenchRunner(options: BenchRunnerOptions = {}): BenchRunner {
  const profiler = options.profiler ?? createBenchProfiler({ now: options.now });
  return {
    profiler,
    async run(cases) {
      const outcomes: BenchOutcome[] = [];
      for (const bench of cases) {
        try {
          const sample = await profiler.measure(
            { label: bench.name, model: bench.model, session: bench.session, request: bench.request },
            bench.call,
            usageOf,
          );
          outcomes.push({ name: bench.name, model: bench.model, ok: true, sample });
        } catch (error) {
          outcomes.push({ name: bench.name, model: bench.model, ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      }
      const failed = outcomes.filter((outcome) => !outcome.ok).length;
      return { ok: failed === 0, ran: outcomes.length, failed, outcomes, profile: profiler.summary() };
    },
  };
}
