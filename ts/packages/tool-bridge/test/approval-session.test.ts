/**
 * ZCode cases for the rest of the approval answer (ZCode v3.15.1, aac4755,
 * apps/zcode-cli/packages/core/src):
 * - tool/executor/permission-response.ts: a deny response carries the user's
 *   reason into the model-visible permission error.
 * - permission/service.ts grantSessionPermission + tool/executor/
 *   permission-rules-persistence.ts sessionPermissionUpdates: "allow for this
 *   session" is an in-memory session rule; later identical asks do not wait.
 * - permission/broker.ts: `timeoutMs` is optional (no default); on expiry the
 *   request fails with permission_timeout.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ApprovalWaits } from "@xueness/tool-bridge";
import { setup, until } from "./support.ts";

const SID = "a".repeat(32);
const write = (id: string, path = "x.txt") => ({ id, name: "write", input: { path, content: `${id}\n` } });

describe("approval answers: feedback, allow for this session, timeout", () => {
  it("hands the user's rejection feedback to the model with the denial", async () => {
    const waits = new ApprovalWaits();
    const s = await setup({ approver: waits.approver(SID) });
    const call = s.bridge.call(write("w1"));
    await until(() => waits.waiting(SID).length === 1);
    waits.answer(SID, "w1", "reject", "先别写文件，改成在回复里给出内容");
    const result = await call;
    assert.equal(result.error?.code, "permission_denied");
    assert.match(result.output, /declined this write call\. The user's feedback: 先别写文件/);
    assert.deepEqual(result.data, { reason: "user_denied", feedback: "先别写文件，改成在回复里给出内容" });
    // A rejection without feedback keeps the plain text.
    const second = s.bridge.call(write("w2"));
    await until(() => waits.waiting(SID).length === 1);
    waits.answer(SID, "w2", "reject");
    assert.deepEqual([(await second).output, (await second).data], ["the user declined this write call", { reason: "user_denied" }]);
    await s.close();
  });

  it("allows identical calls for the rest of the session without asking again", async () => {
    const waits = new ApprovalWaits();
    const answers: string[] = [];
    const s = await setup({ approver: waits.approver(SID, { onAnswer: (approval, answer) => answers.push(`${approval.callId}:${answer.behavior}`) }) });
    const first = s.bridge.call(write("w1"));
    await until(() => waits.waiting(SID).length === 1);
    assert.equal(waits.answer(SID, "w1", "approve", undefined, "session").status, "answered");
    assert.equal((await first).ok, true);
    assert.deepEqual(waits.sessionAllowed(SID), [{ tool: "write", kind: "write", subject: "x.txt" }]);
    // Same tool, kind and subject: runs without a wait.
    assert.equal((await s.bridge.call(write("w2"))).ok, true);
    assert.equal(readFileSync(join(s.workspace, "x.txt"), "utf8"), "w2\n");
    assert.deepEqual(answers, ["w1:allow", "w2:allow"], "the session allow is still audited");
    // A different subject still asks; another session is unaffected.
    const other = s.bridge.call(write("w3", "y.txt"));
    await until(() => waits.waiting(SID).length === 1);
    waits.answer(SID, "w3", "reject");
    assert.equal((await other).ok, false);
    assert.deepEqual(waits.sessionAllowed("b".repeat(32)), []);
    await s.close();
  });

  it("clears the session allow list on stop and on close", async () => {
    const waits = new ApprovalWaits();
    let stop = false;
    const s = await setup({ approver: waits.approver(SID, { stopped: () => stop, pollMs: 5 }) });
    const first = s.bridge.call(write("w1"));
    await until(() => waits.waiting(SID).length === 1);
    waits.answer(SID, "w1", "approve", undefined, "session");
    await first;
    stop = true;
    assert.equal((await s.bridge.call(write("w2"))).error?.code, "cancelled");
    assert.deepEqual(waits.sessionAllowed(SID), [], "stop clears the session allow list");
    stop = false;
    const again = s.bridge.call(write("w3"));
    await until(() => waits.waiting(SID).length === 1);
    waits.answer(SID, "w3", "approve", undefined, "session");
    await again;
    assert.equal(waits.sessionAllowed(SID).length, 1);
    waits.close(SID);
    assert.deepEqual(waits.sessionAllowed(SID), [], "delete/reset clears it");
    waits.answer(SID, "nothing", "approve");
    await s.close();
  });

  it("has no timeout by default and denies with permission_timeout when one is set", async () => {
    const waits = new ApprovalWaits();
    const s = await setup({ approver: (request) => waits.approver(SID, request.callId === "t1" ? { timeoutMs: 20 } : {})(request) });
    const timed = await s.bridge.call(write("t1"));
    assert.equal(timed.error?.code, "permission_denied");
    assert.equal((timed.data as { reason?: string }).reason, "permission_timeout");
    assert.match(timed.output, /timed out after 20ms without an answer from the user; treat this write call as denied/);
    assert.equal(existsSync(join(s.workspace, "x.txt")), false);
    const plain = s.bridge.call(write("t2"));
    await until(() => waits.waiting(SID).length === 1);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(waits.waiting(SID).length, 1, "still waiting: ZCode has no default timeout");
    waits.answer(SID, "t2", "approve");
    assert.equal((await plain).ok, true);
    await s.close();
  });
});
