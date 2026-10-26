/**
 * H07.03 — Native Critic review slots.
 *
 * Schedules Critic reviews on a slot pool that is fully separate from the
 * Solver slot pool. Solvers produce patches under a solver-slot budget and
 * each produced patch is queued for a Critic review executed under a critic
 * slot budget; the two pools never share capacity, so a burst of reviews
 * cannot starve solver throughput and vice versa (verified by per-kind
 * concurrency high-water marks in `SwarmStats`).
 *
 * Models are injected (`HarnessModel` from H02.05), so scheduling itself
 * performs no I/O.
 */

import {
  parseCriticReview,
  parseSolverPatch,
  type CriticReview,
  type HarnessModel,
  type ModelResponse,
  type SolverPatch,
} from "../builtins/critic-solver.ts";

export type SlotKind = "solver" | "critic";

export type SlotState = "idle" | "busy";

export interface SlotInfo {
  id: string;
  kind: SlotKind;
  state: SlotState;
  /** Jobs this slot has completed. */
  completed: number;
}

/**
 * Fixed-capacity pool for one slot kind. `acquire` resolves as soon as a
 * slot of this kind is free; capacity of the other kind is never consulted.
 */
export class SlotPool {
  readonly kind: SlotKind;
  private readonly slots: SlotInfo[] = [];
  private readonly idle: string[] = [];
  private readonly waiters: ((slot: SlotInfo) => void)[] = [];

  constructor(kind: SlotKind, size: number) {
    if (!Number.isInteger(size) || size < 1) throw new Error(`slot pool requires size >= 1 (got ${size})`);
    this.kind = kind;
    for (let index = 0; index < size; index += 1) {
      const slot: SlotInfo = { id: `${kind}-${index}`, kind, state: "idle", completed: 0 };
      this.slots.push(slot);
      this.idle.push(slot.id);
    }
  }

  get size(): number {
    return this.slots.length;
  }

  get busyCount(): number {
    return this.slots.filter((slot) => slot.state === "busy").length;
  }

  private byId(id: string): SlotInfo {
    const slot = this.slots.find((item) => item.id === id);
    if (!slot) throw new Error(`unknown slot ${id}`);
    return slot;
  }

  /** Resolves with a free slot, waiting when all slots of this kind are busy. */
  async acquire(): Promise<SlotInfo> {
    const id = this.idle.shift();
    if (id) {
      const slot = this.byId(id);
      slot.state = "busy";
      return slot;
    }
    return new Promise<SlotInfo>((resolve) => this.waiters.push(resolve));
  }

  /** Returns a slot to the pool and hands it to the longest-waiting acquirer. */
  release(slot: SlotInfo): void {
    // Releasing an idle slot would push its id onto the free list twice and
    // hand the same slot to two holders, breaking the capacity invariant.
    if (slot.state !== "busy") throw new Error(`slot ${slot.id} is not acquired`);
    slot.completed += 1;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(slot);
      return;
    }
    slot.state = "idle";
    this.idle.push(slot.id);
  }

  snapshot(): SlotInfo[] {
    return this.slots.map((slot) => ({ ...slot }));
  }
}

export type SwarmEvent =
  | { type: "job-start"; kind: SlotKind; slotId: string; jobId: string }
  | { type: "job-end"; kind: SlotKind; slotId: string; jobId: string }
  | { type: "review-queued"; jobId: string };

export interface ReviewOutcome {
  jobId: string;
  patch: SolverPatch | null;
  review: CriticReview;
  criticSlotId: string;
  solverSlotId: string;
}

export interface SwarmStats {
  solver: SlotInfo[];
  critic: SlotInfo[];
  /** Observed high-water marks; each must stay <= its pool size. */
  maxConcurrent: Record<SlotKind, number>;
  queuedReviews: number;
  completedReviews: number;
}

export interface CriticSlotOptions {
  solver: HarnessModel;
  critic: HarnessModel;
  /** Solver slot budget; default 2. */
  solverSlots?: number;
  /** Critic slot budget, independent of solverSlots; default 1. */
  criticSlots?: number;
  onEvent?: (event: SwarmEvent) => void;
}

interface PendingReview {
  jobId: string;
  patch: SolverPatch | null;
  solverSlotId: string;
  /** Set when the solver attempt threw; the review is then skipped and reported malformed. */
  solverError?: string;
}

/** Review stand-in for a job whose solver or critic call failed. */
function unreviewed(reason: string): CriticReview {
  return { verdict: "reject", score: 0, reasons: [reason], malformed: true };
}

/**
 * Orchestrates solver tasks and critic reviews on two disjoint slot pools.
 * Solver slots are released as soon as a patch is queued for review, so the
 * critic pool is the only consumer of review work and vice versa.
 */
export class CriticSlotScheduler {
  private readonly solverPool: SlotPool;
  private readonly criticPool: SlotPool;
  private readonly maxConcurrent: Record<SlotKind, number> = { solver: 0, critic: 0 };
  private readonly reviewQueue: PendingReview[] = [];
  private readonly outcomes: ReviewOutcome[] = [];
  private readonly drainWaiters: ((outcomes: ReviewOutcome[]) => void)[] = [];
  private completedReviews = 0;

  private readonly options: CriticSlotOptions;

  constructor(options: CriticSlotOptions) {
    this.options = options;
    this.solverPool = new SlotPool("solver", options.solverSlots ?? 2);
    this.criticPool = new SlotPool("critic", options.criticSlots ?? 1);
  }

  stats(): SwarmStats {
    return {
      solver: this.solverPool.snapshot(),
      critic: this.criticPool.snapshot(),
      maxConcurrent: { ...this.maxConcurrent },
      queuedReviews: this.reviewQueue.length,
      completedReviews: this.completedReviews,
    };
  }

  private track(kind: SlotKind): void {
    const busy = kind === "solver" ? this.solverPool.busyCount : this.criticPool.busyCount;
    if (busy > this.maxConcurrent[kind]) this.maxConcurrent[kind] = busy;
  }

  /** Runs one solver job on the solver pool and queues its patch for review. */
  private async solveTask(task: string, callIndex: () => number): Promise<void> {
    const slot = await this.solverPool.acquire();
    const jobId = `solve:${slot.id}:${slot.completed + 1}`;
    this.options.onEvent?.({ type: "job-start", kind: "solver", slotId: slot.id, jobId });
    this.track("solver");
    let patch: SolverPatch | null = null;
    let solverError: string | undefined;
    try {
      const response: ModelResponse = await this.options.solver.complete({
        role: "solver",
        prompt: task,
        callIndex: callIndex(),
      });
      patch = parseSolverPatch(response.text);
    } catch (error) {
      // A failed solver call must not reject the coordinated run; the job is
      // queued anyway and surfaces as a malformed review (see run()).
      solverError = error instanceof Error ? error.message : String(error);
    } finally {
      this.reviewQueue.push({ jobId, patch, solverSlotId: slot.id, solverError });
      this.options.onEvent?.({ type: "review-queued", jobId });
      this.options.onEvent?.({ type: "job-end", kind: "solver", slotId: slot.id, jobId });
      this.solverPool.release(slot);
    }
  }

  /** Consumes one queued review on the critic pool. */
  private async runReview(callIndex: () => number): Promise<boolean> {
    const pending = this.reviewQueue.shift();
    if (!pending) return false;
    const slot = await this.criticPool.acquire();
    const jobId = `review:${pending.jobId}`;
    this.options.onEvent?.({ type: "job-start", kind: "critic", slotId: slot.id, jobId });
    this.track("critic");
    try {
      let review: CriticReview;
      if (pending.solverError !== undefined) {
        review = unreviewed(`solver failed: ${pending.solverError}`);
      } else {
        try {
          const response: ModelResponse = await this.options.critic.complete({
            role: "critic",
            prompt: JSON.stringify({ task: pending.patch?.summary ?? "", patch: pending.patch }),
            callIndex: callIndex(),
          });
          review = parseCriticReview(response.text);
        } catch (error) {
          review = unreviewed(`critic failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      this.outcomes.push({ jobId: pending.jobId, patch: pending.patch, review, criticSlotId: slot.id, solverSlotId: pending.solverSlotId });
      this.completedReviews += 1;
      return true;
    } finally {
      this.options.onEvent?.({ type: "job-end", kind: "critic", slotId: slot.id, jobId });
      this.criticPool.release(slot);
    }
  }

  /**
   * Runs all tasks to completion: solver jobs fill the review queue while
   * critic slots drain it. Returns one review outcome per task, in the
   * order each patch was queued.
   */
  async run(tasks: string[]): Promise<ReviewOutcome[]> {
    if (tasks.some((task) => !task.trim())) throw new Error("critic-slots requires non-empty tasks");
    let calls = 0;
    const callIndex = () => (calls += 1);
    this.outcomes.length = 0;
    this.completedReviews = 0;

    const solvers = tasks.map((task) => this.solveTask(task, callIndex));
    const draining = (async () => {
      for (;;) {
        const progressed = await this.runReview(callIndex);
        if (!progressed && this.outcomes.length >= tasks.length) break;
        if (!progressed) await new Promise((resolve) => setTimeout(resolve, 0));
      }
    })();

    await Promise.all([...solvers, draining]);
    return [...this.outcomes];
  }
}
