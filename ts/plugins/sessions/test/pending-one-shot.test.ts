/** A waiting call asked by alwaysAsk / an ask rule / remote exec is listed as one-shot: no "allow for this session". */
import assert from "node:assert/strict";
import { it } from "node:test";
import type { Session } from "@xueness/sessions";
import { pendingDenials } from "../src/public-session.ts";

const session = (reason: string, status = "running"): Session => ({
  id: "s".repeat(32), status,
  messages: [{ role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "write", arguments: JSON.stringify({ path: "x.txt", content: "x" }) } }] }],
  results: { c1: { ok: false, error: { code: "approval_required", message: "m" }, data: { awaitingApproval: true, waiting: true, reason, kind: "write", subject: "x.txt" } } },
} as unknown as Session);

it("marks waiting alwaysAsk, ask-rule and remote-exec calls as one-shot", () => {
  for (const reason of ["always_ask", "ask_rule", "remote_exec"]) {
    assert.deepEqual(pendingDenials(session(reason)).map((row) => [row.waiting, row.oneShot]), [[true, true]], reason);
  }
  assert.deepEqual(pendingDenials(session("approval_required")).map((row) => [row.waiting, row.oneShot]), [[true, undefined]]);
  assert.deepEqual(pendingDenials(session("always_ask", "paused")).map((row) => [row.waiting, row.oneShot]), [[undefined, undefined]], "replay rows are unchanged");
});
