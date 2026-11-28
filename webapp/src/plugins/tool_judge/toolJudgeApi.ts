import { get, post } from "../../xuenessApi";

export type JudgeProfile = { providerId: string; model: string } | null;
export type JudgeSettings = {
  v: 1; profile: JudgeProfile; preflightEnabled: boolean; applyRepairs: boolean; applyRejects: boolean; timeoutMs: number; maxOutputTokens: number;
};
export type JudgeRange = "7d" | "30d" | "all";
export type JudgeTotals = {
  judged: number; requests: number; failures: number; judgeMs: number;
  pass: number; advise: number; repair: number; reject: number; unavailable: number;
  repairsApplied: number; repairsSucceeded: number; rejectsApplied: number; wrongBlocks: number;
  passFailures: number; passAvoidableFailures: number; preflightBlocked: number;
};
export type JudgeModelRow = { model: string; requests: number; judged: number; judgeMs: number; failures: number };
export type JudgeStats = { sessions: number; total: JudgeTotals; models: JudgeModelRow[] };

export const readJudgeSettings = async (): Promise<JudgeSettings> =>
  (await get<{ settings: JudgeSettings }>("/api/tool_judge/settings")).settings;

export const saveJudgeSettings = async (patch: Partial<Omit<JudgeSettings, "v">>): Promise<JudgeSettings> =>
  (await post<{ settings: JudgeSettings }>("/api/tool_judge/settings", patch)).settings;

export const readJudgeStats = async (range: JudgeRange): Promise<JudgeStats | null> =>
  (await get<{ range: string; stats: JudgeStats | null }>(`/api/tool_judge/stats?range=${range}`)).stats;

export type JudgeVerdict = "pass" | "advise" | "repair" | "reject" | "unavailable";
export type JudgeRecord = {
  verdict: JudgeVerdict; applied: "none" | "note" | "repaired" | "rejected"; reason: string;
  original?: Record<string, unknown>; judgeMs: number; model: string; retryOfReject?: boolean; outcome?: "ok" | "failed";
};

const VERDICTS = new Set(["pass", "advise", "repair", "reject", "unavailable"]);

/** Narrow the untyped `row.judge` the timeline copies from the session journal. */
export function asJudgeRecord(value: unknown): JudgeRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.verdict !== "string" || !VERDICTS.has(record.verdict)) return null;
  const original = record.original && typeof record.original === "object" && !Array.isArray(record.original)
    ? record.original as Record<string, unknown> : undefined;
  return {
    verdict: record.verdict as JudgeVerdict,
    applied: record.applied === "note" || record.applied === "repaired" || record.applied === "rejected" ? record.applied : "none",
    reason: typeof record.reason === "string" ? record.reason : "",
    ...(original ? { original } : {}),
    judgeMs: typeof record.judgeMs === "number" ? record.judgeMs : 0,
    model: typeof record.model === "string" ? record.model : "",
    ...(record.retryOfReject === true ? { retryOfReject: true } : {}),
    ...(record.outcome === "ok" || record.outcome === "failed" ? { outcome: record.outcome } : {}),
  };
}
