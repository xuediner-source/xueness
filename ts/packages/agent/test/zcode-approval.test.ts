/**
 * ZCode cases for the in-process approval flow through the real agent loop.
 * Sources (ZCode v3.15.1, aac4755, apps/zcode-cli/packages/core/src):
 * tool/executor/permission-flow.ts (the call waits, then the same turn goes on),
 * permission/broker.ts (abort cancels the wait), tool/executor/turn-control.ts
 * (a denial is a tool result; only a denied plan exit stops the turn).
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { SessionStore } from "@xueness/sessions";
import { ApprovalWaits, EXIT_PLAN_MODE_TOOL, withPlanExitDeniedTurnStop } from "@xueness/tool-bridge";
import { AgentRunner, kernelAgentHooks, type AgentProvider, type Row } from "../src/index.ts";
import { setup, until } from "../../tool-bridge/test/support.ts";
import { call, fixture } from "./fixtures.ts";

const writeCall = (id: string, path = "out.txt") => call(id, JSON.stringify({ path, content: "approved\n" }), "write");

async function live(responses: Row[]) {
  const waits = new ApprovalWaits();
  let stop = false; let sid = "";
  const workspace = await setup({ approver: (request) => waits.approver(sid, { stopped: () => stop, pollMs: 5 })(request) });
  const state = mkdtempSync(join(tmpdir(), "xueness-approval-state-"));
  const store = new SessionStore(state);
  const session = await store.new("Write out.txt", workspace.workspace); sid = String(session.id);
  const seen: Row[][] = [];
  const provider: AgentProvider = { runtimeProfile: "standard", toolCalling: "native", async complete(messages) {
    seen.push(structuredClone(messages)); const next = responses.shift(); if (!next) throw new Error("script exhausted"); return structuredClone(next);
  } };
  const hooks = kernelAgentHooks(workspace.kernel, { enabled: (id) => ["providers", "sessions"].includes(id) || workspace.host.list().some((entry) => entry.id === id && entry.state === "active") });
  const runner = new AgentRunner({ store, root: workspace.workspace, provider, toolBridge: workspace.bridge, hooks });
  return { waits, store, session, sid, seen, runner, workspace: workspace.workspace, stop: () => { stop = true; },
    shouldStop: () => stop, close: async () => { await workspace.close(); rmSync(state, { recursive: true, force: true }); } };
}
const users = (session: Row): number => (session.messages as Row[]).filter((row) => row.role === "user").length;
const toolRows = (session: Row, id: string): Row[] => (session.messages as Row[]).filter((row) => row.role === "tool" && row.tool_call_id === id);

describe("ZCode in-process approvals through the agent loop", () => {
  it("waits in place and continues the same turn after approval (permission-flow.ts)", async () => {
    const t = await live([{ tool_calls: [writeCall("w1")] }, { content: "Wrote out.txt." }]);
    try {
      const running = t.runner.run(t.session, { shouldStop: t.shouldStop });
      await until(() => t.waits.waiting(t.sid).length === 1);
      const journal = await t.store.load(t.sid);
      assert.equal(journal.status, "running");
      const placeholder = (journal.results as Row).w1 as Row;
      assert.equal((placeholder.error as Row).code, "approval_required");
      assert.equal((placeholder.data as Row).waiting, true, "visible as a waiting approval");
      assert.equal(toolRows(journal, "w1").length, 1, "a restart finds the paused-approval shape and can replay");
      assert.equal(t.seen.length, 1);
      t.waits.answer(t.sid, "w1", "approve");
      await running;
      assert.equal(t.session.status, "completed");
      assert.equal(readFileSync(join(t.workspace, "out.txt"), "utf8"), "approved\n");
      assert.equal(t.seen.length, 2); assert.equal(t.session.steps, 2);
      assert.equal(users(t.session), 1, "no new turn was started");
      assert.equal(toolRows(t.session, "w1").length, 1);
      assert.equal(((t.session.results as Row).w1 as Row).ok, true);
      assert.ok(t.seen[1]!.some((row) => row.role === "tool" && row.tool_call_id === "w1" && !String(row.content).includes("approval_required")));
    } finally { await t.close(); }
  });

  it("feeds a denial back to the model and keeps the turn going (turn-control.ts)", async () => {
    const t = await live([{ tool_calls: [writeCall("w1")] }, { content: "Understood, I will not write it." }]);
    try {
      const running = t.runner.run(t.session, { shouldStop: t.shouldStop });
      await until(() => t.waits.waiting(t.sid).length === 1);
      t.waits.answer(t.sid, "w1", "reject");
      await running;
      assert.equal(t.session.status, "completed");
      assert.equal(existsSync(join(t.workspace, "out.txt")), false);
      const denied = (t.session.results as Row).w1 as Row;
      assert.deepEqual([(denied.error as Row).code, (denied.data as Row).reason], ["permission_denied", "user_denied"]);
      assert.equal(t.seen.length, 2, "the model saw the denial in the same turn");
      assert.ok(t.seen[1]!.some((row) => row.role === "tool" && String(row.content).includes("permission_denied")));
      assert.equal(users(t.session), 1);
    } finally { await t.close(); }
  });

  it("cancels the wait when the user stops (broker.ts abort)", async () => {
    const t = await live([{ tool_calls: [writeCall("w1")] }]);
    try {
      const running = t.runner.run(t.session, { shouldStop: t.shouldStop });
      await until(() => t.waits.waiting(t.sid).length === 1);
      t.stop();
      await running;
      assert.equal(t.session.status, "stopped");
      assert.equal((((t.session.results as Row).w1 as Row).error as Row).code, "cancelled");
      assert.deepEqual(t.waits.waiting(t.sid), []);
      assert.equal(existsSync(join(t.workspace, "out.txt")), false);
      assert.equal(t.seen.length, 1);
    } finally { await t.close(); }
  });

  it("ends the turn when the user denies leaving plan mode (withPlanExitDeniedTurnStop)", async () => {
    const denied = withPlanExitDeniedTurnStop({ ok: false, output: "the user declined", error: { code: "permission_denied", message: "the user declined" } }, { tool: EXIT_PLAN_MODE_TOOL, planEnabled: true });
    const local = fixture([{ tool_calls: [call("p1"), call("r2")] }, { content: "never asked" }], [denied as unknown as Row, { ok: true }]);
    try {
      await local.runner.run(local.session);
      assert.equal(local.session.status, "paused"); assert.equal(local.session.pause_code, "plan_exit_denied");
      assert.equal(local.requests(), 1, "the model is not asked to rewrite the plan on its own");
      assert.equal(local.effects(), 1, "later calls of the step are not executed");
      assert.equal((((local.session.results as Row).r2 as Row).error_code), "run_paused");
    } finally { local.close(); }
  });
});
