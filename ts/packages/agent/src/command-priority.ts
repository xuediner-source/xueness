/**
 * Unified turn command queue and priority routing (ZCode
 * `runtime-command-queue.ts`): every runtime input — a user prompt, a
 * queued-message `startNow` promotion, mid-turn `guide` steering, a background
 * `task_notification`, or `goal_continuation` — is admitted through one
 * deterministic priority table with explicit merge boundaries, and one prompt
 * id is owned by at most one execution. Draining the queue resets reminder
 * state and transitions back to `idle`.
 */
import type { TurnPhase } from "./turn-state.ts";
import type { Row } from "./types.ts";

export type TurnCommandKind = "user_prompt" | "start_now" | "steer_guide" | "task_notification" | "goal_continuation";
/** Merge boundaries where a command may splice into the active execution. */
export type TurnBoundary = "before_run" | "before_model_request" | "before_final_response" | "after_run";

/** Deterministic priority, highest first: user actions before background continuations. */
export const COMMAND_PRIORITY_ORDER: readonly TurnCommandKind[] = [
  "user_prompt", "start_now", "steer_guide", "task_notification", "goal_continuation",
];
export const COMMAND_MERGE_BOUNDARIES: Readonly<Record<TurnCommandKind, readonly TurnBoundary[]>> = {
  // A fresh user prompt (and its startNow promotion) only starts work at a run boundary;
  // steering splices at runner-owned request boundaries; background inputs drive the
  // continuation loop after a run settles, with goal continuation last.
  user_prompt: ["before_run"],
  start_now: ["before_run"],
  steer_guide: ["before_model_request", "before_final_response"],
  task_notification: ["after_run"],
  goal_continuation: ["after_run"],
};
export const commandPriority = (kind: TurnCommandKind): number => COMMAND_PRIORITY_ORDER.indexOf(kind);

/** The formal turn phase table (C-WFL-01 state machine); `turn-state.ts` enforces it. */
export const TURN_TRANSITION_TABLE: Readonly<Record<TurnPhase, readonly TurnPhase[]>> = {
  idle: ["processing_input"],
  processing_input: ["awaiting_model_response", "completing"],
  awaiting_model_response: ["streaming", "completing", "error"],
  streaming: ["scheduling_tools", "aggregating_results", "completing", "error"],
  scheduling_tools: ["executing_tools", "awaiting_permission", "aggregating_results", "error"],
  executing_tools: ["aggregating_results", "awaiting_permission", "error"],
  awaiting_permission: ["executing_tools", "aggregating_results", "error"],
  aggregating_results: ["awaiting_model_response", "scheduling_tools", "completing", "error"],
  completing: [],
  error: [],
};

export interface TurnCommand {
  id: string;
  kind: TurnCommandKind;
  prompt: string;
  /** The turn a mid-turn command targets; null targets the next turn. */
  targetTurnId?: string | null;
  payload?: Row;
}
export interface TurnPromptClaim { commandId: string; turnId: string; claimId: string; claimedAt: string }

/** One prompt id belongs to at most one execution; claims are idempotent per turn. */
export class TurnPromptOwnership {
  readonly #claims = new Map<string, TurnPromptClaim>();
  claim(commandId: string, turnId: string, claimId: string, now = new Date().toISOString()): boolean {
    const existing = this.#claims.get(commandId);
    if (existing) return existing.turnId === turnId && existing.claimId === claimId;
    this.#claims.set(commandId, { commandId, turnId, claimId, claimedAt: now });
    return true;
  }
  claimOf(commandId: string): TurnPromptClaim | undefined { return this.#claims.get(commandId); }
  /** Releases the claim only when it still belongs to this turn (stale releases pass silently). */
  release(commandId: string, turnId: string): boolean {
    const existing = this.#claims.get(commandId);
    if (!existing || existing.turnId !== turnId) return false;
    this.#claims.delete(commandId);
    return true;
  }
  get size(): number { return this.#claims.size; }
}

export interface TurnQueueState {
  pending: Array<TurnCommand & { priority: number }>;
  activeCommandId: string | null;
  reminder: string | null;
  drainedAt: string | null;
}

/**
 * Priority-ordered runtime command queue. Enqueue is idempotent by command id;
 * `promote` (startNow) reorders without dropping or duplicating any queued user
 * message; `admit` dequeues at a merge boundary and resets reminder state
 * before the command runs; an empty `drain` settles the queue back to idle.
 */
export class TurnCommandRouter {
  readonly ownership: TurnPromptOwnership;
  readonly #queue: TurnCommand[] = [];
  #active: TurnCommand | null = null;
  #reminder: string | null = null;
  #drainedAt: string | null = null;
  constructor(ownership: TurnPromptOwnership = new TurnPromptOwnership()) { this.ownership = ownership; }
  /** Idempotent by id; equal priorities keep arrival order (stable splice). */
  enqueue(command: TurnCommand): TurnCommand {
    const existing = this.#queue.find((queued) => queued.id === command.id);
    if (existing) return existing;
    const priority = commandPriority(command.kind);
    let index = this.#queue.length;
    for (let position = 0; position < this.#queue.length; position += 1) {
      if (commandPriority(this.#queue[position]!.kind) > priority) { index = position; break; }
    }
    this.#queue.splice(index, 0, command);
    this.#drainedAt = null;
    return command;
  }
  /** startNow promotion: the promoted user prompt jumps the queue as a `start_now` command; every other message keeps its place. */
  promote(commandId: string): boolean {
    const index = this.#queue.findIndex((queued) => queued.id === commandId);
    if (index < 0) return false;
    const [command] = this.#queue.splice(index, 1);
    this.#queue.unshift({ ...command!, kind: "start_now" });
    return true;
  }
  pending(): readonly TurnCommand[] { return [...this.#queue]; }
  /** Commands whose kind may merge at this boundary, in priority order. */
  dueAt(boundary: TurnBoundary): readonly TurnCommand[] {
    return this.#queue.filter((queued) => COMMAND_MERGE_BOUNDARIES[queued.kind].includes(boundary));
  }
  /** Atomically admits the due commands at a boundary; reminders reset before a command runs. */
  admit(boundary: TurnBoundary): readonly TurnCommand[] {
    const due = this.dueAt(boundary);
    if (!due.length) return [];
    this.#reminder = null;
    for (const command of due) {
      const index = this.#queue.indexOf(command);
      if (index >= 0) this.#queue.splice(index, 1);
    }
    this.#active = due[0]!;
    return due;
  }
  /** Claims the admitted command for one execution before it runs. */
  claimFor(commandId: string, turnId: string, claimId: string): boolean {
    return this.ownership.claim(commandId, turnId, claimId);
  }
  releaseActive(turnId: string): void { if (this.#active) this.ownership.release(this.#active.id, turnId); }
  setReminder(reminder: string): void { this.#reminder = reminder; }
  get reminder(): string | null { return this.#reminder; }
  get activeCommandId(): string | null { return this.#active?.id ?? null; }
  /** Drains the queue in priority order; an empty drain settles to idle and resets reminders. */
  drain(now = new Date().toISOString()): readonly TurnCommand[] {
    const drained = [...this.#queue];
    this.#queue.length = 0;
    this.#active = null;
    this.#reminder = null;
    this.#drainedAt = now;
    return drained;
  }
  get idle(): boolean { return this.#queue.length === 0 && this.#active === null; }
  get drainedAt(): string | null { return this.#drainedAt; }
  snapshot(): TurnQueueState {
    return {
      pending: this.#queue.map((command) => ({ ...command, priority: commandPriority(command.kind) })),
      activeCommandId: this.activeCommandId,
      reminder: this.#reminder,
      drainedAt: this.#drainedAt,
    };
  }
}
