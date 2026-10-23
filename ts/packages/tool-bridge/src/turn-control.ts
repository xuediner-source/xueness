/**
 * Tool results that end the turn after they are recorded.
 *
 * Ported from ZCode v3.15.1 (aac4755, Apache-2.0)
 * `apps/zcode-cli/packages/core/src/tool/executor/turn-control.ts`
 * (withPlanExitDeniedTurnStop): a denied request to leave plan mode means the
 * user wants to keep discussing the plan, so it is not fed back for the model
 * to rewrite on its own. Every other denial is an ordinary tool result and the
 * turn continues.
 */
import type { ToolResult } from "@xueness/engine-tools";

/** The plan-mode exit tool (ZCode `ExitPlanMode`); the tool itself arrives with the plan-mode tools. */
export const EXIT_PLAN_MODE_TOOL = "exit_plan_mode";

export interface TurnControl {
  readonly reason: string;
  readonly stop_turn_after_result: true;
}

export function withPlanExitDeniedTurnStop(result: ToolResult, input: { tool: string; planEnabled: boolean }): ToolResult {
  if (!input.planEnabled || input.tool !== EXIT_PLAN_MODE_TOOL || result.ok) return result;
  const control: TurnControl = { reason: "plan_exit_denied", stop_turn_after_result: true };
  return { ...result, turn_control: control } as ToolResult;
}

/** The turn control a recorded result carries, if any. */
export function turnControlOf(result: unknown): TurnControl | null {
  if (typeof result !== "object" || result === null) return null;
  const control = (result as { turn_control?: unknown }).turn_control;
  if (typeof control !== "object" || control === null) return null;
  const value = control as Record<string, unknown>;
  return value.stop_turn_after_result === true && typeof value.reason === "string" ? { reason: value.reason, stop_turn_after_result: true } : null;
}
