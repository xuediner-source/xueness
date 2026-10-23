/**
 * exit_plan_mode (ZCode `ExitPlanMode`): ask the user to approve the plan and,
 * once approved, leave plan mode for the rest of the turn.
 *
 * Ported from ZCode v3.15.1 (aac4755, Apache-2.0)
 * `apps/zcode-cli/packages/core/src/tool/handlers/plan-mode.ts` (exitPlanModeHandler,
 * formatExitPlanModeModelContent). The approval itself is the permission
 * policy's `plan_exit` ask; a denied exit ends the turn (tool-bridge turn-control).
 */
import { failure, type ToolDefinition } from "@xueness/engine-tools";

/** What the host lets the tool see and change of the session's mode (ZCode sessionModePort). */
export interface PlanModePort {
  active(): boolean;
  /** Leave plan mode; the run's permission mode applies from the next call on. */
  exit(): void;
  /** Enter plan mode (EnterPlanMode); read-only from the next call on. */
  enter?(): void;
}
export interface ExitPlanModeInput { plan: string; allowedPrompts?: { tool: string; prompt: string }[] }
export interface ExitPlanModeData { approved: true; plan: string; mode: string; previousMode: "plan" }

export const NOT_IN_PLAN_MODE_MESSAGE =
  "You are not in plan mode. This tool is only for exiting plan mode after writing a plan. If your plan was already approved, continue with implementation.";

export function approvedPlanContent(plan: string): string {
  const text = plan.trim();
  if (!text) return "User has approved exiting plan mode. You can now proceed.";
  return `User has approved your plan. You can now start coding. Start with updating your todo list if applicable.\n\n## Approved Plan:\n${text}`;
}

export function exitPlanModeTool(port: () => PlanModePort | null): ToolDefinition<ExitPlanModeInput, ExitPlanModeData> {
  return {
    name: "exit_plan_mode",
    description: "Present the finished plan for the user's approval and leave plan mode once it is approved.",
    gate: "plan_exit", mutating: false, concurrencySafe: false, requires: {},
    inputSchema: {
      type: "object", required: ["plan"],
      properties: {
        plan: { type: "string", minLength: 1, maxLength: 20_000, description: "The plan the user reviews before implementation starts." },
        allowedPrompts: { type: "array", items: { type: "object", additionalProperties: false, required: ["tool", "prompt"], properties: { tool: { type: "string", enum: ["Bash"] }, prompt: { type: "string" } } } },
      },
    },
    subject: (input) => input.plan,
    subjectKind: "text",
    async run(input) {
      const mode = port();
      if (!mode?.active()) return failure("not_in_plan_mode", NOT_IN_PLAN_MODE_MESSAGE);
      mode.exit();
      return { ok: true, output: approvedPlanContent(input.plan), data: { approved: true, plan: input.plan, mode: "build", previousMode: "plan" } };
    },
  };
}

/** ZCode formatEnterPlanModeModelContent. */
export const ENTERED_PLAN_MODE_CONTENT = `Entered plan mode. You should now focus on exploring the codebase and designing an implementation approach.

In plan mode, you should:
1. Thoroughly explore the codebase to understand existing patterns
2. Identify similar features and architectural approaches
3. Consider multiple approaches and their trade-offs
4. Use AskUserQuestion if you need to clarify the approach
5. Design a concrete implementation strategy
6. When ready, use ExitPlanMode to present your plan for approval

Remember: DO NOT write or edit any files yet. This is a read-only exploration and planning phase.`;
export const ALREADY_IN_PLAN_MODE_MESSAGE = "You are already in plan mode. Continue exploring and designing, then use ExitPlanMode to present your plan for approval.";

/** enter_plan_mode (ZCode `EnterPlanMode`): switch the session into plan mode without asking. */
export function enterPlanModeTool(port: () => PlanModePort | null): ToolDefinition<Record<string, never>, { mode: "plan"; previousMode: string }> {
  return {
    name: "enter_plan_mode",
    description: "Switch into read-only plan mode to explore and design before implementing.",
    gate: "plan_enter", mutating: false, concurrencySafe: false, requires: {},
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    async run() {
      const mode = port();
      if (!mode?.enter) return failure("unsupported", "Plan mode is not available in this session.");
      if (mode.active()) return failure("already_in_plan_mode", ALREADY_IN_PLAN_MODE_MESSAGE);
      mode.enter();
      return { ok: true, output: ENTERED_PLAN_MODE_CONTENT, data: { mode: "plan", previousMode: "build" } };
    },
  };
}
