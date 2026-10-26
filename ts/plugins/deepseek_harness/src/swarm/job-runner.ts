/**
 * H07.04 — Swarm progress and failure isolation.
 *
 * The coordinator runs jobs on the swarm's slot pools (H07.03). Each job is
 * isolated: an exception, rejection or crash of one job is captured per slot,
 * retried up to `maxRetries`, and finally *marked* failed — it never rejects
 * the coordinated run, never aborts sibling slots, and never leaves a slot
 * stuck busy. `progress()` reports live counters so a supervisor can watch
 * the swarm advance while individual slots recover.
 */

import { SlotPool, type SlotKind } from "./critic-slots.ts";
import type { HarnessModel, ModelResponse, SolverPatch } from "../builtins/critic-solver.ts";
import { parseSolverPatch } from "../builtins/critic-solver.ts";

export type JobState = "pending" | "running" | "succeeded" | "retrying" | "failed";

export interface SlotJob {
  id: string;
  task: string;
  state: JobState;
  attempts: number;
  /** Populated once the job reaches a terminal state. */
  error?: string;
  patch?: SolverPatch | null;
  /** Slot that executed the latest attempt. */
  lastSlotId?: string;
}

export type CoordinatorEvent =
  | { type: "job-start"; jobId: string; slotId: string; attempt: number }
  | { type: "job-retry"; jobId: string; slotId: string; attempt: number; error: string }
  | { type: "job-succeeded"; jobId: string; slotId: string; attempt: number }
  | { type: "job-failed"; jobId: string; slotId: string; attempts: number; error: string };

export interface Progress {
  total: number;
  pending: number;
  running: number;
  succeeded: number;
  failed: number;
  /** succeeded + failed; equals total once the run settles. */
  settled: number;
}

export interface JobCoordinatorOptions {
  solver: HarnessModel;
  /** Slot budget per kind; solver default 2, critic default 1. */
  solverSlots?: number;
  criticSlots?: number;
  /** Retries per job after the first attempt; default 1. */
  maxRetries?: number;
  /** Delay between retries in ms; default 0 (tests inject 0). */
  retryDelayMs?: number;
  onEvent?: (event: CoordinatorEvent) => void;
}

export interface CoordinationResult {
  jobs: SlotJob[];
  progress: Progress;
  /** True when no job ended in `failed` (every task succeeded). */
  ok: boolean;
}

/** Live per-kind slot snapshot for supervisors. */
export interface JobSlotStatus {
  kind: SlotKind;
  total: number;
  busy: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Coordinates solver jobs across the swarm slots with per-job failure
 * isolation. Jobs run concurrently under the solver slot budget; each job's
 * exceptions are contained, retried, and finally marked, so one poisoned
 * task cannot drag down its siblings.
 */
export class JobCoordinator {
  private readonly solverPool: SlotPool;
  private readonly criticPool: SlotPool;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly jobs = new Map<string, SlotJob>();
  private callIndex = 0;

  private readonly options: JobCoordinatorOptions;

  constructor(options: JobCoordinatorOptions) {
    this.options = options;
    this.solverPool = new SlotPool("solver", options.solverSlots ?? 2);
    this.criticPool = new SlotPool("critic", options.criticSlots ?? 1);
    this.maxRetries = options.maxRetries ?? 1;
    if (!Number.isInteger(this.maxRetries) || this.maxRetries < 0) {
      throw new Error("coordinator requires maxRetries >= 0");
    }
    this.retryDelayMs = options.retryDelayMs ?? 0;
  }

  progress(): Progress {
    const list = [...this.jobs.values()];
    const count = (state: JobState) => list.filter((job) => job.state === state).length;
    const succeeded = count("succeeded");
    const failed = count("failed");
    return {
      total: list.length,
      pending: count("pending") + count("retrying"),
      running: count("running"),
      succeeded,
      failed,
      settled: succeeded + failed,
    };
  }

  slotStatuses(): JobSlotStatus[] {
    return [
      { kind: "solver", total: this.solverPool.size, busy: this.solverPool.busyCount },
      { kind: "critic", total: this.criticPool.size, busy: this.criticPool.busyCount },
    ];
  }

  jobSnapshot(): SlotJob[] {
    return [...this.jobs.values()].map((job) => ({ ...job }));
  }

  /** One isolated job attempt cycle: acquire slot, run, retry or mark. */
  private async runJob(job: SlotJob): Promise<void> {
    const maxAttempts = 1 + this.maxRetries;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const slot = await this.solverPool.acquire();
      let released = false;
      job.lastSlotId = slot.id;
      job.state = "running";
      this.options.onEvent?.({ type: "job-start", jobId: job.id, slotId: slot.id, attempt });
      try {
        const response: ModelResponse = await this.options.solver.complete({
          role: "solver",
          prompt: job.task,
          callIndex: (this.callIndex += 1),
        });
        job.patch = parseSolverPatch(response.text);
        job.attempts = attempt;
        job.state = "succeeded";
        this.options.onEvent?.({ type: "job-succeeded", jobId: job.id, slotId: slot.id, attempt });
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        job.attempts = attempt;
        job.error = message;
        if (attempt < maxAttempts) {
          job.state = "retrying";
          this.options.onEvent?.({ type: "job-retry", jobId: job.id, slotId: slot.id, attempt, error: message });
          // Hand the slot back before backing off, otherwise a retrying job
          // would idle-hold capacity its siblings could use.
          this.solverPool.release(slot);
          released = true;
          if (this.retryDelayMs > 0) await sleep(this.retryDelayMs);
          continue;
        }
        job.state = "failed";
        this.options.onEvent?.({ type: "job-failed", jobId: job.id, slotId: slot.id, attempts: attempt, error: message });
        return;
      } finally {
        // Always return the slot: a failed job must never leak its slot.
        if (!released) this.solverPool.release(slot);
      }
    }
  }

  /**
   * Runs all tasks with isolation. Resolves (never rejects) with one SlotJob
   * per task; failures appear as `{ state: "failed" }` entries while sibling
   * jobs still report `succeeded`.
   */
  async run(tasks: string[]): Promise<CoordinationResult> {
    if (tasks.some((task) => !task.trim())) throw new Error("coordinator requires non-empty tasks");
    this.jobs.clear();
    this.callIndex = 0;
    tasks.forEach((task, index) => {
      this.jobs.set(`job-${index}`, { id: `job-${index}`, task, state: "pending", attempts: 0 });
    });
    // Promise.all settles only if a job *escapes* runJob; runJob contains all
    // job errors, so sibling slots continue regardless of any single failure.
    await Promise.all([...this.jobs.values()].map((job) => this.runJob(job)));
    const progress = this.progress();
    return { jobs: this.jobSnapshot(), progress, ok: progress.failed === 0 };
  }
}
