import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { SessionStore } from "@xueness/sessions";
import type { AgentProvider } from "@xueness/agent";
import { decisionStopCode, goalContinueDecision, goalDecisionFromRun, goalStopDecision } from "../src/goal-contract.ts";
import { planningGoalExtension } from "../src/goal-extension.ts";
import type { Row } from "../src/delivery.ts";

const STAMP = "2026-10-25T00:00:00+00:00";
const goal = (status: string, runtime: Row = {}): Row => ({ id: "b".repeat(32), text: "Explain the criteria", status, setAt: STAMP, updatedAt: STAMP, history: [], budget: { maxRounds: 8, maxWallSeconds: 600 }, runtime: { rounds: 0, reportedTokens: 0, elapsedSeconds: 0, ...runtime } });
const session = (status: string, g: Row | null = goal("active")): Row => ({ id: "a".repeat(32), task: "task", status, goal: g, messages: [{ role: "system", content: "System" }, { role: "user", content: "task", _message_id: "u" }, { role: "assistant", content: "done", _message_id: "a" }], completion: { summary: "done", status: "not_applicable", verified: false, tool_execution_status: "not_applicable", delivery_status: "not_assessed", delivery_checks: {}, turn_id: "turn-1" } });

describe("goal continuation and stop contract", () => {
  it("builds unified continue and stop decisions", () => {
    const stop = goalStopDecision("budget_limited", "已达到目标 token 上限。");
    assert.equal(stop.action, "stop"); assert.equal(stop.prompt, ""); assert.equal(stop.stopCode, "budget_limited");
    const cont = goalContinueDecision("继续完成当前会话目标", "still remaining");
    assert.equal(cont.action, "continue"); assert.equal(cont.exclusive, true); assert.equal(cont.kind, "goal_continuation");
    assert.equal(decisionStopCode(stop), "budget_limited");
    assert.equal(decisionStopCode(cont), null);
    assert.equal(decisionStopCode(undefined), null);
    assert.equal(decisionStopCode({ action: "stop" }), "boundary");
  });

  it("maps settled goal-driver rows onto stop codes via the persisted goal", () => {
    const cases: Array<[Row, string]> = [
      [session("completed", goal("complete")), "complete"],
      [session("completed", goal("budget_limited")), "budget_limited"],
      [session("completed", goal("paused")), "paused"],
      [session("completed", goal("blocked")), "blocked"],
      [session("awaiting_user"), "waiting_user"],
      [session("completed"), "boundary"],
      [session("completed", null), "changed"],
    ];
    const reasons = ["目标完成。", "已达到目标 token 上限。", "用户停止了当前会话目标运行。", "连续两轮没有可核验进展。", "会话正在等待用户回答。", "本轮未到可核验的最终回答边界。", "当前会话没有有效目标。"];
    for (const [[item, code], reason] of cases.map(([item, code], index) => [[item, code], reasons[index]] as [[Row, string], string])) {
      const decision = goalDecisionFromRun(item, { action: "stop", prompt: "", reason });
      assert.equal(decision.action, "stop", reason);
      assert.equal(decision.stopCode, code, reason + " → " + code);
    }
    const unavailable = goalDecisionFromRun(session("completed"), { action: "stop", prompt: "", reason: "planning 插件当前不可用。" });
    assert.equal(unavailable.stopCode, "unavailable");
    const changed = goalDecisionFromRun(session("completed", { ...goal("active"), id: "c".repeat(32) }), { action: "stop", prompt: "", reason: "当前会话目标已变化，已跳过旧目标结算。" });
    assert.equal(changed.stopCode, "changed");
    const cont = goalDecisionFromRun(session("completed"), { action: "continue", prompt: "继续完成当前会话目标", reason: "仍需处理" });
    assert.equal(cont.kind, "goal_continuation"); assert.equal(cont.exclusive, true);
  });

  it("marks the proactive continuation prompt as goal input, not a human utterance", async () => {
    const root = mkdtempSync(join(tmpdir(), "xueness-goal-append-")), directory = join(root, "state");
    const store = new SessionStore(directory);
    try {
      const value = session("completed") as any;
      value.root = root;
      await store.new("continuation", root, { sessionId: value.id });
      const saved = await store.load(value.id);
      saved.goal = goal("active"); saved.status = "completed"; saved.completion = session("completed").completion; await store.save(saved);
      const extension = planningGoalExtension({ model: "verifier", messages: [], tools: [], options: {} } as never);
      const context = { session: saved, store, provider: { complete: async () => ({}) } as AgentProvider, stateDir: directory, root, signal: new AbortController().signal, deadline: Infinity, options: {}, enabled: () => true, save: async () => store.save(saved), emit: () => {} } as never;
      assert.equal(await extension.appendTurn!(context as never, "继续完成当前会话目标"), true);
      const journal = saved.messages as Row[];
      const appended = journal.at(-1)!;
      assert.equal(appended.role, "user");
      assert.equal(appended._input_kind, "goal_continuation");
      assert.equal(appended._meta_source, "target_continuation");
      assert.equal(appended._goal_id, "b".repeat(32));
      assert.equal(journal.filter((row) => row.role === "user" && row._input_kind !== "guide" && row._input_kind !== "background_notice" && !row._meta_source).length, 1, "the continuation is not a new human utterance");
      saved.goal = { ...goal("active"), status: "paused" }; await store.save(saved);
      assert.equal(await extension.appendTurn!(context as never, "again"), false, "an inactive goal never appends");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
