/**
 * Budget wrap-up for standard-profile runs with a caller-supplied step or wall-time
 * bound (headless `--steps` / `--max-wall-seconds`, goal time budgets). Before the
 * request that crosses a threshold, one task-status reminder says how much budget
 * remains and asks the model to finish, save and summarize. It never changes the
 * bound, gates a tool or adds a model request. Runs without a bound (desktop and
 * web turns) and attended runs (CLI chat, whose default 8 steps are a per-turn
 * pause the person continues) are untouched; the lightweight profile keeps
 * `delivery-wrapup.ts`.
 *
 * SWE-bench 2026-11-25 (spark-x2.6, max effort, 1200 s): 26 of 50 runs hit the wall
 * and all 16 empty patches were runs that never changed a file. Single steps took up
 * to 700 s, so a reserve of three average steps came too late for 7 of them. Hence
 * the longest step so far also sets the wrap-up reserve, and a run that is half
 * through its budget without any file change gets one progress reminder.
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
  /** The slowest completed step of this run (model request plus its tools), or null before one. */
  longestStepSeconds?: number | null;
}

/**
 * 1 = wrap up: at most max(3, 15%) steps left, or at most max(15%, 3 average steps, the
 * longest step) of time; 2 = final step: at most 2 steps left, or at most max(5%, 1.5
 * average steps) of time. Time reserves never exceed half the budget. The first request
 * never gets one.
 */
export function budgetWrapupStage(facts: BudgetFacts): BudgetWrapupStage {
  const { limit, used, remainingSeconds, totalSeconds, averageStepSeconds } = facts;
  if (used < 1) return 0;
  const steps = limit === null ? null : limit - used;
  const reserve = (share: number, averageSteps: number, longestSteps: number): number => totalSeconds === null ? -Infinity
    : Math.min(totalSeconds * 0.5, Math.max(totalSeconds * share, (averageStepSeconds ?? 0) * averageSteps, (facts.longestStepSeconds ?? 0) * longestSteps));
  const seconds = remainingSeconds ?? Infinity;
  if (steps !== null && steps <= 2 || seconds <= reserve(0.05, 1.5, 0)) return 2;
  if (steps !== null && steps <= Math.max(3, Math.ceil(limit! * 0.15)) || seconds <= reserve(0.15, 3, 1)) return 1;
  return 0;
}

/** Step bounds below this (CLI `run` / `headless` default to 8) get no progress reminder. */
export const MIDPOINT_MIN_STEPS = 20;

/** Half of the time budget, or of a step bound of at least 20, is used (never on the first request). */
export function budgetHalfUsed(facts: BudgetFacts): boolean {
  if (facts.used < 1) return false;
  const stepsHalf = facts.limit !== null && facts.limit >= MIDPOINT_MIN_STEPS && facts.used >= facts.limit / 2;
  const timeHalf = facts.totalSeconds !== null && facts.remainingSeconds !== null && facts.remainingSeconds <= facts.totalSeconds / 2;
  return stepsHalf || timeHalf;
}

/** File tools whose success changes the workspace; shell edits are not seen here. */
const CHANGE_TOOLS = new Set(["edit", "write", "apply_patch"]);
const HONEST = "Do not claim checks passed that you did not run.";
const EVIDENCE = "End with the Evidence line naming the successful tool results the summary relies on.";
const NO_CHANGE = "No file has been changed in this run yet: if the task needs a change, write your best candidate now instead of ending with none.";

function remaining(steps: number | null, seconds: number | null): string {
  return [steps === null ? "" : `${steps} model step${steps === 1 ? "" : "s"} (including this one)`, seconds === null ? "" : `about ${seconds} seconds`].filter(Boolean).join(" and ");
}

export function budgetReminder(stage: BudgetWrapupStage | "midpoint", steps: number | null, seconds: number | null, changed: boolean): string {
  const left = remaining(steps, seconds);
  if (stage === "midpoint") {
    return `Progress check: about half of this run's budget is used (${left} remain) and no file has been changed with the file tools yet. If the task needs a code change and you already have a likely fix, write it now and refine it afterwards; keep exploring only while you have no candidate.`;
  }
  const unchanged = changed ? "" : ` ${NO_CHANGE}`;
  return stage < 2
    ? `Budget wrap-up: ${left} remain before this run stops. Finish the change you are in the middle of and make sure every change is written to files; do not start new exploration or broad refactors.${unchanged} Use what is left for at most one focused check, then end with a short summary: what changed, what was verified, and what is still unfinished. ${EVIDENCE} ${HONEST}`
    : `Final budget step: this is likely your last model step before the run stops (${left} remain). Do not start anything new.${unchanged} If a change is still unsaved, save it now; otherwise reply with the summary now: what changed, what was verified, and what is still unfinished. ${EVIDENCE} ${HONEST}`;
}

interface RunState { steps: number; started: number; last: number; longest: number; stage: BudgetWrapupStage; midpoint: boolean; changed: boolean }

export function budgetWrapup(now = () => performance.now() / 1000) {
  const runs = new WeakMap<Row, RunState>();
  // A goal may start several driver loops in one run: steps restart, the deadline does not.
  const origins = new WeakMap<Row, number>();
  const active = (context: AgentContext): boolean => context.options.attended !== true
    && (context.session.runtime_profile ?? context.provider.runtimeProfile) !== "lightweight"
    && (Number.isFinite(context.options.maxSteps ?? Infinity) || Number.isFinite(context.deadline));
  const remind = async (context: AgentContext, name: string, text: string, steps: number | null, seconds: number | null, averageStepSeconds: number | null): Promise<void> => {
    const messages = context.session.messages as Row[];
    messages.push({ role: "user", content: wrapSystemReminderForSource("task_status", text), _input_kind: "background_notice",
      _meta_source: "task_status", _budget_wrapup: name, _turn_id: messages.at(-1)?._turn_id });
    await context.save();
    context.emit({ type: "budget_wrapup", stage: name, remainingSteps: steps, remainingSeconds: seconds,
      averageStepSeconds: averageStepSeconds === null ? null : Math.round(averageStepSeconds) });
  };
  return {
    runStarted(context: AgentContext): void {
      if (!active(context)) return;
      const started = now();
      if (!origins.has(context.session)) origins.set(context.session, started);
      runs.set(context.session, { steps: Number(context.session.steps ?? 0), started, last: started, longest: 0, stage: 0, midpoint: false, changed: false });
    },
    toolResultRecorded(context: AgentContext, call: { name: string }, result: Row): void {
      const run = runs.get(context.session);
      if (run && result.ok === true && CHANGE_TOOLS.has(call.name)) run.changed = true;
    },
    async beforeModelRequest(context: AgentContext): Promise<void> {
      const run = runs.get(context.session);
      if (!run || run.stage === 2 || !active(context)) return;
      const at = now(), used = Number(context.session.steps ?? 0) - run.steps;
      if (used > 0) run.longest = Math.max(run.longest, at - run.last);
      run.last = at;
      const limit = Number.isFinite(context.options.maxSteps ?? Infinity) ? context.options.maxSteps! : null;
      const timed = Number.isFinite(context.deadline);
      const remainingSeconds = timed ? context.deadline - at : null;
      const totalSeconds = timed ? context.deadline - (origins.get(context.session) ?? run.started) : null;
      const averageStepSeconds = used > 0 ? (at - run.started) / used : null;
      const facts: BudgetFacts = { limit, used, remainingSeconds, totalSeconds, averageStepSeconds, longestStepSeconds: used > 0 ? run.longest : null };
      const stage = budgetWrapupStage(facts);
      const steps = limit === null ? null : Math.max(1, limit - used);
      const seconds = remainingSeconds === null ? null : Math.max(0, Math.floor(remainingSeconds));
      if (stage > run.stage) {
        run.stage = stage;
        await remind(context, stage === 2 ? "final" : "wrap_up", budgetReminder(stage, steps, seconds, run.changed), steps, seconds, averageStepSeconds);
        return;
      }
      if (stage === 0 && !run.midpoint && !run.changed && budgetHalfUsed(facts)) {
        run.midpoint = true;
        await remind(context, "midpoint", budgetReminder("midpoint", steps, seconds, false), steps, seconds, averageStepSeconds);
      }
    },
    close(context: AgentContext): void { runs.delete(context.session); origins.delete(context.session); },
  };
}
