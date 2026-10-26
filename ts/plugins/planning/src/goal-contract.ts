/**
 * Unified goal continuation & stop contract (C-WFL-03). Every post-run
 * outcome — budget, verification, pause, completion, proactive continue and
 * the termination reason — is expressed as one decision shape so the runner
 * can treat a terminal stop as final for the whole run.
 */
import type { RunDecision } from "@xueness/agent";
import { isDict, pySlice } from "@xueness/contracts";
import { sanitizeGoal } from "./goal.ts";
import type { Row } from "./delivery.ts";

export type GoalStopCode = "complete" | "budget_limited" | "paused" | "blocked" | "waiting_user" | "boundary" | "changed" | "unavailable";
export type GoalDecision = RunDecision & { stopCode?: GoalStopCode; kind?: "goal_continuation"; reason?: string };

export function goalStopDecision(code: GoalStopCode, reason: string): GoalDecision {
  return { action: "stop", prompt: "", reason: pySlice(reason, 500), stopCode: code };
}
export function goalContinueDecision(prompt: string, reason: string): GoalDecision {
  return { action: "continue", prompt, reason: pySlice(reason, 500), exclusive: true, kind: "goal_continuation" };
}

const WAITING = /等待用户回答|等待批准|已停止、暂停/;
/** Maps a settled goal-driver row onto the unified contract without altering it. */
export function goalDecisionFromRun(session: Row, row: Row): GoalDecision {
  if (row.action === "continue") return goalContinueDecision(String(row.prompt ?? ""), String(row.reason ?? ""));
  const goal = sanitizeGoal(session.goal), status = goal ? String(goal.status) : "";
  if (status === "complete") return goalStopDecision("complete", String(row.reason ?? ""));
  if (status === "budget_limited") return goalStopDecision("budget_limited", String(row.reason ?? ""));
  if (status === "paused") return goalStopDecision("paused", String(row.reason ?? ""));
  if (status === "blocked") return goalStopDecision("blocked", String(row.reason ?? ""));
  const reason = String(row.reason ?? "");
  if (WAITING.test(reason)) return goalStopDecision("waiting_user", reason);
  if (reason.includes("未到可核验的最终回答边界") || reason.includes("需要复核")) return goalStopDecision("boundary", reason);
  if (reason.includes("不可用")) return goalStopDecision("unavailable", reason);
  if (reason.includes("没有有效目标") || reason.includes("目标已变化") || reason.includes("未处于进行中")) return goalStopDecision("changed", reason);
  return goalStopDecision("boundary", reason);
}
/** The terminal stop code a runner should honor for the rest of the run, if any. */
export function decisionStopCode(decision: RunDecision | void): GoalStopCode | null {
  if (!decision || decision.action !== "stop") return null;
  const code = (decision as GoalDecision).stopCode;
  return typeof code === "string" && code ? code : "boundary";
}
/** Stop codes after which the goal must never schedule another round. */
export const GOAL_TERMINAL_STOPS: ReadonlySet<string> = new Set(["complete", "budget_limited", "paused", "blocked", "changed", "unavailable"]);
/** Budget exhaustion and user pauses are always terminal; waiting/boundary stops may resume later. */
export function stopCodeIsTerminal(code: GoalStopCode | string | null): boolean {
  return code !== null && GOAL_TERMINAL_STOPS.has(code);
}
/**
 * Journals the unified termination reason onto the persisted goal so a stop
 * survives the run: runtime.stopCode/stopReason/stoppedAt. Never changes goal
 * status — the driver already settled that — and continuation decisions and
 * non-terminal stops leave the runtime untouched.
 */
export function journalGoalStop(session: Row, decision: GoalDecision, stamp: string): boolean {
  if (decision.action !== "stop") return false;
  const code = decision.stopCode ?? "boundary";
  if (!stopCodeIsTerminal(code)) return false;
  const goal = sanitizeGoal(session.goal);
  if (!goal || goal.status === "active") return false;
  const runtime = { ...(isDict(goal.runtime) ? goal.runtime : {}) };
  runtime.stopCode = code; runtime.stopReason = decision.reason ?? ""; runtime.stoppedAt = stamp;
  session.goal = { ...goal, runtime };
  return true;
}
