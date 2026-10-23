import type { AgentExtension, ModelRequest } from "@xueness/agent";
import { afterGoalRun } from "./goal-driver.ts";
import { sanitizeGoal } from "./goal.ts";
import { beforeGoalRun } from "./goal-runtime.ts";
import { goalStateReminder } from "./goal-state.ts";
import type { GoalModelJson } from "./goal-verifier.ts";

function lightweight(context: Parameters<NonNullable<AgentExtension["prepareRequest"]>>[0]): boolean {
  return (context.session.runtime_profile ?? context.provider.runtimeProfile) === "lightweight";
}

function prepareGoalState(context: Parameters<NonNullable<AgentExtension["prepareRequest"]>>[0], request: ModelRequest, elapsedSeconds?: number): ModelRequest {
  const reminder = goalStateReminder(context.session, elapsedSeconds);
  if (!reminder) return request;
  if (lightweight(context)) {
    const injected = request.injected ?? [];
    const hostInstructions = request.hostInstructions ?? [];
    return {
      ...request,
      injected: injected.includes(reminder) ? injected : [...injected, reminder],
      hostInstructions: hostInstructions.includes(reminder) ? hostInstructions : [...hostInstructions, reminder],
    };
  }
  const prior = request.messages.filter((message) => message._meta_source !== "goal_state_change");
  const message = { role: "user", content: reminder, _meta_source: "goal_state_change" };
  const systemIndex = prior[0]?.role === "system" ? 1 : 0;
  return { ...request, messages: [...prior.slice(0, systemIndex), message, ...prior.slice(systemIndex)] };
}

export function planningGoalExtension(model: GoalModelJson, now = () => performance.now() / 1000): AgentExtension {
  let started: number | null = null, runGoalId: string | null = null;
  return { id: "planning", capabilities: ["planning.goal_driver"],
    beforeRun(context) {
      started = now(); const result = beforeGoalRun(context.session, context.enabled("planning"));
      const goal = sanitizeGoal(context.session.goal);
      runGoalId = result.enabled && goal?.status === "active" ? String(goal.id) : null;
      const seconds = typeof result.deadline_seconds === "number" ? result.deadline_seconds : undefined;
      if (seconds !== undefined && context.options.maxWallSeconds === undefined) { context.options.maxWallSeconds = seconds; context.deadline = now() + seconds; }
      return { stop: result.stop === true, ...(seconds !== undefined ? { deadlineSeconds: seconds } : {}) };
    },
    prepareRequest(context, request) { return prepareGoalState(context, request, started === null ? undefined : Math.max(0, now() - started)); },
    async afterRun(context) {
      const elapsedSeconds = started === null ? null : Math.max(0, now() - started);
      const decision = await afterGoalRun(context.session, context.provider, { enabled: context.enabled("planning"), model, goalId: runGoalId ?? undefined, shouldStop: () => context.signal.aborted || !context.enabled("planning") || !context.enabled("providers") || !!context.options.shouldStop?.(), signal: context.signal, requestDeadline: context.deadline, elapsedSeconds, now });
      if (decision.action === "continue" && typeof decision.prompt === "string") return { action: "continue", prompt: decision.prompt, exclusive: true };
    },
  };
}
