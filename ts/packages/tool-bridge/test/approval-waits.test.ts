/**
 * ZCode cases for approvals answered in process. Sources (ZCode v3.15.1, aac4755):
 * core/src/permission/broker.ts (ManualPermissionBroker), core/src/tool/executor/
 * permission-responder-race.ts, permission-flow.ts and turn-control.ts.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ApprovalWaits, EXIT_PLAN_MODE_TOOL, turnControlOf, withPlanExitDeniedTurnStop, type ApprovalRequest } from "@xueness/tool-bridge";
import { setup, until } from "./support.ts";

const SID = "s".repeat(32);
const write = (id: string, path = "x.txt") => ({ id, name: "write", input: { path, content: `${id}\n` } });

describe("approvals wait in process (ZCode broker / responder race)", () => {
  it("opens the answer channel before the request is visible, then runs the approved call", async () => {
    const waits = new ApprovalWaits();
    const s = await setup({ approver: waits.approver(SID) });
    const shown: ApprovalRequest[] = [];
    const call = s.bridge.call(write("w1"), { onApprovalRequest: (request) => { assert.ok(waits.get(SID, request.callId), "answerable once visible"); shown.push(request); } });
    await until(() => shown.length === 1);
    assert.equal(existsSync(join(s.workspace, "x.txt")), false, "nothing runs while waiting");
    assert.deepEqual(waits.waiting(SID).map((item) => [item.callId, item.kind, item.subject]), [["w1", "write", "x.txt"]]);
    assert.equal(waits.answer(SID, "w1", "approve").status, "answered");
    assert.equal((await call).ok, true);
    assert.equal(readFileSync(join(s.workspace, "x.txt"), "utf8"), "w1\n");
    assert.deepEqual(waits.waiting(SID), []);
    // The first answer decides; a repeat is a duplicate and a change is a conflict.
    assert.equal(waits.answer(SID, "w1", "approve").status, "duplicate");
    assert.equal(waits.answer(SID, "w1", "reject").status, "conflict");
    assert.equal(waits.answer(SID, "unknown", "approve").status, "none", "an unknown id is a miss");
    await s.close();
  });

  it("returns a user denial as an ordinary permission_denied result", async () => {
    const waits = new ApprovalWaits();
    const s = await setup({ approver: waits.approver(SID) });
    const call = s.bridge.call(write("w1"));
    await until(() => waits.waiting(SID).length === 1);
    waits.answer(SID, "w1", "reject", "use notes.md instead");
    const result = await call;
    assert.deepEqual([result.error?.code, result.output, result.data], ["permission_denied", "the user declined this write call. The user's feedback: use notes.md instead", { reason: "user_denied", feedback: "use notes.md instead" }]);
    assert.equal(turnControlOf(result), null, "an ordinary denial does not end the turn");
    await s.close();
  });

  it("answers several concurrent waits independently", async () => {
    const waits = new ApprovalWaits();
    const s = await setup({ approver: waits.approver(SID) });
    const calls = [s.bridge.call(write("a", "a.txt")), s.bridge.call(write("b", "b.txt")), s.bridge.call(write("c", "c.txt"))];
    await until(() => waits.waiting(SID).length === 3);
    waits.answer(SID, "b", "reject"); waits.answer(SID, "c", "approve"); waits.answer(SID, "a", "approve");
    assert.deepEqual((await Promise.all(calls)).map((result) => result.ok), [true, false, true]);
    assert.deepEqual(["a.txt", "b.txt", "c.txt"].map((name) => existsSync(join(s.workspace, name))), [true, false, true]);
    await s.close();
  });

  it("cancels the wait when the user stops or the call is aborted", async () => {
    const waits = new ApprovalWaits();
    let stop = false;
    const s = await setup({ approver: waits.approver(SID, { stopped: () => stop, pollMs: 5 }) });
    const stopped = s.bridge.call(write("w1"));
    await until(() => waits.waiting(SID).length === 1);
    stop = true;
    assert.equal((await stopped).error?.code, "cancelled");
    stop = false;
    const controller = new AbortController();
    const aborted = s.bridge.call(write("w2"), { signal: controller.signal });
    await until(() => waits.waiting(SID).length === 1);
    controller.abort();
    assert.equal((await aborted).error?.code, "cancelled");
    assert.deepEqual(waits.waiting(SID), []);
    assert.equal(waits.answer(SID, "w2", "approve").status, "none", "a cancelled wait cannot be answered");
    assert.equal(existsSync(join(s.workspace, "x.txt")), false);
    await s.close();
  });

  it("defers to approval_required when nobody can answer, and when the request cannot be shown", async () => {
    const waits = new ApprovalWaits();
    let available = false;
    const s = await setup({ approver: waits.approver(SID, { available: () => available }) });
    const deferred = await s.bridge.call(write("w1"));
    assert.equal(deferred.error?.code, "approval_required");
    assert.equal((deferred.data as { awaitingApproval?: boolean }).awaitingApproval, true);
    available = true;
    const unseen = await s.bridge.call(write("w2"), { onApprovalRequest: () => { throw new Error("journal unavailable"); } });
    assert.equal(unseen.error?.code, "approval_required");
    assert.deepEqual(waits.waiting(SID), [], "the hidden wait is withdrawn");
    const pending = s.bridge.call(write("w3"));
    await until(() => waits.waiting(SID).length === 1);
    assert.equal(waits.defer(), 1, "host shutdown defers every wait");
    assert.equal((await pending).error?.code, "approval_required");
    await s.close();
  });

  it("denies waits of a closed session and a duplicate wait for the same call", async () => {
    const waits = new ApprovalWaits();
    const s = await setup({ approver: waits.approver(SID) });
    const first = s.bridge.call(write("w1"));
    await until(() => waits.waiting(SID).length === 1);
    const twin = await s.bridge.call(write("w1"));
    assert.equal(twin.error?.code, "permission_denied", "a second wait for a waiting call id is refused");
    assert.equal(waits.close(SID), 1);
    const closed = await first;
    assert.equal(closed.error?.code, "permission_denied");
    assert.match(closed.output, /session was closed/);
    assert.equal(waits.answered(SID, "w1"), null, "closing forgets the session's answers");
    await s.close();
  });

  it("ends the turn only for a denied plan-mode exit (turn-control.ts)", () => {
    const denied = { ok: false, output: "no", error: { code: "permission_denied", message: "no" } };
    assert.equal(turnControlOf(withPlanExitDeniedTurnStop(denied, { tool: "write", planEnabled: true })), null);
    assert.equal(turnControlOf(withPlanExitDeniedTurnStop(denied, { tool: EXIT_PLAN_MODE_TOOL, planEnabled: false })), null);
    assert.equal(turnControlOf(withPlanExitDeniedTurnStop({ ok: true, output: "" }, { tool: EXIT_PLAN_MODE_TOOL, planEnabled: true })), null);
    assert.deepEqual(turnControlOf(withPlanExitDeniedTurnStop(denied, { tool: EXIT_PLAN_MODE_TOOL, planEnabled: true })), { reason: "plan_exit_denied", stop_turn_after_result: true });
  });
});
