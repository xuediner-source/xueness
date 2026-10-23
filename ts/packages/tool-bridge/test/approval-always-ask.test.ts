/**
 * alwaysAsk wins over "allow for this session": a call an alwaysAsk rule
 * covers asks every time. ZCode v3.15.1 (aac4755) `permission/service.ts`:
 * a session grant is an allow rule, and alwaysAsk / ask rules are checked
 * before allow rules, so a session grant never answers them.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ApprovalWaits, sessionAllowable } from "@xueness/tool-bridge";
import { setup, until } from "./support.ts";

const SID = "c".repeat(32);
const write = (id: string, path = "x.txt") => ({ id, name: "write", input: { path, content: `${id}\n` } });

describe("approval answers: alwaysAsk is never remembered", () => {
  it("asks an alwaysAsk call every time, even after allow for this session", async () => {
    const waits = new ApprovalWaits();
    const s = await setup({ approver: waits.approver(SID), settings: { mode: "build", alwaysAsk: ["write(x.txt)"] } });
    for (const id of ["w1", "w2", "w3"]) {
      const call = s.bridge.call(write(id));
      await until(() => waits.waiting(SID).length === 1);
      assert.equal(waits.waiting(SID)[0]?.code, "always_ask");
      assert.equal(waits.answer(SID, id, "approve", undefined, "session").status, "answered");
      assert.equal((await call).ok, true, id);
    }
    assert.deepEqual(waits.sessionAllowed(SID), [], "an alwaysAsk approval is not stored for the session");
    assert.equal(readFileSync(join(s.workspace, "x.txt"), "utf8"), "w3\n");
    await s.close();
  });

  it("still remembers ordinary asks next to an alwaysAsk rule", async () => {
    const waits = new ApprovalWaits();
    const s = await setup({ approver: waits.approver(SID), settings: { mode: "build", alwaysAsk: ["write(secret.txt)"] } });
    const first = s.bridge.call(write("w1"));
    await until(() => waits.waiting(SID).length === 1);
    assert.equal(waits.waiting(SID)[0]?.code, "approval_required");
    waits.answer(SID, "w1", "approve", undefined, "session");
    assert.equal((await first).ok, true);
    assert.equal((await s.bridge.call(write("w2"))).ok, true, "the session allowance answers the ordinary ask");
    // A session allowance for an exact subject never reaches an alwaysAsk call.
    const secret = s.bridge.call(write("w3", "secret.txt"));
    await until(() => waits.waiting(SID).length === 1);
    assert.equal(waits.waiting(SID)[0]?.code, "always_ask");
    waits.answer(SID, "w3", "reject");
    assert.equal((await secret).ok, false);
    await s.close();
  });

  it("treats ask rules and remote exec as one-shot too", () => {
    assert.deepEqual(["always_ask", "ask_rule", "remote_exec", "approval_required"].map(sessionAllowable), [false, false, false, true]);
  });
});
