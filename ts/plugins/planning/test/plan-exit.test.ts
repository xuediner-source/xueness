/**
 * exit_plan_mode (ZCode ExitPlanMode). Cases follow ZCode v3.15.1 (aac4755,
 * Apache-2.0) core/tests/plan-mode-tool.test.ts: approval is asked before
 * leaving plan mode, approval returns the plan and leaves plan mode, no
 * approval is asked outside plan mode, and a denial ends the turn.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createToolEnv } from "@xueness/engine-tools";
import { Context, PluginHost } from "@xueness/kernel";
import { PermissionSession, type PermissionMode } from "@xueness/permissions";
import { ApprovalWaits, ToolBridge } from "@xueness/tool-bridge";
import { ALREADY_IN_PLAN_MODE_MESSAGE, approvedPlanContent, createPlanning, ENTERED_PLAN_MODE_CONTENT, normalizeTodos, NOT_IN_PLAN_MODE_MESSAGE, type PlanModePort } from "../src/index.ts";

const SID = "p".repeat(32);

async function setup(mode: PermissionMode) {
  const base = mkdtempSync(join(tmpdir(), "xueness-plan-exit-"));
  const workspace = join(base, "ws");
  mkdirSync(workspace);
  const permissions = new PermissionSession({ mode });
  const exits: string[] = [];
  const port: PlanModePort = {
    active: () => permissions.mode === "plan",
    exit: () => { permissions.setMode("build"); exits.push("build"); },
    enter: () => { permissions.setMode("plan"); exits.push("plan"); },
  };
  const kernel = Context.create();
  const host = new PluginHost(kernel, [createPlanning({ session: () => null, planMode: () => port })]);
  for (const status of await host.start()) assert.equal(status.state, "active", status.error ?? status.issues.join("; "));
  const waits = new ApprovalWaits();
  const bridge = new ToolBridge({ kernel, permissions, env: createToolEnv({ cwd: workspace, artifactsDir: join(base, "artifacts"), owner: "s" }), approver: waits.approver(SID) });
  const until = async (test: () => boolean) => { for (let i = 0; i < 100_000 && !test(); i += 1) await new Promise((resolve) => setImmediate(resolve)); assert.ok(test()); };
  return {
    permissions, waits, bridge, exits, until,
    async close() { await host.dispose(); await kernel.dispose(); rmSync(base, { recursive: true, force: true }); },
  };
}

const exitCall = (id: string, plan = "1. Do the thing\n2. Test it") => ({ id, name: "exit_plan_mode", input: { plan } });

describe("exit_plan_mode", () => {
  it("asks for approval before exiting plan mode and returns the approved plan", async () => {
    const s = await setup("plan");
    const pending = s.bridge.call(exitCall("x1"));
    await s.until(() => s.waits.waiting(SID).length === 1);
    const ask = s.waits.waiting(SID)[0]!;
    assert.equal(ask.code, "plan_exit");
    assert.equal(s.permissions.mode, "plan", "nothing changes before the answer");
    s.waits.answer(SID, "x1", "approve", undefined, "session");
    const result = await pending;
    assert.equal(result.ok, true, result.output);
    assert.equal(result.output, approvedPlanContent("1. Do the thing\n2. Test it"));
    assert.match(result.output, /^User has approved your plan\. You can now start coding\. Start with updating your todo list if applicable\.\n\n## Approved Plan:\n1\. Do the thing/);
    assert.equal(s.permissions.mode, "build");
    assert.deepEqual(s.exits, ["build"]);
    await s.close();
  });

  it("asks again every time: allow for this session never answers a plan exit", async () => {
    const s = await setup("plan");
    const first = s.bridge.call(exitCall("x1"));
    await s.until(() => s.waits.waiting(SID).length === 1);
    s.waits.answer(SID, "x1", "approve", undefined, "session");
    await first;
    s.permissions.setMode("plan");
    const second = s.bridge.call(exitCall("x2"));
    await s.until(() => s.waits.waiting(SID).length === 1);
    assert.equal(s.waits.waiting(SID)[0]!.code, "plan_exit");
    s.waits.answer(SID, "x2", "approve");
    assert.equal((await second).ok, true);
    await s.close();
  });

  it("ends the turn and stays in plan mode when the user rejects the plan", async () => {
    const s = await setup("plan");
    const pending = s.bridge.call(exitCall("x1"));
    await s.until(() => s.waits.waiting(SID).length === 1);
    s.waits.answer(SID, "x1", "reject");
    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal((result as { turn_control?: { reason?: string; stop_turn_after_result?: boolean } }).turn_control?.reason, "plan_exit_denied");
    assert.equal(s.permissions.mode, "plan");
    assert.deepEqual(s.exits, []);
    await s.close();
  });

  it("does not ask outside plan mode and tells the model it is not in plan mode", async () => {
    const s = await setup("build");
    const result = await s.bridge.call(exitCall("x1"));
    assert.equal(s.waits.waiting(SID).length, 0);
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "not_in_plan_mode");
    assert.equal(result.output, NOT_IN_PLAN_MODE_MESSAGE);
    await s.close();
  });
});

describe("enter_plan_mode", () => {
  it("enters plan mode without requesting approval and returns the ZCode guidance", async () => {
    const s = await setup("build");
    const result = await s.bridge.call({ id: "e1", name: "enter_plan_mode", input: {} });
    assert.equal(s.waits.waiting(SID).length, 0);
    assert.equal(result.ok, true, result.output);
    assert.equal(result.output, ENTERED_PLAN_MODE_CONTENT);
    assert.match(result.output, /^Entered plan mode\. You should now focus on exploring the codebase and designing an implementation approach\./);
    assert.equal(s.permissions.mode, "plan");
    await s.close();
  });

  it("says so when already in plan mode", async () => {
    const s = await setup("plan");
    const result = await s.bridge.call({ id: "e1", name: "enter_plan_mode", input: {} });
    assert.equal(result.error?.code, "already_in_plan_mode");
    assert.equal(result.output, ALREADY_IN_PLAN_MODE_MESSAGE);
    await s.close();
  });
});

describe("todo priority (ZCode TodoWrite)", () => {
  it("keeps a valid priority and drops anything else", () => {
    assert.deepEqual(normalizeTodos([{ id: "1", text: "a", priority: "high" }, { id: "2", text: "b", priority: "urgent" }]),
      [{ id: "1", text: "a", status: "pending", priority: "high" }, { id: "2", text: "b", status: "pending" }]);
  });
});
