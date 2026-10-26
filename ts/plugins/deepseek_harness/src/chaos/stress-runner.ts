/**
 * H11.02 — Stress runner with concurrency budget.
 *
 * Drives every catalog scenario (H11.01) against an injected model under a
 * bounded concurrency budget built on the H07 `SlotPool`: no matter how many
 * (scenario x call) tasks are in flight, at most `concurrency` model calls
 * run at once, verified by a high-water mark in the report.
 *
 * Failures are isolated per scenario: a faulting scenario never rejects the
 * run. Thrown errors land in that scenario's `errors` bucket; responses that
 * resolve but fail the scenario's validity check land in `invalidResponses`
 * (that is the partial-JSON / empty-body family doing its job). The runner
 * resolves with a full report once every task has settled.
 */

import type { HarnessModel, ModelResponse } from "../builtins/critic-solver.ts";
import { SlotPool } from "../swarm/critic-slots.ts";
import {
  CHAOS_SCENARIOS,
  type ChaosScenario,
  healthyModel,
  isChaosError,
} from "./scenarios.ts";

export interface ScenarioCallStats {
  /** Calls started (slots acquired). */
  readonly started: number;
  /** Calls that resolved without throwing. */
  readonly succeeded: number;
  /** Calls whose response failed the validity check (e.g. truncated JSON). */
  readonly invalidResponses: number;
  /** Calls that threw (timeout / 429 / any other error). */
  readonly failed: number;
  /** Distinct `ChaosError.kind` values observed, for taxonomy assertions. */
  readonly faultKinds: readonly string[];
}

export interface ScenarioStressResult {
  readonly scenarioId: string;
  readonly kind: string;
  readonly stats: ScenarioCallStats;
  /** Message per thrown error, capped by `maxErrorsRecorded` (default 8). */
  readonly errors: readonly string[];
  /** Wall-clock duration of this scenario's tasks, milliseconds. */
  readonly durationMs: number;
}

export interface StressRunReport {
  readonly concurrency: number;
  readonly callsPerScenario: number;
  readonly results: readonly ScenarioStressResult[];
  /** High-water mark of simultaneously busy slots; must stay <= `concurrency`. */
  readonly maxConcurrentObserved: number;
  readonly totalCalls: number;
  readonly totalFailures: number;
  readonly durationMs: number;
}

export interface StressRunnerOptions {
  /** Scenario catalog to run; defaults to `CHAOS_SCENARIOS`. */
  readonly scenarios?: readonly ChaosScenario[];
  /** Slot budget shared by every scenario; default 4. */
  readonly concurrency?: number;
  /** Model calls issued per scenario; default 8. */
  readonly callsPerScenario?: number;
  /** Healthy victim model the faults are injected around; default `healthyModel()`. */
  readonly model?: HarnessModel;
  /** Cap on error messages kept per scenario; default 8. */
  readonly maxErrorsRecorded?: number;
}

/**
 * Default validity check: a response must be non-blank, and when the
 * scenario's fault family is JSON-shaped the text must parse as JSON.
 * Overridable via options in tests that only care about thrown errors.
 */
export function defaultResponseValid(scenario: ChaosScenario, text: string): boolean {
  if (!text.trim()) return false;
  if (scenario.kind === "partial_json" || scenario.kind === "malformed_json") {
    try {
      JSON.parse(text);
      return true;
    } catch {
      return false;
    }
  }
  return true;
}

interface Bucket {
  started: number;
  succeeded: number;
  invalidResponses: number;
  failed: number;
  faultKinds: Set<string>;
  errors: string[];
}

const newBucket = (): Bucket => ({
  started: 0, succeeded: 0, invalidResponses: 0, failed: 0, faultKinds: new Set(), errors: [],
});

/**
 * Runs the whole catalog under one slot pool. Tasks are launched together and
 * serialized only by slot availability, so the pool — not launch order — is
 * the sole concurrency gate.
 */
export async function runChaosStress(options: StressRunnerOptions = {}): Promise<StressRunReport> {
  const scenarios = options.scenarios ?? CHAOS_SCENARIOS;
  const concurrency = options.concurrency ?? 4;
  const callsPerScenario = options.callsPerScenario ?? 8;
  const model = options.model ?? healthyModel();
  const maxErrorsRecorded = options.maxErrorsRecorded ?? 8;

  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`stress runner requires concurrency >= 1 (got ${concurrency})`);
  }
  if (!Number.isInteger(callsPerScenario) || callsPerScenario < 1) {
    throw new Error(`stress runner requires callsPerScenario >= 1 (got ${callsPerScenario})`);
  }

  const pool = new SlotPool("solver", concurrency);
  const buckets = new Map<string, Bucket>();
  const scenarioStarts = new Map<string, number>();
  const scenarioEnds = new Map<string, number>();
  let maxConcurrentObserved = 0;
  const started = Date.now();

  const settle = (scenarioId: string): void => {
    const now = Date.now();
    scenarioEnds.set(scenarioId, Math.max(scenarioEnds.get(scenarioId) ?? 0, now));
  };

  // One wrapper per scenario, created up front so a scenario's `everyN`
  // fault sequencing (call counter) persists across its calls. A scenario
  // whose inject() throws is isolated: its bucket records every call as a
  // wiring failure and the rest of the run is unaffected.
  const injectedByScenario = new Map<string, HarnessModel | null>();
  for (const scenario of scenarios) {
    const bucket = buckets.get(scenario.id) ?? newBucket();
    buckets.set(scenario.id, bucket);
    try {
      injectedByScenario.set(scenario.id, scenario.inject(model));
    } catch (error) {
      injectedByScenario.set(scenario.id, null);
      for (let n = 0; n < callsPerScenario; n += 1) {
        bucket.started += 1;
        bucket.failed += 1;
        if (bucket.errors.length < maxErrorsRecorded) {
          bucket.errors.push(`inject failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }

  const runOne = async (scenario: ChaosScenario, callIndex: number): Promise<void> => {
    const injected = injectedByScenario.get(scenario.id);
    if (!injected) return;
    const bucket = buckets.get(scenario.id) ?? newBucket();
    buckets.set(scenario.id, bucket);
    if (!scenarioStarts.has(scenario.id)) scenarioStarts.set(scenario.id, Date.now());
    const slot = await pool.acquire();
    const busy = pool.busyCount;
    if (busy > maxConcurrentObserved) maxConcurrentObserved = busy;
    bucket.started += 1;
    try {
      const response: ModelResponse = await injected.complete({
        role: "chaos",
        prompt: `stress:${scenario.id}`,
        callIndex,
      });
      if (defaultResponseValid(scenario, response.text)) {
        bucket.succeeded += 1;
      } else {
        bucket.invalidResponses += 1;
      }
    } catch (error) {
      bucket.failed += 1;
      if (isChaosError(error)) bucket.faultKinds.add(error.kind);
      if (bucket.errors.length < maxErrorsRecorded) {
        bucket.errors.push(error instanceof Error ? error.message : String(error));
      }
    } finally {
      pool.release(slot);
      settle(scenario.id);
    }
  };

  const tasks: Promise<void>[] = [];
  let callIndex = 0;
  for (const scenario of scenarios) {
    for (let n = 0; n < callsPerScenario; n += 1) {
      callIndex += 1;
      tasks.push(runOne(scenario, callIndex));
    }
  }
  await Promise.all(tasks);

  const results: ScenarioStressResult[] = scenarios.map((scenario) => {
    const bucket = buckets.get(scenario.id) ?? newBucket();
    return {
      scenarioId: scenario.id,
      kind: scenario.kind,
      stats: {
        started: bucket.started,
        succeeded: bucket.succeeded,
        invalidResponses: bucket.invalidResponses,
        failed: bucket.failed,
        faultKinds: [...bucket.faultKinds].sort(),
      },
      errors: [...bucket.errors],
      durationMs: Math.max(0, (scenarioEnds.get(scenario.id) ?? 0) - (scenarioStarts.get(scenario.id) ?? 0)),
    };
  });

  const totalFailures = results.reduce((sum, result) => sum + result.stats.failed + result.stats.invalidResponses, 0);
  return {
    concurrency,
    callsPerScenario,
    results,
    maxConcurrentObserved,
    totalCalls: results.reduce((sum, result) => sum + result.stats.started, 0),
    totalFailures,
    durationMs: Date.now() - started,
  };
}
