/** The session-mode port behind exit_plan_mode (ZCode sessionModePort.exitPlanMode). */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PermissionSession } from "@xueness/permissions";
import type { Session } from "@xueness/sessions";
import { planModePort } from "../src/plan-mode-port.ts";

describe("planModePort", () => {
  it("leaves plan mode for build and records it on the session once", () => {
    const permissions = new PermissionSession({ mode: "plan" });
    const session = { mode: "plan", steps: 4, mode_history: [{ mode: "plan", steps: 0 }] } as unknown as Session;
    const port = planModePort(session, permissions, "plan");
    assert.equal(port.active(), true);
    port.exit();
    assert.equal(permissions.mode, "build");
    assert.equal(port.active(), false);
    assert.equal(session.mode, "build");
    port.exit();
    assert.deepEqual(session.mode_history, [{ mode: "plan", steps: 0 }, { mode: "build", steps: 4 }]);
  });

  it("returns to the run's own permission mode when that was not plan", () => {
    const permissions = new PermissionSession({ mode: "plan" });
    planModePort({ mode: "plan" } as unknown as Session, permissions, "yolo").exit();
    assert.equal(permissions.mode, "yolo");
  });
});

describe("planModePort.enter", () => {
  it("switches the run and the session into plan mode", () => {
    const permissions = new PermissionSession({ mode: "build" });
    const session = { mode: "build", steps: 2 } as unknown as Session;
    const port = planModePort(session, permissions, "build");
    port.enter!();
    assert.equal(permissions.mode, "plan");
    assert.equal(session.mode, "plan");
    assert.deepEqual(session.mode_history, [{ mode: "plan", steps: 2 }]);
    assert.equal(port.active(), true);
  });
});
