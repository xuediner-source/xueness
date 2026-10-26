/**
 * Token / cache / latency profiler for harness bench runs (H06.03).
 *
 * One profiler instance accumulates one measurement per model call and turns
 * the raw sequence into two views:
 *
 *  - `record` returns the raw sample immediately: token counts as reported by
 *    the provider (or deterministically estimated when absent), the KV-cache
 *    hit measured against the session's previous request via the H01.03
 *    prefix stabilizer, the raw latency in milliseconds, and the *conditions*
 *    the numbers were taken under (cache state, token source, first call);
 *  - `summary` aggregates the samples per model and overall: token totals,
 *    cache hit rates (prefix-based and provider-reported), and latency
 *    min / median / p95 / max plus the mean.
 *
 * Determinism: no I/O, no randomness. Time enters only through the injectable
 * `now` clock; replaying the same call sequence with the same clock yields
 * identical samples and summaries. Estimated tokens use a fixed chars-per-token
 * ratio and are always flagged in the conditions, never mixed silently with
 * reported usage.
 */
import { commonPrefixLength, stablePrefix, type StableRequest } from "../prefix-cache.ts";

/** Provider-reported usage for one call; every field optional and raw. */
export interface UsageReport {
  promptTokens?: number;
  completionTokens?: number;
  /** Tokens the provider claims were served from its KV cache (prompt side). */
  cachedTokens?: number;
}

/** One profiled model call: what happened plus what the request looked like. */
export interface ProfiledCall {
  label: string;
  model: string;
  session?: string;
  request: StableRequest;
  /** Raw wall-clock latency in ms; when omitted the profiler clocks it via `measure`. */
  latencyMs?: number;
  usage?: UsageReport;
}

/** The conditions a sample's raw numbers were measured under. */
export interface ProfileConditions {
  /** First recorded call of its session: nothing to hit in the cache yet. */
  firstCall: boolean;
  /** cold = nothing reused, partial = some prefix reused, warm = full reuse. */
  cacheState: "cold" | "partial" | "warm";
  /** reported = provider prompt usage; estimated = chars/4 heuristic on the prompt side. */
  tokenSource: "reported" | "estimated";
  /** True when the provider reported its own cached-token count. */
  providerCacheReported: boolean;
  /** Present when only completion tokens were reported (the prompt side is estimated). */
  completionTokensReported?: true;
}

/** One recorded measurement; token/latency values are raw, never smoothed. */
export interface ProfileSample {
  label: string;
  model: string;
  session: string;
  sequence: number;
  conditions: ProfileConditions;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  /** Provider-reported cache ratio on the prompt side; 0 when unreported. */
  providerCacheHitRate: number;
  /** Prompt bytes shared with the session's previous request (H01.03 metric). */
  cacheHitChars: number;
  cacheTotalChars: number;
  /** `cacheHitChars / cacheTotalChars`; 0 for a session's first call. */
  cacheHitRate: number;
  latencyMs: number;
}

/** Latency distribution in ms; median is the lower middle element. */
export interface LatencyStats {
  count: number;
  minMs: number;
  medianMs: number;
  p95Ms: number;
  maxMs: number;
  meanMs: number;
}

/** Aggregated raw totals and rates for one model (or the whole run, `*`). */
export interface ProfileAggregate {
  /** The model this row aggregates; `*` for the overall row. */
  model: string;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  cacheHitChars: number;
  cacheTotalChars: number;
  cacheHitRate: number;
  warmCalls: number;
  coldCalls: number;
  partialCalls: number;
  latency: LatencyStats;
}

export interface ProfileSummary {
  models: readonly ProfileAggregate[];
  overall: ProfileAggregate;
}

export interface BenchProfilerOptions {
  /** Deterministic clock for `measure`; defaults to a monotonic 0-based fake. */
  now?: () => number;
  /** Chars per token for the estimation fallback; default 4. */
  charsPerToken?: number;
}

export interface BenchProfiler {
  /** Record one completed call (latency already measured by the caller). */
  record(call: ProfiledCall): ProfileSample;
  /**
   * Time one async invocation and record it; latency = now() delta in ms.
   * `usageOf` reads the usage block off the invocation's result when it
   * resolves; without it (or when it yields nothing) `call.usage` stands.
   */
  measure(
    call: Omit<ProfiledCall, "latencyMs">,
    invoke: () => Promise<unknown>,
    usageOf?: (result: unknown) => UsageReport | undefined,
  ): Promise<ProfileSample>;
  /** All samples in recording order. */
  samples(): readonly ProfileSample[];
  /** Aggregates: per model sorted by name, plus the overall row. */
  summary(): ProfileSummary;
  reset(): void;
}

/** Deterministic fallback clock: strictly increasing, 1 ms per tick. */
function tickClock(): () => number {
  let ticks = 0;
  return () => {
    ticks += 1;
    return ticks;
  };
}

function percentile(sorted: readonly number[], ratio: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(ratio * sorted.length) - 1));
  return sorted[index] as number;
}

function latencyStats(values: readonly number[]): LatencyStats {
  const sorted = [...values].sort((left, right) => left - right);
  const count = sorted.length;
  if (count === 0) return { count: 0, minMs: 0, medianMs: 0, p95Ms: 0, maxMs: 0, meanMs: 0 };
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    count,
    minMs: sorted[0] as number,
    medianMs: sorted[Math.floor((count - 1) / 2)] as number,
    p95Ms: percentile(sorted, 0.95),
    maxMs: sorted[count - 1] as number,
    meanMs: sum / count,
  };
}

const round = (value: number): number => Math.round(value * 1e6) / 1e6;

interface SessionState {
  prefix: string;
  sequence: number;
}

interface Tally {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  cacheHitChars: number;
  cacheTotalChars: number;
  warmCalls: number;
  coldCalls: number;
  partialCalls: number;
  latencies: number[];
}

const newTally = (): Tally => ({ calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, cacheHitChars: 0, cacheTotalChars: 0, warmCalls: 0, coldCalls: 0, partialCalls: 0, latencies: [] });

function aggregate(tally: Tally, model: string): ProfileAggregate {
  return {
    model,
    calls: tally.calls,
    promptTokens: tally.promptTokens,
    completionTokens: tally.completionTokens,
    totalTokens: tally.totalTokens,
    cachedTokens: tally.cachedTokens,
    cacheHitChars: tally.cacheHitChars,
    cacheTotalChars: tally.cacheTotalChars,
    cacheHitRate: tally.cacheTotalChars === 0 ? 0 : round(tally.cacheHitChars / tally.cacheTotalChars),
    warmCalls: tally.warmCalls,
    coldCalls: tally.coldCalls,
    partialCalls: tally.partialCalls,
    latency: latencyStats(tally.latencies),
  };
}

/**
 * The profiler. `record` is deterministic: the same call sequence under the
 * same clock produces identical samples and an identical `summary()`.
 */
export function createBenchProfiler(options: BenchProfilerOptions = {}): BenchProfiler {
  const now = options.now ?? tickClock();
  const charsPerToken = options.charsPerToken ?? 4;
  const sessions = new Map<string, SessionState>();
  const models = new Map<string, Tally>();
  const overall = newTally();
  const recorded: ProfileSample[] = [];

  const classify = (hitChars: number, previousLength: number, firstCall: boolean): ProfileConditions["cacheState"] => {
    if (firstCall || hitChars === 0) return "cold";
    // H01.03 semantics: warm means the session's previous prefix survived
    // whole (a pure append), not that the new request added nothing on top.
    if (hitChars >= previousLength) return "warm";
    return "partial";
  };

  const tally = (t: Tally, sample: ProfileSample): void => {
    t.calls += 1;
    t.promptTokens += sample.promptTokens;
    t.completionTokens += sample.completionTokens;
    t.totalTokens += sample.totalTokens;
    t.cachedTokens += sample.cachedTokens;
    t.cacheHitChars += sample.cacheHitChars;
    t.cacheTotalChars += sample.cacheTotalChars;
    if (sample.conditions.cacheState === "warm") t.warmCalls += 1;
    else if (sample.conditions.cacheState === "partial") t.partialCalls += 1;
    else t.coldCalls += 1;
    t.latencies.push(sample.latencyMs);
  };

  /** Record one call; a free function so `measure` never depends on `this`. */
  const recordCall = (call: ProfiledCall): ProfileSample => {
    const session = call.session ?? `${call.model}:${call.label}`;
    const state = sessions.get(session) ?? { prefix: "", sequence: 0 };
    const prefix = stablePrefix(call.request);
    const firstCall = state.sequence === 0;
    const hitChars = firstCall ? 0 : commonPrefixLength(state.prefix, prefix);
    const totalChars = prefix.length;
    sessions.set(session, { prefix, sequence: state.sequence + 1 });

    const usage = call.usage;
    const promptReported = usage?.promptTokens !== undefined;
    const completionReported = usage?.completionTokens !== undefined;
    const promptTokens = usage?.promptTokens ?? Math.ceil(totalChars / charsPerToken);
    const completionTokens = usage?.completionTokens ?? 0;
    const cachedTokens = usage?.cachedTokens ?? 0;
    // Only a reported prompt count makes the prompt side (and the derived cache
    // ratio) trustworthy; a completion-only usage block leaves it estimated.
    const tokenSource: ProfileConditions["tokenSource"] = promptReported ? "reported" : "estimated";

    const sample: ProfileSample = {
      label: call.label,
      model: call.model,
      session,
      sequence: state.sequence + 1,
      conditions: {
        firstCall,
        cacheState: classify(hitChars, state.prefix.length, firstCall),
        tokenSource,
        providerCacheReported: usage?.cachedTokens !== undefined,
        ...(completionReported && !promptReported ? { completionTokensReported: true } : {}),
      },
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      cachedTokens,
      providerCacheHitRate: promptTokens === 0 || cachedTokens === 0 ? 0 : round(cachedTokens / promptTokens),
      cacheHitChars: hitChars,
      cacheTotalChars: totalChars,
      cacheHitRate: totalChars === 0 || firstCall ? 0 : round(hitChars / totalChars),
      latencyMs: call.latencyMs ?? 0,
    };
    recorded.push(sample);
    tally(overall, sample);
    const model = models.get(call.model) ?? newTally();
    tally(model, sample);
    models.set(call.model, model);
    return sample;
  };

  return {
    record: recordCall,
    async measure(call, invoke, usageOf = () => undefined) {
      const started = now();
      const result = await invoke();
      const usage = usageOf(result) ?? call.usage;
      return recordCall({ ...call, usage, latencyMs: Math.max(0, now() - started) });
    },
    samples: () => [...recorded],
    summary() {
      return {
        models: [...models.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)).map(([model, tallyRow]) => aggregate(tallyRow, model)),
        overall: aggregate(overall, "*"),
      };
    },
    reset() {
      sessions.clear();
      models.clear();
      recorded.length = 0;
      Object.assign(overall, newTally());
    },
  };
}
