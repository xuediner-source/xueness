/** Goal lifecycle budgets use reported usage only; missing facts stay unknown. */
import { isDict, isPyIntValue, numericValue, pySlice } from "@xueness/contracts";
import { normalizeGoalBudget, sanitizeGoal } from "./goal.ts";
import type { Row } from "./delivery.ts";
export const goalInt = (v: unknown, fallback = 0): number => isPyIntValue(v) && Number(v) >= 0 && Number(v) <= 1e9 ? Number(v) : fallback;
export const goalNumber = (v: unknown, fallback = 0): number => { const n = numericValue(v); return typeof v !== "boolean" && n !== null && n >= 0 ? n : fallback; };
export const goalStamp = (): string => new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");
export function setGoalStatus(session: Row, goal: Row, status: string, action: string, reason = "", stamp = goalStamp()): Row {
  const runtime = { ...(isDict(goal.runtime) ? goal.runtime : {}) }; if (reason) runtime.reason = pySlice(reason, 500);
  const history = Array.isArray(goal.history) ? goal.history : [];
  const next = { ...goal, status, updatedAt: stamp, runtime, history: [...history, { action, at: stamp, source: "agent", ...(reason ? { text: pySlice(reason, 300) } : {}) }].slice(-20) };
  session.goal = next; return next;
}
export function goalStopped(probe?: () => boolean): boolean { try { return !!probe?.(); } catch { return true; } }
export function beforeGoalRun(session: Row, enabled: boolean, stamp = goalStamp()): Row {
  const goal = sanitizeGoal(session.goal);
  if (!enabled || !goal || goal.status !== "active") return { enabled: false, deadline_seconds: null };
  let budget: Row; try { budget = normalizeGoalBudget(goal.budget ?? null); } catch (e) { setGoalStatus(session, goal, "blocked", "blocked", "目标预算无效：" + (e as Error).message, stamp); return { enabled: false, stop: true, needs_save: true, deadline_seconds: null, reason: (e as Error).message }; }
  const runtime = { ...(isDict(goal.runtime) ? goal.runtime : {}) }, prior = goalNumber(runtime.elapsedSeconds), remaining = budget.maxWallSeconds == null ? null : Math.max(0, Number(budget.maxWallSeconds) - prior);
  if (budget.maxRounds != null && goalInt(runtime.rounds) >= Number(budget.maxRounds)) { setGoalStatus(session, goal, "budget_limited", "budget_limited", "已达到目标轮次上限。", stamp); return { enabled: false, stop: true, needs_save: true, deadline_seconds: remaining, reason: "已达到目标轮次上限。" }; }
  if (remaining !== null && remaining <= 0) { setGoalStatus(session, goal, "budget_limited", "budget_limited", "已达到目标累计用时上限。", stamp); return { enabled: false, stop: true, needs_save: true, deadline_seconds: 0, reason: "已达到目标累计用时上限。" }; }
  const tokenLimit = budget.maxTokens;
  if (tokenLimit != null && goalInt(runtime.reportedTokens) >= Number(tokenLimit)) { setGoalStatus(session, goal, "budget_limited", "budget_limited", "已达到目标 token 上限。", stamp); return { enabled: false, stop: true, needs_save: true, deadline_seconds: remaining, token_budget_remaining: 0, reason: "已达到目标 token 上限。" }; }
  Object.assign(runtime, { invocationElapsedBase: prior, providerUsageCursor: Array.isArray(session.provider_usage) ? session.provider_usage.length : 0, checkpointCursor: Array.isArray(session.context_checkpoints) ? session.context_checkpoints.length : 0, invocationElapsedSeconds: 0 });
  session.goal = { ...goal, runtime };
  return { enabled: true, deadline_seconds: remaining, ...(tokenLimit != null ? { token_budget_remaining: Math.max(0, Number(tokenLimit) - goalInt(runtime.reportedTokens)) } : {}) };
}
export function goalUsageTokens(usage: unknown): number | null {
  if (!isDict(usage)) return null;
  if (isPyIntValue(usage.total_tokens) && goalInt(usage.total_tokens, -1) >= 0) return Number(usage.total_tokens);
  const prompt = Object.hasOwn(usage, "prompt_tokens") ? usage.prompt_tokens : usage.input_tokens, completion = Object.hasOwn(usage, "completion_tokens") ? usage.completion_tokens : usage.output_tokens;
  return isPyIntValue(prompt) && goalInt(prompt, -1) >= 0 && isPyIntValue(completion) && goalInt(completion, -1) >= 0 ? Number(prompt) + Number(completion) : null;
}
export function newGoalReportedTokens(session: Row, runtime: Row): [number, boolean] {
  const usage = session.provider_usage, checkpoints = session.context_checkpoints, cursor = goalInt(runtime.providerUsageCursor), checkpointCursor = goalInt(runtime.checkpointCursor);
  let tokens = 0, complete = true, saw = false;
  if (Array.isArray(usage)) { const rows = usage.slice(cursor); saw = !!rows.length; for (const row of rows) { const count = goalUsageTokens(isDict(row) ? row.usage : null); if (count === null) complete = false; else tokens += count; } runtime.providerUsageCursor = usage.length; }
  if (Array.isArray(checkpoints)) { for (const row of checkpoints.slice(checkpointCursor)) { const count = goalUsageTokens(isDict(row) ? row.reportedUsage : null); if (count === null) complete = false; else tokens += count; } runtime.checkpointCursor = checkpoints.length; }
  if (!saw && !(Array.isArray(checkpoints) && checkpoints.length > checkpointCursor)) complete = false;
  return [tokens, complete];
}
