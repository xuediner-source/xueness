/**
 * H07.06 — swarm trajectory rollup.
 *
 * Aggregates the per-slot JSONL trajectories the swarm's recorders wrote
 * (H02.06) into one swarm-level JSONL summary: one `slot` line per slot with
 * its call count, token usage and KV prefix-cache hit stats, followed by a
 * single `swarm` line that totals every slot and merges the per-model and
 * per-role cache buckets. The rollup is pure over its inputs — the sink and
 * clock are injected — so the aggregation rules stay deterministic.
 */

import {
  analyzeTrajectory,
  parseTrajectory,
  type ExchangeEvent,
  type KvGroupStats,
  type TrajectorySink,
  memorySink,
} from "../builtins/trajectory-recorder.ts";

/** One slot's trajectory input: the JSONL its recorder produced. */
export interface SlotTrajectoryInput {
  readonly slotId: string;
  /** Job that ran on the slot, when the swarm tracks jobs per slot. */
  readonly jobId?: string;
  readonly trajectory: string;
}

/** JSONL record: per-slot cache stats. */
export interface SlotTrajectorySummary {
  readonly type: "slot";
  readonly at: string;
  readonly slotId: string;
  readonly jobId: string | null;
  readonly calls: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly cachedTokens: number;
  readonly hitRate: number;
  readonly fullyCached: number;
  readonly coldCalls: number;
  readonly uncachedPromptTokens: number;
}

/** JSONL record: swarm-wide totals merged from every slot summary. */
export interface SwarmTrajectorySummary {
  readonly type: "swarm";
  readonly at: string;
  readonly slots: number;
  readonly calls: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly cachedTokens: number;
  readonly hitRate: number;
  readonly uncachedPromptTokens: number;
  /** Slots whose whole trajectory never hit the cache once. */
  readonly coldSlots: number;
  readonly byModel: Record<string, KvGroupStats>;
  readonly byRole: Record<string, KvGroupStats>;
}

export interface SwarmTrajectoryRollupOptions {
  /** Where the swarm-level JSONL goes; defaults to an in-memory sink. */
  readonly sink?: TrajectorySink;
  /** Stable clock for tests; defaults to real time. */
  readonly now?: () => Date;
}

/** Completion tokens are not part of KvAnalysis, so they are summed here. */
function completionTokensOf(text: string): number {
  let total = 0;
  for (const event of parseTrajectory(text)) {
    if (event.type !== "exchange") continue;
    const usage = (event as ExchangeEvent).usage;
    if (usage && typeof usage.completionTokens === "number" && Number.isFinite(usage.completionTokens)) {
      total += Math.max(0, usage.completionTokens);
    }
  }
  return total;
}

/** Aggregates one slot's trajectory into its summary record. */
export function summarizeSlot(input: SlotTrajectoryInput, at: string): SlotTrajectorySummary {
  if (!input.slotId.trim()) throw new Error("trajectory rollup requires a non-empty slotId");
  const analysis = analyzeTrajectory(input.trajectory);
  return {
    type: "slot",
    at,
    slotId: input.slotId,
    jobId: input.jobId ?? null,
    calls: analysis.calls,
    promptTokens: analysis.promptTokens,
    completionTokens: completionTokensOf(input.trajectory),
    cachedTokens: analysis.cachedTokens,
    hitRate: analysis.hitRate,
    fullyCached: Object.values(analysis.byModel).reduce((sum, bucket) => sum + bucket.fullyCached, 0),
    coldCalls: Object.values(analysis.byModel).reduce((sum, bucket) => sum + bucket.coldCalls, 0),
    uncachedPromptTokens: analysis.uncachedPromptTokens,
  };
}

/** Sums two cache buckets and recomputes the merged hit rate. */
function mergeBucket(into: KvGroupStats, from: KvGroupStats): KvGroupStats {
  const merged: KvGroupStats = {
    calls: into.calls + from.calls,
    promptTokens: into.promptTokens + from.promptTokens,
    cachedTokens: into.cachedTokens + from.cachedTokens,
    hitRate: 0,
    fullyCached: into.fullyCached + from.fullyCached,
    coldCalls: into.coldCalls + from.coldCalls,
  };
  merged.hitRate = merged.promptTokens > 0 ? merged.cachedTokens / merged.promptTokens : 0;
  return merged;
}

const emptyBucket = (): KvGroupStats => ({ calls: 0, promptTokens: 0, cachedTokens: 0, hitRate: 0, fullyCached: 0, coldCalls: 0 });

function mergeBuckets(target: Record<string, KvGroupStats>, from: Record<string, KvGroupStats>): Record<string, KvGroupStats> {
  for (const [key, bucket] of Object.entries(from)) {
    target[key] = mergeBucket(target[key] ?? emptyBucket(), bucket);
  }
  return target;
}

/** Aggregates every slot into one swarm-level summary record. */
export function summarizeSwarm(inputs: readonly SlotTrajectoryInput[], at: string): SwarmTrajectorySummary {
  const slots = inputs.map((input) => summarizeSlot(input, at));
  const byModel: Record<string, KvGroupStats> = {};
  const byRole: Record<string, KvGroupStats> = {};
  for (const input of inputs) {
    const analysis = analyzeTrajectory(input.trajectory);
    mergeBuckets(byModel, analysis.byModel);
    mergeBuckets(byRole, analysis.byRole);
  }
  const promptTokens = slots.reduce((sum, slot) => sum + slot.promptTokens, 0);
  const cachedTokens = slots.reduce((sum, slot) => sum + slot.cachedTokens, 0);
  return {
    type: "swarm",
    at,
    slots: slots.length,
    calls: slots.reduce((sum, slot) => sum + slot.calls, 0),
    promptTokens,
    completionTokens: slots.reduce((sum, slot) => sum + slot.completionTokens, 0),
    cachedTokens,
    hitRate: promptTokens > 0 ? cachedTokens / promptTokens : 0,
    uncachedPromptTokens: slots.reduce((sum, slot) => sum + slot.uncachedPromptTokens, 0),
    coldSlots: slots.filter((slot) => slot.calls > 0 && slot.cachedTokens === 0).length,
    byModel,
    byRole,
  };
}

/**
 * Writes the swarm-level JSONL: one `slot` line per input (in input order)
 * followed by the `swarm` summary line. Returns the swarm summary.
 */
export class SwarmTrajectoryRollup {
  private readonly sink: TrajectorySink;
  private readonly now: () => Date;

  constructor(options: SwarmTrajectoryRollupOptions = {}) {
    this.sink = options.sink ?? memorySink();
    this.now = options.now ?? ((): Date => new Date());
  }

  rollup(inputs: readonly SlotTrajectoryInput[]): SwarmTrajectorySummary {
    const at = this.now().toISOString();
    const seen = new Set<string>();
    for (const input of inputs) {
      const key = `${input.slotId}\u0000${input.jobId ?? ""}`;
      if (seen.has(key)) throw new Error(`duplicate slot trajectory: ${input.slotId}${input.jobId ? ` (job ${input.jobId})` : ""}`);
      seen.add(key);
      this.sink.append(JSON.stringify(summarizeSlot(input, at)));
    }
    const swarm = summarizeSwarm(inputs, at);
    this.sink.append(JSON.stringify(swarm));
    return swarm;
  }

  /** The JSONL written so far (slot lines then the swarm line). */
  text(): string {
    return this.sink.read();
  }
}

/** Parse the rollup output back into typed records, skipping blank lines. */
export function parseRollup(text: string): (SlotTrajectorySummary | SwarmTrajectorySummary)[] {
  const records: (SlotTrajectorySummary | SwarmTrajectorySummary)[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object") {
      const type = (parsed as Record<string, unknown>).type;
      if (type === "slot" || type === "swarm") records.push(parsed as SlotTrajectorySummary | SwarmTrajectorySummary);
    }
  }
  return records;
}
