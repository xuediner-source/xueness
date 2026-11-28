/**
 * Verdict records and counters kept in the session, so the judge has to prove
 * it helps (owner decision: it earns its place with numbers).
 *
 * `session.tool_judge` holds the per-call verdicts the tool card shows and the
 * calls rejected once; `session.tool_judge_stats` holds bounded counters in the
 * style of `providers` tool outcomes. Both are capped so long sessions stay small.
 */
import { isDict } from "@xueness/contracts";
import type { Applied, Verdict } from "./verdicts.ts";

type Row = Record<string, unknown>;
const CALLS_MAX = 300, REJECTED_MAX = 100, MODELS_MAX = 20;

export interface VerdictRecord {
  v: 1; at: string; tool: string; verdict: Verdict | "unavailable"; applied: Applied; reason: string;
  original?: Row; judgeMs: number; model: string; sig: string; retryOfReject?: boolean; preflightRule?: string;
  /** Filled in when the call finished. */
  outcome?: "ok" | "failed";
}

export const COUNTERS = ["judged", "requests", "failures", "judgeMs", "pass", "advise", "repair", "reject", "unavailable",
  "repairsApplied", "repairsSucceeded", "rejectsApplied", "wrongBlocks", "passFailures", "passAvoidableFailures", "preflightBlocked"] as const;
export type Counter = (typeof COUNTERS)[number];
export type Totals = Record<Counter, number>;
const zero = (): Totals => Object.fromEntries(COUNTERS.map((key) => [key, 0])) as Totals;

function store(session: Row): { calls: Record<string, VerdictRecord>; rejected: Record<string, string> } {
  const current = isDict(session.tool_judge) ? session.tool_judge : {};
  const calls = isDict(current.calls) ? current.calls as Record<string, VerdictRecord> : {};
  const rejected = isDict(current.rejected) ? current.rejected as Record<string, string> : {};
  session.tool_judge = { v: 1, calls, rejected };
  return { calls, rejected };
}

function trim<T>(map: Record<string, T>, max: number): void {
  const keys = Object.keys(map);
  for (const key of keys.slice(0, Math.max(0, keys.length - max))) delete map[key];
}

export function recordVerdict(session: Row, callId: string, record: VerdictRecord): void {
  const { calls } = store(session);
  delete calls[callId];
  calls[callId] = record;
  trim(calls, CALLS_MAX);
}

export function verdictFor(session: Row, callId: string): VerdictRecord | null {
  const current = isDict(session.tool_judge) && isDict(session.tool_judge.calls) ? session.tool_judge.calls[callId] : null;
  return isDict(current) ? current as unknown as VerdictRecord : null;
}

/** A call the judge stopped: "rejected" until it is repeated, then "retried". Either way it is never stopped again. */
export function rejectState(session: Row, sig: string): "rejected" | "retried" | null {
  const value = isDict(session.tool_judge) && isDict(session.tool_judge.rejected) ? session.tool_judge.rejected[sig] : null;
  return typeof value === "string" ? (value.startsWith("retried:") ? "retried" : "rejected") : null;
}

export function markRejected(session: Row, sig: string, state: "rejected" | "retried" = "rejected"): void {
  const { rejected } = store(session);
  rejected[sig] = `${state}:${new Date().toISOString()}`;
  trim(rejected, REJECTED_MAX);
}

/** Bounded counters: totals plus a per-model breakdown of judge requests. */
export class JudgeStatsRecorder {
  #stats(session: Row): { total: Totals; models: Record<string, { requests: number; judged: number; judgeMs: number; failures: number }> } {
    const current = isDict(session.tool_judge_stats) && session.tool_judge_stats.version === 1 ? session.tool_judge_stats : null;
    const total = zero();
    if (current && isDict(current.total)) for (const key of COUNTERS) { const value = current.total[key]; if (typeof value === "number" && Number.isFinite(value) && value >= 0) total[key] = value; }
    const models = current && isDict(current.models) ? current.models as Record<string, { requests: number; judged: number; judgeMs: number; failures: number }> : {};
    session.tool_judge_stats = { version: 1, updatedAt: new Date().toISOString(), total, models };
    return { total, models };
  }

  add(session: Row, key: Counter, amount = 1): void {
    const { total } = this.#stats(session);
    total[key] += Math.max(0, amount);
  }

  request(session: Row, model: string, judged: number, ms: number, ok: boolean): void {
    const { total, models } = this.#stats(session);
    total.requests += 1; total.judgeMs += Math.round(ms); total.judged += judged;
    if (!ok) total.failures += 1;
    const name = model.slice(0, 120) || "(unknown)";
    if (!models[name] && Object.keys(models).length >= MODELS_MAX) return;
    const row = models[name] ??= { requests: 0, judged: 0, judgeMs: 0, failures: 0 };
    row.requests += 1; row.judged += judged; row.judgeMs += Math.round(ms); if (!ok) row.failures += 1;
  }

  /** How a judged call turned out, attributed to what the judge said about it. */
  outcome(session: Row, record: VerdictRecord, failed: boolean, avoidable: boolean): void {
    if (record.applied === "repaired" && !failed) this.add(session, "repairsSucceeded");
    if (record.retryOfReject && !failed) this.add(session, "wrongBlocks");
    if (record.verdict === "pass" && failed) { this.add(session, "passFailures"); if (avoidable) this.add(session, "passAvoidableFailures"); }
  }
}
