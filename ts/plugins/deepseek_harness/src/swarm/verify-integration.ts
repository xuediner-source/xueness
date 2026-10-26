/**
 * H07.05 — swarm ↔ harness verify integration.
 *
 * Wires the swarm's coordinated job run (H07.04) to the harness acceptance
 * gates (H02.01 auto-verify): when the swarm's slots finish, every job that
 * succeeded and produced a patch immediately triggers a verify pass scoped
 * to the path that job edited. Verify passes run concurrently under their
 * own slot budget (default 2, mirroring the solver pool), so a swarm of N
 * slots verifies at least 2 gates in parallel instead of serialising.
 *
 * Verify failures never abort sibling jobs: each pass is captured per job as
 * a `VerifySummary`, and the pipeline reports `ok: false` while the rest of
 * the swarm still completes.
 */

import {
  createAutoVerify,
  type AutoVerify,
  type CompressionLimits,
  type GateDefinition,
  type GateRunner,
  type VerifySummary,
} from "../builtins/auto-verify.ts";
import type { HarnessModel } from "../builtins/critic-solver.ts";
import { JobCoordinator, type CoordinationResult, type Progress, type SlotJob } from "./job-runner.ts";

/** A slot job plus the verify pass its completion triggered. */
export interface VerifiedSlotJob {
  readonly id: string;
  readonly task: string;
  readonly state: SlotJob["state"];
  readonly attempts: number;
  readonly error?: string;
  readonly patch?: SlotJob["patch"];
  readonly lastSlotId?: string;
  /** Paths handed to verify as `edited`; jobs without a patch verify all gates. */
  readonly edited: readonly string[];
  /** Verify summary; null when the job failed (no verify triggered). */
  readonly verify: VerifySummary | null;
}

export type VerifyEvent =
  | { type: "verify-start"; jobId: string; edited: readonly string[] }
  | { type: "verify-done"; jobId: string; passed: boolean; summary: string };

/** Aggregate outcome of the verify phase across the swarm. */
export interface VerifyPhaseReport {
  /** Jobs that completed successfully and therefore triggered verify. */
  readonly triggered: number;
  readonly passed: number;
  readonly failed: number;
  /** Skipped verify passes: failed jobs never trigger gates. */
  readonly skipped: number;
  /** Observed high-water mark of concurrent verify passes. */
  readonly maxConcurrent: number;
}

export interface SwarmVerifyResult {
  readonly jobs: readonly VerifiedSlotJob[];
  readonly progress: Progress;
  /** Raw coordinated run result, for supervisors that only want phase 1. */
  readonly coordination: CoordinationResult;
  readonly verify: VerifyPhaseReport;
  /** True when every job succeeded AND every triggered verify pass passed. */
  readonly ok: boolean;
}

export interface SwarmVerifyOptions {
  solver: HarnessModel;
  /** Acceptance gates the swarm triggers on completion (H02.01 definitions). */
  readonly gates: readonly GateDefinition[];
  /** Concurrent verify passes; default 2 (the integration's floor). */
  readonly verifySlots?: number;
  /** Solver slot budget per kind; defaults mirror JobCoordinator (2/1). */
  readonly solverSlots?: number;
  readonly criticSlots?: number;
  readonly maxRetries?: number;
  readonly retryDelayMs?: number;
  /** Auto-verify passthrough: cwd, runner, timeouts, compression, clock. */
  readonly cwd?: string;
  readonly run?: GateRunner;
  readonly defaultTimeoutMs?: number;
  readonly stopOnFirstFailure?: boolean;
  readonly limits?: CompressionLimits;
  readonly now?: () => number;
  /** Existing verifier to share (e.g. the host's); otherwise one is created. */
  readonly verifier?: AutoVerify;
  onEvent?: (event: VerifyEvent) => void;
}

/** Bounded-concurrency latch with an observed high-water mark. */
class ConcurrencyTracker {
  private active = 0;
  private readonly waiters: (() => void)[] = [];
  maxConcurrent = 0;
  readonly slots: number;

  constructor(slots: number) {
    if (!Number.isInteger(slots) || slots < 1) {
      throw new Error(`verifySlots must be a positive integer (got ${slots})`);
    }
    this.slots = slots;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    // Re-check after every wake-up: a new caller may have taken the freed
    // slot first, and the bound must hold even then.
    while (this.active >= this.slots) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active += 1;
    if (this.active > this.maxConcurrent) this.maxConcurrent = this.active;
    try {
      return await fn();
    } finally {
      this.active -= 1;
      const next = this.waiters.shift();
      if (next) next();
    }
  }
}

/**
 * Two-phase pipeline: (1) the JobCoordinator runs the swarm's jobs with
 * per-slot failure isolation; (2) each successful job triggers one auto-verify
 * pass scoped to its patch path, with at least `verifySlots` passes in
 * flight at once.
 */
export class SwarmVerifyPipeline {
  private readonly coordinator: JobCoordinator;
  private readonly verifier: AutoVerify;
  private readonly gate: ConcurrencyTracker;
  private readonly onEvent?: (event: VerifyEvent) => void;

  constructor(options: SwarmVerifyOptions) {
    const { gates, verifier, verifySlots, onEvent, ...coordinatorOptions } = options;
    this.coordinator = new JobCoordinator(coordinatorOptions);
    this.verifier = verifier ?? createAutoVerify({
      gates,
      cwd: options.cwd,
      run: options.run,
      defaultTimeoutMs: options.defaultTimeoutMs,
      stopOnFirstFailure: options.stopOnFirstFailure,
      limits: options.limits,
      now: options.now,
    });
    this.gate = new ConcurrencyTracker(verifySlots ?? 2);
    this.onEvent = onEvent;
  }

  /** Runs the swarm, then verifies every successful job's edited paths. */
  async run(tasks: readonly string[]): Promise<SwarmVerifyResult> {
    const coordination = await this.coordinator.run([...tasks]);
    const jobs = await Promise.all(coordination.jobs.map((job) => this.verifyJob(job)));
    const verify = this.report(jobs);
    return {
      jobs,
      progress: coordination.progress,
      coordination,
      verify,
      ok: coordination.ok && verify.failed === 0,
    };
  }

  private async verifyJob(job: SlotJob): Promise<VerifiedSlotJob> {
    if (job.state !== "succeeded") {
      return { ...job, edited: [], verify: null };
    }
    const edited = job.patch ? [job.patch.path] : [];
    this.onEvent?.({ type: "verify-start", jobId: job.id, edited });
    const verify = await this.gate.run(() => this.verifier.verify(edited));
    this.onEvent?.({ type: "verify-done", jobId: job.id, passed: verify.passed, summary: verify.summary });
    return { ...job, edited, verify };
  }

  private report(jobs: readonly VerifiedSlotJob[]): VerifyPhaseReport {
    const verified = jobs.filter((job) => job.verify !== null);
    const passed = verified.filter((job) => job.verify?.passed).length;
    return {
      triggered: verified.length,
      passed,
      failed: verified.length - passed,
      skipped: jobs.length - verified.length,
      maxConcurrent: this.gate.maxConcurrent,
    };
  }
}

/** Convenience wrapper: run + verify in one call, for hosts without a supervisor. */
export async function runSwarmWithVerify(options: SwarmVerifyOptions, tasks: readonly string[]): Promise<SwarmVerifyResult> {
  const pipeline = new SwarmVerifyPipeline(options);
  return pipeline.run(tasks);
}
