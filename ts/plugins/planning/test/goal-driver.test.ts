import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { isDict, pyJsonLoads, PyValueError } from "@xueness/contracts";
import { afterGoalRun } from "../src/goal-driver.ts";
import { goalReminder, mergeGoalCompletion, verifyGoalCompletion } from "../src/goal-completion.ts";
import { goalDeliveryFailures, goalEvidence, goalHasResponse } from "../src/goal-evidence.ts";
import { beforeGoalRun } from "../src/goal-runtime.ts";
import { validateGoalVerdict } from "../src/goal-verifier.ts";
import type { Row } from "@xueness/agent";
import { PROJECT_ROOT, pythonUnavailableReason, runPython } from "../../../test-support/python-oracle.ts";
const STAMP = "2026-10-18T00:00:00+00:00";
function fixture(extra: Row = {}): Row {
  return { id: "a".repeat(32), task: "Explain the observable result", status: "completed", goal: { text: "Explain all requested criteria", status: "active", setAt: STAMP, updatedAt: STAMP, history: [], budget: { maxRounds: 8, maxWallSeconds: 600 }, runtime: { rounds: 0, reportedTokens: 0, elapsedSeconds: 0, stagnantRounds: 0 } }, messages: [{ role: "system", content: "System" }, { role: "user", content: "Explain the observable result", _message_id: "human" }, { role: "assistant", content: "Each requested criterion is explained.", _message_id: "answer" }], completion: { summary: "Each requested criterion is explained.", status: "not_applicable", verified: false, tool_execution_status: "not_applicable", delivery_status: "not_assessed", delivery_checks: {}, turn_id: "turn-1" }, ...extra };
}
async function invoke(input: Row): Promise<unknown> {
  const item = structuredClone(input), session = item.session as Row ?? {}; let clock = 100; const requests: Row[] = [];
  try {
    switch (item.op) {
      case "evidence": { const [final, rows, ids] = goalEvidence(session); return { final, rows, ids: [...ids].sort(), failures: goalDeliveryFailures(session), response: goalHasResponse(session) }; }
      case "verdict": return validateGoalVerdict(item.raw, new Set(item.ids as string[]));
      case "completion": return { reminder: goalReminder(session), check: mergeGoalCompletion(item.delivery as Row, verifyGoalCompletion(session, item.summary as string)) };
      case "before": return { result: beforeGoalRun(session, item.disabled !== true, STAMP), session };
      case "after": {
        const result = await afterGoalRun(session, { complete: async () => ({}) }, { enabled: item.disabled !== true, shouldStop: () => item.stopped === true, requestDeadline: item.deadline as number | undefined, elapsedSeconds: item.elapsed === undefined ? 4 : item.elapsed as number | null, now: () => clock, stamp: () => STAMP,
          async model(_provider, messages, options) {
            requests.push({ messages, outputTokens: options.outputTokens, timeoutSeconds: options.timeoutSeconds, deadline: options.deadline ?? null }); clock += 2;
            if (item.error) throw new PyValueError(String(item.error));
            const payload = pyJsonLoads(messages[1]!.content as string) as Row;
            return [item.verdict as Row ?? { passed: true, reason: "All criteria are established.", remaining: [], evidenceIds: [(payload.evidence as Row[]).at(-1)!.id] }, item.usage as Row ?? { total_tokens: 20 }];
          } }); return { result, session, requests };
      }
    }
  } catch (e) { return { error: (e as Error).name, message: (e as Error).message }; }
}
describe("planning goal driver Python differential", { skip: pythonUnavailableReason() ?? false }, () => {
  it("matches goal evidence, strict verdicts, reminders, completion projection and admission budgets", async () => {
    const toolSession = fixture({ messages: [{ role: "user", content: "Work", _message_id: "u" }, { role: "assistant", content: "Observation", _message_id: "a", tool_calls: [{ id: "read", function: { name: "read", arguments: '{"path":"a.txt"}' } }] }, { role: "tool", tool_call_id: "read", content: '{"ok":true,"data":"observed"}' }, { role: "assistant", content: "Final answer", _message_id: "final" }], results: { read: { ok: true, observed: "facts" } } });
    const goal = fixture().goal as Row, valid = { passed: true, reason: " supported ", remaining: [], evidenceIds: ["answer:a"] };
    const inputs: Row[] = [{ op: "evidence", session: fixture() }, { op: "evidence", session: toolSession }, { op: "evidence", session: fixture({ completion: { delivery_status: "failed", delivery_checks: { planning: { status: "failed", items: [{ id: "file", label: "Report", passed: false, missing: ["missing section"] }] } } } }) },
      ...[valid, { ...valid, evidenceIds: [] }, { ...valid, remaining: [" remaining "] }, { ...valid, evidenceIds: ["unknown"] }, { ...valid, evidenceIds: ["answer:a", "answer:a"] }, { ...valid, extra: true }, { ...valid, passed: 1 }, { ...valid, reason: "x".repeat(1201) }].map((raw) => ({ op: "verdict", raw, ids: ["answer:a"] })),
      { op: "completion", session: fixture(), summary: "Answer", delivery: { status: "passed", items: [] } }, { op: "completion", session: fixture({ goal: { ...goal, text: "中".repeat(1000) } }), summary: "Answer", delivery: { status: "failed", items: [], reason: "delivery failed" } },
      ...[fixture(), fixture({ goal: null }), fixture({ goal: { ...goal, status: "paused" } }), fixture({ goal: { ...goal, runtime: { elapsedSeconds: 601 } } }), fixture({ goal: { ...goal, budget: { maxTokens: 128 }, runtime: { reportedTokens: 128 } } }), fixture({ provider_usage: [{ usage: {} }], context_checkpoints: [{ reportedUsage: {} }] })].map((session) => ({ op: "before", session })), { op: "before", session: fixture(), disabled: true }];
    const expected = JSON.parse(runPython(readFileSync(join(PROJECT_ROOT, "ts/test-support/python/goal_driver_oracle.py"), "utf8"), JSON.stringify(inputs))) as unknown[];
    for (const [i, item] of inputs.entries()) {
      const want = structuredClone(expected[i]) as Row, goal = isDict(item.session) && isDict(item.session.goal) ? item.session.goal : null;
      // ZCode goals have no default wall budget: without an explicit one, admission reports no run deadline.
      if (item.op === "before" && goal && !(isDict(goal.budget) && goal.budget.maxWallSeconds) && isDict(want.result) && typeof want.result.deadline_seconds === "number") want.result.deadline_seconds = null;
      assert.deepEqual(await invoke(item), want, `goal helper ${i}`);
    }
  });
  it("matches independent verification, safe boundaries, failures, token budgets and bounded continuation", async () => {
    const goal = fixture().goal as Row, no = { passed: false, reason: "One criterion remains.", remaining: ["Explain the missing criterion"], evidenceIds: ["answer:answer"] };
    const limited = fixture({ goal: { ...goal, budget: { maxRounds: 8, maxWallSeconds: 600, maxTokens: 128 } }, provider_usage: [{ usage: { total_tokens: 10 } }] });
    const failed = fixture({ status: "needs_review", completion: { summary: "Incomplete report", status: "verified", delivery_status: "failed", delivery_checks: { planning: { status: "failed", items: [{ id: "file", label: "Report", passed: false, missing: ["section"] }] } } } });
    const inputs: Row[] = [{ op: "after", session: fixture() }, { op: "after", session: fixture(), verdict: no }, { op: "after", session: fixture(), error: "bounded verifier failed" }, { op: "after", session: fixture(), verdict: { ...no, evidenceIds: ["invented"] } }, { op: "after", session: fixture(), stopped: true }, { op: "after", session: fixture(), disabled: true }, { op: "after", session: fixture({ status: "paused" }) }, { op: "after", session: fixture({ status: "needs_review" }) }, { op: "after", session: fixture({ pending_question: { question: "Clarify" } }) }, { op: "after", session: fixture(), deadline: 99 }, { op: "after", session: fixture(), elapsed: 601 }, { op: "after", session: failed }, { op: "after", session: fixture({ goal: { ...goal, budget: { maxRounds: 1 } } }), verdict: no }, { op: "after", session: limited }, { op: "after", session: limited, usage: {} }, { op: "after", session: limited, usage: { total_tokens: 150 } }, { op: "after", session: { ...limited, provider_usage: [{}] } }];
    const expected = JSON.parse(runPython(readFileSync(join(PROJECT_ROOT, "ts/test-support/python/goal_driver_oracle.py"), "utf8"), JSON.stringify(inputs))) as unknown[];
    const failOpen = new Set([2, 3]);
    for (const [i, item] of inputs.entries()) {
      const actual = await invoke(item) as Row;
      if (!failOpen.has(i)) { assert.deepEqual(actual, expected[i], `goal lifecycle ${i}`); continue; }
      // ZCode failOpenGoalCompletionVerification: a failed or malformed verifier completes the goal instead of blocking it.
      const goal = (actual.session as Row).goal as Row, verification = goal.verification as Row;
      assert.equal((actual.result as Row).action, "stop", `goal lifecycle ${i}`); assert.equal(goal.status, "complete"); assert.equal(verification.passed, true); assert.equal(verification.kind, "fail_open");
      assert.match(String((goal.runtime as Row).reason), /按失败放行规则视为完成/);
    }
  });

});

describe("planning verifier pause race", () => {
  it("settles elapsed time, reported tokens and one round when the same goal was paused in flight", async () => {
    const original = fixture().goal as Row, goalId = "c".repeat(32);
    const session = fixture({ goal: { ...original, id: goalId, status: "paused", runtime: { rounds: 2, reportedTokens: 100, elapsedSeconds: 5, invocationElapsedBase: 5, invocationElapsedSeconds: 0, providerUsageCursor: 0, checkpointCursor: 0 } },
      provider_usage: [{ usage: { total_tokens: 20 } }], context_checkpoints: [{ reportedUsage: { total_tokens: 5 } }] });
    const result = await afterGoalRun(session, { complete: async () => ({}) }, { enabled: true, goalId, elapsedSeconds: 7, now: () => 100, stamp: () => STAMP, async model() { throw new Error("paused goals must not be verified"); } });
    const goal = session.goal as Row, runtime = goal.runtime as Row;
    assert.equal(result.action, "stop"); assert.equal(goal.status, "paused"); assert.equal(goal.id, goalId);
    assert.equal(runtime.rounds, 3); assert.equal(runtime.reportedTokens, 125); assert.equal(runtime.elapsedSeconds, 12);
    assert.equal(runtime.providerUsageCursor, 1); assert.equal(runtime.checkpointCursor, 1);
    assert.equal(Object.hasOwn(goal, "verification"), false);
  });

  it("persists verifier completion on the same active goal", async () => {
    const session = fixture(); let clock = 100;
    await afterGoalRun(session, { complete: async () => ({}) }, {
      enabled: true, shouldStop: () => false, elapsedSeconds: 4, now: () => clock++, stamp: () => STAMP,
      async model() { return [{ passed: true, reason: "All criteria are established.", remaining: [], evidenceIds: ["answer:answer"] }, { total_tokens: 20 }]; },
    });
    const goal = session.goal as Row;
    assert.equal(goal.status, "complete"); assert.equal((goal.verification as Row).passed, true);
  });

  it("discards a verifier result when the live goal was paused while verification was pending", async () => {
    const session = fixture(), liveGoal = session.goal as Row;
    let clock = 100;
    const result = await afterGoalRun(session, { complete: async () => ({}) }, {
      enabled: true, shouldStop: () => false, elapsedSeconds: 4, now: () => clock++, stamp: () => STAMP,
      async model() {
        session.goal = { ...liveGoal, status: "paused" };
        return [{ passed: true, reason: "All criteria are established.", remaining: [], evidenceIds: ["answer:answer"] }, { total_tokens: 20 }];
      },
    });
    assert.equal(result.action, "stop");
    assert.equal((session.goal as Row).status, "paused");
    assert.equal(Object.hasOwn(session.goal as Row, "verification"), false);
  });
});
