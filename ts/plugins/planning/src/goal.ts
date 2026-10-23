/** planning.session_goal's pure staging; no session is persisted here. */
import { createHash, randomUUID } from "node:crypto";
import { isDict, isPyIntValue, numericValue, pyLen, pySlice, pyStr, pyStrip, pyUtcNow, PyValueError } from "@xueness/contracts";
type Row = Record<string, unknown>;
const STATUSES = ["active", "paused", "blocked", "budget_limited", "complete", "achieved", "cleared"];
const GOAL_ID = /^[a-f0-9]{32}$/;
const legacyGoalId = (text: string, setAt: string): string => createHash("sha256").update(text, "utf8").update("\0").update(setAt, "utf8").digest("hex").slice(0, 32);
export function goalSummaryTitle(text: string): string {
  const first = (text.split(/\r?\n/, 1)[0] ?? text).replace(/\s+/gu, " ").trim();
  const points = Array.from(first);
  return points.length > 80 ? points.slice(0, 79).join("") + "…" : first;
}
export class GoalError extends PyValueError { override name = "GoalError"; readonly status: number; constructor(message: string, status = 400) { super(message); this.status = status; } }
export function sanitizeGoal(raw: unknown): Row | null {
  if (!isDict(raw) || typeof raw.text !== "string" || !pyStrip(raw.text) || pyLen(raw.text) > 5000 || !STATUSES.includes(String(raw.status))) return null;
  const history: Row[] = [];
  for (const entry of Array.isArray(raw.history) ? raw.history : []) {
    if (!isDict(entry) || !["set", "replace", "clear", "achieved", "complete", "pause", "resume", "blocked", "budget_limited", "budget"].includes(String(entry.action))) continue;
    const item: Row = { action: entry.action, at: pySlice(pyStr(entry.at ?? ""), 40) };
    for (const key of ["text", "source"]) if (typeof entry[key] === "string" && entry[key]) item[key] = pySlice(entry[key], key === "text" ? 300 : 20);
    history.push(item);
  }
  const text = pyStrip(raw.text), setAt = pySlice(pyStr(raw.setAt ?? ""), 40);
  const id = typeof raw.id === "string" && GOAL_ID.test(raw.id) ? raw.id : legacyGoalId(text, setAt);
  const summaryTitle = typeof raw.summaryTitle === "string" && pyStrip(raw.summaryTitle) ? pySlice(pyStrip(raw.summaryTitle), 80) : goalSummaryTitle(text);
  const result: Row = { id, text, summaryTitle, status: raw.status, setAt, updatedAt: pySlice(pyStr(raw.updatedAt ?? ""), 40), history: history.slice(-20) };
  if (isDict(raw.budget)) result.budget = Object.fromEntries(Object.entries(raw.budget).filter(([key, v]) => ["maxRounds", "maxWallSeconds", "maxTokens"].includes(key) && isPyIntValue(v) && Number(v) > 0));
  if (isDict(raw.runtime)) {
    const runtime: Row = {}, r = raw.runtime;
    for (const key of ["rounds", "reportedTokens", "stagnantRounds", "providerUsageCursor", "checkpointCursor"]) if (isPyIntValue(r[key]) && Number(r[key]) >= 0 && Number(r[key]) <= 1e9) runtime[key] = r[key];
    for (const key of ["elapsedSeconds", "invocationElapsedBase", "invocationElapsedSeconds"]) { const n = numericValue(r[key]); if (typeof r[key] !== "boolean" && n !== null && n >= 0 && n <= 1e9) runtime[key] = r[key]; }
    for (const key of ["invocationStartedAt", "lastFingerprint", "reason"]) if (typeof r[key] === "string") runtime[key] = pySlice(r[key], 500);
    for (const key of ["seenUsage", "seenTurns"]) if (Array.isArray(r[key])) runtime[key] = r[key].slice(-1024).filter((v): v is string => typeof v === "string").map((v) => pySlice(v, 150));
    if (typeof r.usageComplete === "boolean") runtime.usageComplete = r.usageComplete;
    result.runtime = runtime;
  }
  if (isDict(raw.verification)) {
    const v = raw.verification;
    const safe: Row = Object.fromEntries(Object.entries(v).filter(([key, value]) => ["passed", "summaryHash", "turnId", "at", "kind"].includes(key) && (key === "passed" ? typeof value === "boolean" : typeof value === "string")));
    if (typeof v.reason === "string") safe.reason = pySlice(v.reason, 1200);
    for (const key of ["evidenceIds", "remaining"]) if (Array.isArray(v[key])) safe[key] = v[key].slice(0, 24).filter((x): x is string => typeof x === "string").map((x) => pySlice(x, key === "evidenceIds" ? 150 : 500));
    result.verification = safe;
  }
  return result;
}
export function publicGoal(session: Row): Row | null { const goal = sanitizeGoal(session.goal); return goal?.status === "cleared" ? null : goal; }
export function normalizeGoalBudget(raw: unknown = null): Row {
  // ZCode goals run until verified or stopped: no default round or wall-time budget.
  if (raw === null) return {};
  if (!isDict(raw) || Object.keys(raw).some((k) => !["maxRounds", "maxWallSeconds", "maxTokens"].includes(k))) throw new GoalError("目标预算仅支持 maxRounds、maxWallSeconds 和 maxTokens");
  const result: Row = {}, bounds: Record<string, [number, number]> = { maxRounds: [1, 64], maxWallSeconds: [1, 3600], maxTokens: [128, 10000000] };
  for (const [key, v] of Object.entries(raw)) { const [low, high] = bounds[key]!; if (!isPyIntValue(v) || Number(v) < low || Number(v) > high) throw new GoalError(`${key} 必须是 ${low}..${high} 的整数`); result[key] = v; }
  return result;
}
export function stageGoal(session: Row, text: unknown, options: { enabled(id: string): boolean; replace?: boolean; source?: string; budget?: unknown }): Row {
  if (!options.enabled("planning")) throw new GoalError("plugin disabled or dependency unavailable: planning", 403);
  if (typeof text !== "string" || !pyStrip(text)) throw new GoalError("会话目标需要 1..5000 个字符的非空文本");
  if (pyLen(text) > 5000) throw new GoalError("会话目标最长 5000 个字符");
  const source = options.source ?? "cli";
  if (!["cli", "http", "composer", "agent"].includes(source)) throw new GoalError("未知的会话目标设置来源");
  const budget = normalizeGoalBudget(options.budget ?? null), existing = sanitizeGoal(session.goal), objective = pyStrip(text);
  if (existing && existing.status !== "cleared" && !options.replace) throw new GoalError("该会话已有目标，确认替换后再覆盖：CLI 用 --target-replace 或 goal replace，HTTP 传 replace=true", 409);
  const now = pyUtcNow("seconds");
  const goal: Row = { id: randomUUID().replaceAll("-", ""), text: objective, summaryTitle: goalSummaryTitle(objective), status: "active", setAt: now, updatedAt: now, history: [...(existing?.history as Row[] ?? []), { action: existing ? "replace" : "set", text: pySlice(objective, 300), at: now, source }].slice(-20), budget, runtime: { rounds: 0, reportedTokens: 0, elapsedSeconds: 0, stagnantRounds: 0, seenUsage: [], seenTurns: [] } };
  session.goal = goal; return goal;
}
