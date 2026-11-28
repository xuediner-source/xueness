import { get } from "../../xuenessBridge";

export type UsageToolOutcomeTotals = {
  calls: number; failed: number; avoidable: number;
  toolMs: number; failedToolMs: number; recoveryMs: number;
  protocolRepairs: number; protocolMs: number;
};

export type UsageToolOutcomes = {
  sessions: number;
  total: UsageToolOutcomeTotals;
  groups: { group: string; avoidable: boolean; failed: number; failedToolMs: number; recoveryMs: number }[];
  tools: { name: string; calls: number; failed: number }[];
  codes: { code: string; count: number }[];
  models: (UsageToolOutcomeTotals & { model: string })[];
};

export type UsageModelSummary = {
  model: string | null;
  protocol: "openai" | "anthropic" | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  requestCount: number;
  unknownRequests: number;
  costs: Record<string, number>;
};

export type UsageDailySummary = {
  date: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  requestCount: number;
  unknownRequests: number;
  costs: Record<string, number>;
  models: UsageModelSummary[];
};

/** 用量汇总。/api/usage?range=... */
export type UsageSummary = {
  range: string;
  totals: { sessions: number; steps: number; completed: number };
  series: { date: string; sessions: number; steps: number }[];
  updatedAt: string;
  tokens?: { input: number; output: number; total?: number; reportedRequests: number; unknownRequests: number };
  costs?: Record<string, number>;
  costSource?: string;
  dailyUsage?: UsageDailySummary[];
  models?: UsageModelSummary[];
  tokenActivity?: {
    activeDays: number;
    peakDayTokens: number;
    currentStreakDays: number;
    longestStreakDays: number;
  };
  /** Tool-call outcomes of the sessions active in the range (usage plugin). */
  toolOutcomes?: UsageToolOutcomes;
};

const DEFAULT_USAGE_RANGE = "7d";

/** GET /api/usage?range=7d|30d|all（默认 7d）。 */
export async function getUsage(range: string = DEFAULT_USAGE_RANGE): Promise<UsageSummary> {
  return get<UsageSummary>(`/api/usage?range=${encodeURIComponent(range)}`);
}
