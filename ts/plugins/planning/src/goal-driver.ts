/** Bounded continuation after safe final-answer boundaries; never authorizes tools. */
import { isDict, pyJsonDumps, pySlice, pyStrip, pyTruthy } from "@xueness/contracts";
import type { AgentProvider } from "@xueness/agent";
import type { Row } from "./delivery.ts";
import { normalizeGoalBudget, sanitizeGoal } from "./goal.ts";
import { finishGoalCompletionCheck, goalSummaryHash } from "./goal-completion.ts";
import { goalDeliveryFailures, goalEvidence, goalHasResponse } from "./goal-evidence.ts";
import { goalInt, goalNumber, goalStamp, goalStopped, goalUsageTokens, newGoalReportedTokens, setGoalStatus } from "./goal-runtime.ts";
import { verifyGoal, type GoalModelJson } from "./goal-verifier.ts";
export interface GoalRunOptions { enabled: boolean; model: GoalModelJson; goalId?: string; shouldStop?: () => boolean; signal?: AbortSignal; requestDeadline?: number; elapsedSeconds?: number | null; now?: () => number; stamp?: () => string }
const stop = (reason = ""): Row => ({ action: "stop", prompt: "", reason: pySlice(reason, 500) });
export function goalContinuePrompt(goal: Row, reason: string, remaining: string[]): string {
  const details = remaining.slice(0, 8).map((item) => pySlice(item, 400)).join("；") || reason;
  return "继续完成当前会话目标，不要只重复完成声明。目标：" + pySlice(goal.text as string, 1200) + "\n核验发现仍需处理：" + pySlice(details, 4000) + "\n保留已经完成的工作，补齐剩余交付或验证，再用简洁事实说明结果。";
}
export async function afterGoalRun(session: Row, provider: AgentProvider, options: GoalRunOptions): Promise<Row> {
  const now = options.now ?? (() => performance.now() / 1000), stamp = options.stamp ?? goalStamp;
  if (!options.enabled) return stop("planning 插件当前不可用。");
  let goal = sanitizeGoal(session.goal); if (!goal) return stop("当前会话没有有效目标。");
  const goalId = options.goalId ?? String(goal.id);
  if (goal.id !== goalId) return stop("当前会话目标已变化，已跳过旧目标结算。");
  if (goal.status === "paused") {
    if (options.goalId === undefined) return stop("当前会话目标未处于进行中状态。");
    const runtime = { ...(isDict(goal.runtime) ? goal.runtime : {}) };
    const base = goalNumber(runtime.invocationElapsedBase, goalNumber(runtime.elapsedSeconds));
    const elapsed = options.elapsedSeconds == null ? goalNumber(runtime.invocationElapsedSeconds) : goalNumber(options.elapsedSeconds);
    runtime.invocationElapsedSeconds = elapsed; runtime.elapsedSeconds = base + elapsed;
    const [newTokens] = newGoalReportedTokens(session, runtime);
    runtime.reportedTokens = goalInt(runtime.reportedTokens) + newTokens;
    runtime.rounds = goalInt(runtime.rounds) + 1;
    session.goal = { ...goal, runtime };
    return stop("目标在本轮运行中暂停；已结算本轮已报告用量并丢弃核验结果。");
  }
  if (goal.status !== "active") return stop("当前会话目标未处于进行中状态。");
  const status = (value: string, action: string, reason: string): Row => {
    const current = sanitizeGoal(session.goal);
    if (current?.id === goalId && current.status === "active") goal = setGoalStatus(session, current, value, action, reason, stamp());
    return stop(reason);
  };
  let budget: Row; try { budget = normalizeGoalBudget(goal.budget ?? null); } catch (e) { status("blocked", "blocked", "目标预算无效：" + (e as Error).message); return stop((e as Error).message); }
  let runtime: Row = { ...(isDict(goal.runtime) ? goal.runtime : {}) };
  const base = goalNumber(runtime.invocationElapsedBase, goalNumber(runtime.elapsedSeconds)), elapsed = options.elapsedSeconds == null ? goalNumber(runtime.invocationElapsedSeconds) : goalNumber(options.elapsedSeconds), cumulative = base + elapsed;
  runtime.invocationElapsedSeconds = elapsed; runtime.elapsedSeconds = cumulative;
  const [newTokens, usageComplete] = newGoalReportedTokens(session, runtime); let reported = goalInt(runtime.reportedTokens) + newTokens; runtime.reportedTokens = reported;
  goal = { ...goal, runtime }; session.goal = goal;
  const maximum = budget.maxTokens == null ? null : Number(budget.maxTokens);
  if (maximum !== null && goalHasResponse(session) && !usageComplete) return status("budget_limited", "budget_limited", "模型服务未报告完整 token 用量；为守住目标 token 上限，停止继续。");
  if (maximum !== null && reported >= maximum) return status("budget_limited", "budget_limited", "已达到目标 token 上限。");
  if (goalStopped(options.shouldStop)) { status("paused", "pause", "用户停止了当前会话目标运行。"); return stop("检测到用户停止请求。"); }
  if (pyTruthy(session.pending_question) || session.status === "awaiting_user") return stop("会话正在等待用户回答。");
  if (["stopped", "cancelled", "paused", "awaiting_approval"].includes(String(session.status))) return stop("会话已停止、暂停或等待批准。");
  const completion = isDict(session.completion) ? session.completion : {}, failures = goalDeliveryFailures(session);
  if (session.status === "needs_review" && !failures.length) return stop("主机将本轮标记为需要复核。");
  if (!["completed", "needs_review"].includes(String(session.status))) return stop("本轮未到可核验的最终回答边界。");
  if (completion.tool_execution_status != null && !["succeeded", "not_applicable"].includes(String(completion.tool_execution_status))) return stop("主机记录到未成功的工具执行。");
  if (options.requestDeadline != null && now() >= options.requestDeadline) { status("budget_limited", "budget_limited", "外层运行时限已到，无法继续核验。"); return stop("外层运行时限已到。"); }
  const wallBudget = budget.maxWallSeconds == null ? Infinity : Number(budget.maxWallSeconds), roundBudget = budget.maxRounds == null ? Infinity : Number(budget.maxRounds);
  if (cumulative >= wallBudget) return status("budget_limited", "budget_limited", "已达到目标累计用时上限。");
  const rounds = goalInt(runtime.rounds) + 1; runtime.rounds = rounds; goal = { ...goal, runtime }; session.goal = goal;
  const summary = typeof completion.summary === "string" && pyStrip(completion.summary) ? completion.summary : "", evidence = goalEvidence(session);
  let verdict: Row, usage: Row, failOpen = false;
  if (failures.length) { verdict = { passed: false, reason: "主机交付检查未通过。", remaining: failures, evidenceIds: [] }; usage = {}; }
  else {
    const started = now();
    try { [verdict, usage] = await verifyGoal(provider, session, goal, evidence, options.model, { shouldStop: options.shouldStop, deadline: options.requestDeadline, signal: options.signal }); }
    catch (e) {
      if (isDict(e) && (e._xueness_stream_control === "stop" || e.xuenessStreamControl === "stop") || options.signal?.aborted || goalStopped(options.shouldStop)) return status("paused", "pause", "用户停止了目标核验。");
      if (options.requestDeadline != null && now() >= options.requestDeadline) return status("budget_limited", "budget_limited", "外层运行时限已到，无法完成核验。");
      // ZCode failOpenGoalCompletionVerification: a verifier request or format failure is not a
      // verdict that work remains, so it must not leave the goal blocked or iterating forever.
      verdict = { passed: true, reason: pySlice("独立核验未能完成（" + (e as Error).message + "），按失败放行规则视为完成。", 1200), remaining: [], evidenceIds: [] }; usage = {}; failOpen = true;
    } finally {
      const current = sanitizeGoal(session.goal);
      if (current?.id === goalId) { runtime = { ...(isDict(current.runtime) ? current.runtime : {}) }; runtime.elapsedSeconds = goalNumber(runtime.elapsedSeconds) + Math.max(0, now() - started); goal = { ...current, runtime }; session.goal = goal; }
    }
  }
  const verifierTokens = goalUsageTokens(usage);
  let settled = sanitizeGoal(session.goal);
  if (settled?.id === goalId && maximum !== null && !failures.length && !failOpen && verifierTokens !== null) {
    runtime = { ...(isDict(settled.runtime) ? settled.runtime : {}) }; reported = goalInt(runtime.reportedTokens) + verifierTokens; runtime.reportedTokens = reported; goal = { ...settled, runtime }; session.goal = goal; settled = goal;
  }
  if (options.signal?.aborted || goalStopped(options.shouldStop)) return status("paused", "pause", "用户停止了目标核验。");
  if (!settled || settled.id !== goalId || settled.status !== "active") return stop("核验期间会话目标已暂停或变化，已丢弃旧核验结果。");
  goal = settled; runtime = { ...(isDict(goal.runtime) ? goal.runtime : {}) };
  if (maximum !== null && !failures.length && !failOpen) {
    if (verifierTokens === null) return status("budget_limited", "budget_limited", "独立核验未报告完整 token 用量；为守住目标 token 上限，停止继续。");
    if (reported > maximum) return status("budget_limited", "budget_limited", "独立核验后超过目标 token 上限。");
  }
  if (verdict.passed && completion.delivery_status !== "failed") {
    goal.verification = { passed: true, summaryHash: goalSummaryHash(summary), turnId: completion.turn_id ?? null, at: stamp(), kind: failOpen ? "fail_open" : "independent_model_verifier", reason: verdict.reason, evidenceIds: verdict.evidenceIds };
    session.goal = goal;
    finishGoalCompletionCheck(session, goal, summary, stamp(), failOpen ? "fail_open" : undefined); status("complete", "complete", String(verdict.reason)); return stop(failOpen ? "独立核验未能完成，已按失败放行规则结束目标。" : "独立核验确认目标完成。");
  }
  const digest = goalSummaryHash(pyJsonDumps({ answer: evidence[0], remaining: verdict.remaining, delivery: failures }, { ensureAscii: false, sortKeys: true }));
  runtime = { ...(isDict(goal.runtime) ? goal.runtime : {}) }; const stagnant = runtime.lastFingerprint === digest ? goalInt(runtime.stagnantRounds) + 1 : 0;
  Object.assign(runtime, { stagnantRounds: stagnant, lastFingerprint: digest }); goal = { ...goal, runtime }; session.goal = goal;
  let reason = String(verdict.reason || "独立核验未确认目标完成。");
  if (stagnant >= 2) { reason = "连续两轮没有可核验进展。" + reason; return status("blocked", "blocked", reason); }
  if (rounds >= roundBudget) { reason = "已达到目标轮次上限。" + reason; return status("budget_limited", "budget_limited", reason); }
  if (cumulative >= wallBudget) { reason = "已达到目标累计用时上限。" + reason; return status("budget_limited", "budget_limited", reason); }
  return { action: "continue", prompt: goalContinuePrompt(goal, reason, verdict.remaining as string[]), reason: pySlice(reason, 500) };
}
