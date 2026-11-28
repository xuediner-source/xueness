/**
 * `/api/tool_judge/settings` (GET, POST) and `/api/tool_judge/stats` (GET).
 * Every other path is unowned. Disabled plugin: 403, as for other plugins.
 */
import { isDict } from "@xueness/contracts";
import { COUNTERS, type Totals } from "./stats.ts";
import { JudgeSettingsError, readJudgeSettings, writeJudgeSettings } from "./settings.ts";

type Row = Record<string, unknown>;
export const TOOL_JUDGE_HTTP_ROUTES = ["GET /api/tool_judge/settings", "POST /api/tool_judge/settings", "GET /api/tool_judge/stats"] as const;
const RANGES: Record<string, number | null> = { "7d": 7, "30d": 30, all: null };

export interface ToolJudgeHttpOptions {
  stateDir: string;
  enabled(id: string): boolean;
  /** Saved sessions with their modification time (seconds) and judge counters. */
  sessions(): Iterable<{ mtime: number; stats: unknown }>;
  now?: () => number;
}
export interface ToolJudgeHttp {
  routes: readonly string[];
  owns(method: string, parts: readonly string[]): boolean;
  dispatch(method: string, parts: readonly string[], query: Readonly<Record<string, unknown>>, data: unknown): Promise<[number, Row] | null>;
}

const finite = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0);

/** Sum of the judge counters of sessions changed since `cutoff` (seconds), or of all sessions. */
export function aggregateJudgeStats(sessions: Iterable<{ mtime: number; stats: unknown }>, cutoff: number | null): Row | null {
  const total = Object.fromEntries(COUNTERS.map((key) => [key, 0])) as Totals;
  const models = new Map<string, { requests: number; judged: number; judgeMs: number; failures: number }>();
  let count = 0;
  for (const { mtime, stats } of sessions) {
    if (cutoff !== null && mtime < cutoff) continue;
    if (!isDict(stats) || stats.version !== 1 || !isDict(stats.total)) continue;
    count += 1;
    for (const key of COUNTERS) total[key] += finite(stats.total[key]);
    if (isDict(stats.models)) for (const [name, row] of Object.entries(stats.models)) {
      if (!isDict(row)) continue;
      const entry = models.get(name) ?? { requests: 0, judged: 0, judgeMs: 0, failures: 0 };
      entry.requests += finite(row.requests); entry.judged += finite(row.judged); entry.judgeMs += finite(row.judgeMs); entry.failures += finite(row.failures);
      models.set(name, entry);
    }
  }
  if (!count) return null;
  return { sessions: count, total, models: [...models].map(([model, row]) => ({ model, ...row })).sort((a, b) => b.judged - a.judged).slice(0, 12) };
}

export function createToolJudgeHttp(options: ToolJudgeHttpOptions): ToolJudgeHttp {
  const owns = (_method: string, parts: readonly string[]): boolean => parts.length === 3 && parts[0] === "api" && parts[1] === "tool_judge" && (parts[2] === "settings" || parts[2] === "stats");
  return {
    routes: TOOL_JUDGE_HTTP_ROUTES,
    owns,
    async dispatch(method, parts, query, data) {
      if (!owns(method, parts)) return null;
      if (!options.enabled("tool_judge")) return [403, { error: "plugin disabled or dependency unavailable: tool_judge", plugin: "tool_judge" }];
      const verb = (method || "").toUpperCase();
      if (parts[2] === "stats") {
        if (verb !== "GET") return [405, { error: "仅支持 GET。" }];
        // Query values arrive as string arrays (`?range=7d` is `["7d"]`).
        const requested: unknown = Array.isArray(query.range) ? query.range[0] : query.range;
        const range = typeof requested === "string" && Object.hasOwn(RANGES, requested) ? requested : "30d";
        const days = RANGES[range] ?? null;
        const now = options.now?.() ?? Date.now() / 1000;
        return [200, { range, stats: aggregateJudgeStats(options.sessions(), days === null ? null : now - days * 86_400) }];
      }
      try {
        if (verb === "GET") return [200, { settings: readJudgeSettings(options.stateDir) }];
        if (verb === "POST") return [200, { settings: writeJudgeSettings(options.stateDir, data) }];
      } catch (error) {
        if (error instanceof JudgeSettingsError) return [400, { error: error.message }];
        if (error instanceof Error && typeof (error as NodeJS.ErrnoException).code === "string") return [500, { error: "无法读写工具调用判定设置，请检查本地目录权限。" }];
        throw error;
      }
      return [405, { error: "仅支持 GET 和 POST。" }];
    },
  };
}
