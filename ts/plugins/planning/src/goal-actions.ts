import { isDict, pyUtcNow } from "@xueness/contracts";
import { GoalError, normalizeGoalBudget, sanitizeGoal } from "./goal.ts";
import type { Row } from "./delivery.ts";
export function transitionGoal(session: Row, action: string, enabled: (id: string) => boolean, source = "http"): Row {
  if (!enabled("planning")) throw new GoalError("plugin disabled or dependency unavailable: planning", 403);
  const goal = sanitizeGoal(session.goal);
  if (!goal || ["cleared", "complete", "achieved"].includes(String(goal.status))) throw new GoalError("该会话没有可暂停或继续的目标", 409);
  if (!["pause", "resume"].includes(action)) throw new GoalError("目标操作仅支持 pause 或 resume");
  if (action === "pause" && goal.status !== "active") throw new GoalError("只有进行中的目标可以暂停", 409);
  if (action === "resume" && !["paused", "blocked", "budget_limited"].includes(String(goal.status))) throw new GoalError("只有暂停、受阻或达到预算的目标可以继续", 409);
  const runtime: Row = { ...(isDict(goal.runtime) ? goal.runtime : {}) };
  if (action === "resume") {
    runtime.stagnantRounds = 0;
    delete runtime.lastFingerprint;
  }
  const stamp = pyUtcNow("seconds"), next: Row = { ...goal, status: action === "pause" ? "paused" : "active", runtime, updatedAt: stamp, history: [...goal.history as Row[], { action, at: stamp, source }].slice(-20) };
  delete next.verification; session.goal = next; return next;
}
export function updateGoalBudget(session: Row, budget: unknown, enabled: (id: string) => boolean, source = "http"): Row {
  if (!enabled("planning")) throw new GoalError("plugin disabled or dependency unavailable: planning", 403);
  if (!isDict(budget)) throw new GoalError('目标预算需要显式对象；使用 {} 清除上限');
  if (!["cli", "http", "composer", "agent"].includes(source)) throw new GoalError("未知的会话目标预算来源");
  const goal = sanitizeGoal(session.goal);
  if (!goal || ["cleared", "complete", "achieved"].includes(String(goal.status))) throw new GoalError("该会话没有可调整预算的目标", 409);
  const normalized = normalizeGoalBudget(budget);
  const stamp = pyUtcNow("seconds"), next: Row = { ...goal, budget: normalized, updatedAt: stamp, history: [...goal.history as Row[], { action: "budget", at: stamp, source }].slice(-20) };
  session.goal = next; return next;
}
export function clearGoal(session: Row, enabled: (id: string) => boolean, source = "http"): Row {
  if (!enabled("planning")) throw new GoalError("plugin disabled or dependency unavailable: planning", 403);
  const goal = sanitizeGoal(session.goal); if (!goal || goal.status === "cleared") throw new GoalError("该会话当前没有可清除的目标", 404);
  const stamp = pyUtcNow("seconds"), next = { ...goal, status: "cleared", updatedAt: stamp, history: [...goal.history as Row[], { action: "clear", at: stamp, source }].slice(-20) }; session.goal = next; return next;
}
