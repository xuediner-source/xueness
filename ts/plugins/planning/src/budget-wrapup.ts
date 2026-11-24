/**
 * Budget wrap-up for standard-profile runs with a caller-supplied step or wall-time
 * bound (headless `--steps` / `--max-wall-seconds`, goal time budgets). Before the
 * request that crosses a threshold, one task-status reminder says how much budget
 * remains and asks the model to finish, save and summarize. It never changes the
 * bound, gates a tool or adds a model request. Runs without a bound (desktop and
 * web turns) and attended runs (CLI chat, whose default 8 steps are a per-turn
 * pause the person continues) are untouched; the lightweight profile keeps
 * `delivery-wrapup.ts`.
 */
import { wrapSystemReminderForSource, type AgentContext, type Row } from "@xueness/agent";

export type BudgetWrapupStage = 0 | 1 | 2;
export interface BudgetFacts {
  /** The run's step bound, or null without one. */
  limit: number | null;
  /** Model steps this run has completed. */
  used: number;
  /** Seconds until the wall-time deadline, or null without one. */
  remainingSeconds: number | null;
  /** The whole wall-time budget in seconds, or null without one. */
  totalSeconds: number | null;
  averageStepSeconds: number | null;
}

/**
 * 1 = wrap up: at most max(3, 15%) steps left, or at most max(15%, 3 average steps)
 * of time; 2 = final step: at most 2 steps left, or at most max(5%, 1.5 average steps)
 * of time. Time reserves never exceed half the budget. The first request never gets one.
 */
export function budgetWrapupStage(facts: BudgetFacts): BudgetWrapupStage {
  const { limit, used, remainingSeconds, totalSeconds, averageStepSeconds } = facts;
  if (used < 1) return 0;
  const steps = limit === null ? null : limit - used;
  const reserve = (share: number, averageSteps: number): number => totalSeconds === null ? -Infinity
    : Math.min(totalSeconds * 0.5, Math.max(totalSeconds * share, (averageStepSeconds ?? 0) * averageSteps));
  const seconds = remainingSeconds ?? Infinity;
  if (steps !== null && steps <= 2 || seconds <= reserve(0.05, 1.5)) return 2;
  if (steps !== null && steps <= Math.max(3, Math.ceil(limit! * 0.15)) || seconds <= reserve(0.15, 3)) return 1;
  return 0;
}

function reminder(stage: BudgetWrapupStage, steps: number | null, seconds: number | null): string {
  const left = [steps === null ? "" : `${steps} model step${steps === 1 ? "" : "s"} (including this one)`, seconds === null ? "" : `about ${seconds} seconds`].filter(Boolean).join(" and ");
  const honest = "Do not claim checks passed that you did not run.";
  return stage < 2
    ? `Budget wrap-up: ${left} remain before this run stops. Finish the change you are in the middle of and make sure every change is written to files; do not start new exploration or broad refactors. Use what is left for at most one focused check, then end with a short summary: what changed, what was verified, and what is still unfinished. ${honest}`
    : `Final budget step: this is likely your last model step before the run stops (${left} remain). Do not start anything new. If a change is still unsaved, save it now; otherwise reply with the summary now: what changed, what was verified, and what is still unfinished. ${honest}`;
}

export function budgetWrapup(now = () => performance.now() / 1000) {
  const runs = new WeakMap<Row, { steps: number; started: number; stage: BudgetWrapupStage }>();
  // A goal may start several driver loops in one run: steps restart, the deadline does not.
  const origins = new WeakMap<Row, number>();
  const active = (context: AgentContext): boolean => context.options.attended !== true
    && (context.session.runtime_profile ?? context.provider.runtimeProfile) !== "lightweight"
    && (Number.isFinite(context.options.maxSteps ?? Infinity) || Number.isFinite(context.deadline));
  return {
    runStarted(context: AgentContext): void {
      if (!active(context)) return;
      const started = now();
      if (!origins.has(context.session)) origins.set(context.session, started);
      runs.set(context.session, { steps: Number(context.session.steps ?? 0), started, stage: 0 });
    },
    async beforeModelRequest(context: AgentContext): Promise<void> {
      const run = runs.get(context.session);
      if (!run || run.stage === 2 || !active(context)) return;
      const at = now(), used = Number(context.session.steps ?? 0) - run.steps;
      const limit = Number.isFinite(context.options.maxSteps ?? Infinity) ? context.options.maxSteps! : null;
      const timed = Number.isFinite(context.deadline);
      const remainingSeconds = timed ? context.deadline - at : null;
      const totalSeconds = timed ? context.deadline - (origins.get(context.session) ?? run.started) : null;
      const averageStepSeconds = used > 0 ? (at - run.started) / used : null;
      const stage = budgetWrapupStage({ limit, used, remainingSeconds, totalSeconds, averageStepSeconds });
      if (stage <= run.stage) return;
      run.stage = stage;
      const steps = limit === null ? null : Math.max(1, limit - used);
      const seconds = remainingSeconds === null ? null : Math.max(0, Math.floor(remainingSeconds));
      const messages = context.session.messages as Row[];
      const name = stage === 2 ? "final" : "wrap_up";
      messages.push({ role: "user", content: wrapSystemReminderForSource("task_status", reminder(stage, steps, seconds)), _input_kind: "background_notice",
        _meta_source: "task_status", _budget_wrapup: name, _turn_id: messages.at(-1)?._turn_id });
      await context.save();
      context.emit({ type: "budget_wrapup", stage: name, remainingSteps: steps, remainingSeconds: seconds,
        averageStepSeconds: averageStepSeconds === null ? null : Math.round(averageStepSeconds) });
    },
    close(context: AgentContext): void { runs.delete(context.session); origins.delete(context.session); },
  };
}
