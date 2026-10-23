/**
 * The session-mode port behind exit_plan_mode / enter_plan_mode (ZCode sessionModePort):
 * leaving plan mode switches this run's permissions to the run's own permission
 * mode (build when that was plan too) and records the build mode on the session.
 */
import type { Session } from "@xueness/sessions";
import type { PermissionMode, PermissionSession } from "@xueness/permissions";
import type { PlanModePort } from "@xueness/plugin-planning";

export function planModePort(session: Session, permissions: PermissionSession, permissionMode: PermissionMode): PlanModePort {
  return {
    active: () => permissions.mode === "plan",
    exit() {
      permissions.setMode(permissionMode === "plan" ? "build" : permissionMode);
      session.mode = "build";
      const history = Array.isArray(session.mode_history) ? session.mode_history as Record<string, unknown>[] : (session.mode_history = []) as Record<string, unknown>[];
      if (history.at(-1)?.mode !== "build") history.push({ mode: "build", steps: Number(session.steps ?? 0) });
    },
    enter() {
      permissions.setMode("plan");
      session.mode = "plan";
      const history = Array.isArray(session.mode_history) ? session.mode_history as Record<string, unknown>[] : (session.mode_history = []) as Record<string, unknown>[];
      if (history.at(-1)?.mode !== "plan") history.push({ mode: "plan", steps: Number(session.steps ?? 0) });
    },
  };
}
