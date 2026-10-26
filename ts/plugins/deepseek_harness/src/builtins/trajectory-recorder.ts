/**
 * H02.06 — Trajectory recording and KV prefix-cache hit analysis.
 *
 * `TrajectoryRecorder` appends one JSON object per line (JSONL) describing
 * every model exchange of a harness session — solver/critic calls, prompts,
 * and DeepSeek-style usage with the cached (KV prefix-cache hit) token count.
 * `analyzeTrajectory` reads the JSONL back and aggregates cache hit-rate per
 * model and per role, so prefix-stability of prompts can be measured rather
 * than assumed.
 */

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

import type { TokenUsage } from "./critic-solver.ts";

/** One JSONL record; `type` discriminates the event kinds. */
export interface TrajectoryEvent {
  type: "session" | "exchange" | "verdict";
  /** ISO timestamp of the record. */
  at: string;
  session: string;
}

export interface SessionEvent extends TrajectoryEvent {
  type: "session";
  task: string;
  solverModel: string;
  criticModel: string;
}

export interface ExchangeEvent extends TrajectoryEvent {
  type: "exchange";
  round: number;
  role: string;
  modelId: string;
  callIndex: number;
  prompt: string;
  response: string;
  usage: TokenUsage;
}

export interface VerdictEvent extends TrajectoryEvent {
  type: "verdict";
  round: number;
  verdict: "accept" | "reject";
  path: string | null;
}

export type AnyTrajectoryEvent = SessionEvent | ExchangeEvent | VerdictEvent;

/** Where lines go; defaults to an in-memory buffer (tests, dry runs). */
export interface TrajectorySink {
  append(line: string): void;
  read(): string;
}

export const memorySink = (): TrajectorySink => {
  let text = "";
  return { append: (line) => { text += line + "\n"; }, read: () => text };
};

export const fileSink = (path: string): TrajectorySink => ({
  append: (line) => void appendFileSync(path, line + "\n"),
  read: () => readFileSync(path, "utf8"),
});

export interface TrajectoryRecorderOptions {
  session: string;
  sink?: TrajectorySink;
  /** Stable clock for tests; defaults to real time. */
  now?: () => Date;
}

/** Serializes harness events to a JSONL sink. */
export class TrajectoryRecorder {
  readonly session: string;
  private readonly sink: TrajectorySink;
  private readonly now: () => Date;
  private closed = false;

  constructor(options: TrajectoryRecorderOptions) {
    if (!options.session.trim()) throw new Error("trajectory recorder requires a session id");
    this.session = options.session;
    this.sink = options.sink ?? memorySink();
    this.now = options.now ?? ((): Date => new Date());
  }

  private write(event: Omit<AnyTrajectoryEvent, "at" | "session">): void {
    if (this.closed) throw new Error("trajectory recorder is closed");
    const row = { ...event, at: this.now().toISOString(), session: this.session } as AnyTrajectoryEvent;
    this.sink.append(JSON.stringify(row));
  }

  sessionStarted(event: Omit<SessionEvent, "type" | "at" | "session">): void {
    this.write({ type: "session", ...event });
  }

  exchange(event: Omit<ExchangeEvent, "type" | "at" | "session">): void {
    this.write({ type: "exchange", ...event });
  }

  verdict(event: Omit<VerdictEvent, "type" | "at" | "session">): void {
    this.write({ type: "verdict", ...event });
  }

  close(): string {
    this.closed = true;
    return this.sink.read();
  }
}

/** Convenience: a recorder bound to a file path (state-rooted by the host). */
export function fileTrajectoryRecorder(path: string, session: string): TrajectoryRecorder {
  writeFileSync(path, "");
  return new TrajectoryRecorder({ session, sink: fileSink(path) });
}

export interface KvCallStats {
  callIndex: number;
  promptTokens: number;
  cachedTokens: number;
  /** cachedTokens / promptTokens, 0 when the call had no prompt tokens. */
  hitRate: number;
}

export interface KvGroupStats {
  calls: number;
  promptTokens: number;
  cachedTokens: number;
  hitRate: number;
  /** Calls whose reported cached tokens cover the whole prompt. */
  fullyCached: number;
  /** Calls reporting no cache hit at all. */
  coldCalls: number;
}

export interface KvAnalysis {
  calls: number;
  promptTokens: number;
  cachedTokens: number;
  /** Overall cached/prompt ratio across all exchange events. */
  hitRate: number;
  byModel: Record<string, KvGroupStats>;
  byRole: Record<string, KvGroupStats>;
  callsList: KvCallStats[];
  /** Missed savings estimate: prompt tokens that were not served from cache. */
  uncachedPromptTokens: number;
}

const group = (): KvGroupStats => ({ calls: 0, promptTokens: 0, cachedTokens: 0, hitRate: 0, fullyCached: 0, coldCalls: 0 });

function addTo(bucket: KvGroupStats, promptTokens: number, cachedTokens: number): void {
  bucket.calls += 1;
  bucket.promptTokens += promptTokens;
  bucket.cachedTokens += cachedTokens;
  if (promptTokens > 0 && cachedTokens >= promptTokens) bucket.fullyCached += 1;
  if (cachedTokens === 0) bucket.coldCalls += 1;
}

const finalize = (bucket: KvGroupStats): KvGroupStats => ({
  ...bucket,
  hitRate: bucket.promptTokens > 0 ? bucket.cachedTokens / bucket.promptTokens : 0,
});

function numberField(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** Parse JSONL text into events, skipping blank/corrupt lines. */
export function parseTrajectory(text: string): AnyTrajectoryEvent[] {
  const events: AnyTrajectoryEvent[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const type = (parsed as Record<string, unknown>).type;
        if (type === "session" || type === "exchange" || type === "verdict") events.push(parsed as AnyTrajectoryEvent);
      }
    } catch { /* a torn line is skipped, not fatal */ }
  }
  return events;
}

/** Aggregate KV cache hit-rate over the exchange events of a trajectory. */
export function analyzeTrajectory(text: string): KvAnalysis {
  const byModel: Record<string, KvGroupStats> = {};
  const byRole: Record<string, KvGroupStats> = {};
  const total = group();
  const callsList: KvCallStats[] = [];
  for (const event of parseTrajectory(text)) {
    if (event.type !== "exchange") continue;
    const usage = (event as ExchangeEvent).usage ?? ({} as TokenUsage);
    const promptTokens = numberField(usage.promptTokens);
    const cachedTokens = numberField(usage.cachedTokens);
    const call: KvCallStats = {
      callIndex: (event as ExchangeEvent).callIndex,
      promptTokens,
      cachedTokens,
      hitRate: promptTokens > 0 ? Math.min(cachedTokens / promptTokens, 1) : 0,
    };
    callsList.push(call);
    addTo(total, promptTokens, cachedTokens);
    const modelBucket = byModel[(event as ExchangeEvent).modelId] ?? (byModel[(event as ExchangeEvent).modelId] = group());
    addTo(modelBucket, promptTokens, cachedTokens);
    const roleBucket = byRole[(event as ExchangeEvent).role] ?? (byRole[(event as ExchangeEvent).role] = group());
    addTo(roleBucket, promptTokens, cachedTokens);
  }
  return {
    calls: total.calls,
    promptTokens: total.promptTokens,
    cachedTokens: total.cachedTokens,
    hitRate: finalize(total).hitRate,
    byModel: Object.fromEntries(Object.entries(byModel).map(([key, value]) => [key, finalize(value)])),
    byRole: Object.fromEntries(Object.entries(byRole).map(([key, value]) => [key, finalize(value)])),
    callsList,
    uncachedPromptTokens: Math.max(total.promptTokens - total.cachedTokens, 0),
  };
}
