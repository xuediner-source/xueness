import { createHash } from "node:crypto";
import { isDict, pyLen, pySlice, pyStrip } from "@xueness/contracts";
import { sanitizeGoal } from "./goal.ts";
import type { Row } from "./delivery.ts";
import { goalStamp } from "./goal-runtime.ts";
export const goalSummaryHash = (summary: string): string => createHash("sha256").update(summary, "utf8").digest("hex");
export function goalReminder(session: Row): string {
  const goal = sanitizeGoal(session.goal); if (!goal || goal.status !== "active") return "";
  const prefix = "会话目标：", suffix = "（持久目标，跨轮有效。完成前对照全部要求与约束，提供实际交付和验证事实；「目标已完成」等措辞不能替代核验。尚未达成请继续，受阻请说明原因。）";
  const budget = Math.max(1, 600 - pyLen(prefix) - pyLen(suffix)), text = goal.text as string;
  return prefix + (pyLen(text) <= budget ? text : pyStrip(pySlice(text, budget - 1)) + "…") + suffix;
}
export function verifyGoalCompletion(session: Row, summary: string): Row | null {
  const goal = sanitizeGoal(session.goal); if (!goal || goal.status !== "active") return null;
  const verification = isDict(goal.verification) ? goal.verification : {}, passed = verification.passed === true && verification.summaryHash === goalSummaryHash(summary || ""), missing = passed ? [] : ["会话目标等待独立核验：完成声明不能代替交付与实际验证。"];
  return { status: passed ? "passed" : "not_assessed", items: [{ id: "session_goal", label: "会话目标：" + pySlice(goal.text as string, 300), path: null, contains: [], min_links: 0, passed, missing }], reason: passed ? "" : missing[0], goal: { status: passed ? "complete" : "active", text: pySlice(goal.text as string, 300) } };
}
export function mergeGoalCompletion(delivery: Row, goal: Row | null): Row {
  if (!goal) return delivery;
  const ranks = ["passed", "not_assessed", "failed"], status = ranks[Math.max(ranks.indexOf(String(delivery.status ?? "not_assessed")), ranks.indexOf(String(goal.status)))]!;
  const merged: Row = { ...delivery, status, items: [...Array.isArray(delivery.items) ? delivery.items : [], ...goal.items as Row[]], goal: goal.goal };
  const reason = goal.status === "failed" ? goal.reason : delivery.reason; if (reason) merged.reason = reason; else delete merged.reason; return merged;
}
export function finishGoalCompletionCheck(session: Row, goal: Row, summary: string, stamp = goalStamp(), kind = "independent_model_verifier"): void {
  if (!isDict(session.completion)) return;
  const completion = session.completion;
  goal.verification = { passed: true, summaryHash: goalSummaryHash(summary), turnId: completion.turn_id ?? null, at: stamp, kind };
  if (!isDict(completion.delivery_checks)) completion.delivery_checks = {};
  const checks = completion.delivery_checks as Row;
  if (!isDict(checks.planning)) checks.planning = { status: "not_assessed", items: [] };
  const planning = checks.planning as Row; if (!Array.isArray(planning.items)) planning.items = [];
  const items = planning.items as Row[]; let item = items.find((row) => isDict(row) && row.id === "session_goal");
  if (!item) { item = { id: "session_goal", label: "会话目标：" + pySlice(goal.text as string, 300), path: null, contains: [], min_links: 0 }; items.push(item); }
  Object.assign(item, { passed: true, missing: [] });
  if (!items.filter(isDict).some((row) => row.passed === false)) { planning.status = "passed"; delete planning.reason; }
}
