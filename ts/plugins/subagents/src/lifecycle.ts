/**
 * F08.05 parent-child lifecycle: diagnosable termination, exclusive write
 * leases, budget attribution and cross-task recovery. Every terminal path —
 * targeted cancel, parent stop, child failure, worker crash, shutdown — funnels
 * through `terminateTask`, so a child that stops for any reason always leaves
 * behind a `termination` record on its registry row and never keeps a lease.
 */
import { isDict, pySlice } from "@xueness/contracts";
import { CANCELLED, COMPLETED, FAILED, RUNNING, TaskRegistry } from "./task-registry.ts";
import type { Row } from "./definitions.ts";

export const TERMINATION_REASONS = Object.freeze({
  parent_stop: "parent_stop",
  task_cancel: "task_cancel",
  budget_exhausted: "budget_exhausted",
  child_error: "child_error",
  crash_recovery: "crash_recovery",
  shutdown_timeout: "shutdown_timeout",
});
export type TerminationReason = keyof typeof TERMINATION_REASONS;
const DETAIL_MAX = 500;

/** Python-shaped and journal-durable: copied by `TaskRegistry.restore` and the coordinator's `sync`. */
export interface TerminationRecord { reason: TerminationReason; detail: string; at: number }

export function terminationReason(row: Row | null | undefined): TerminationReason | null {
  const termination = row?.termination;
  if (!isTermination(termination)) return null;
  return termination.reason;
}

export function isTermination(value: unknown): value is TerminationRecord {
  if (typeof value !== "object" || value === null) return false;
  const reason = (value as Row).reason;
  return typeof reason === "string" && reason in TERMINATION_REASONS && typeof (value as Row).at === "number";
}

const record = (reason: TerminationReason, detail: unknown, now: number): TerminationRecord =>
  ({ reason, detail: pySlice(typeof detail === "string" ? detail : "", DETAIL_MAX), at: now });

/**
 * Exclusive write leases with generations (MCP-pool style): a resource is held
 * by at most one task; an expired lease is taken over by the next acquire with
 * `generation + 1`, so a dead holder cannot wedge a resource forever while a
 * live holder's claim is never silently stolen.
 */
export const LEASE_TTL_MS = 120_000;

export interface TaskLease { resource: string; holder: string; generation: number; acquiredAt: number; expiresAt: number | null }
export type LeaseOutcome = { ok: true; lease: TaskLease; takeover: boolean } | { ok: false; lease: TaskLease };

export class TaskLeases {
  readonly #held = new Map<string, TaskLease>();
  readonly #generations = new Map<string, number>();
  #now: () => number = () => Date.now();
  #onRelease: ((lease: TaskLease) => void) | null = null;

  clock(now: () => number): this { this.#now = now; return this; }
  onRelease(handler: (lease: TaskLease) => void): this { this.#onRelease = handler; return this; }

  acquire(resource: string, holder: string, options: { ttlMs?: number | null } = {}): LeaseOutcome {
    const now = this.#now();
    const current = this.#held.get(resource);
    if (current && (current.expiresAt === null || current.expiresAt > now) && current.holder !== holder) return { ok: false, lease: current };
    const takeover = current?.holder !== holder;
    if (takeover) this.#generations.set(resource, (this.#generations.get(resource) ?? 0) + 1);
    const ttl = options.ttlMs === undefined ? LEASE_TTL_MS : options.ttlMs;
    const lease: TaskLease = { resource, holder, generation: this.#generations.get(resource) ?? 1, acquiredAt: now, expiresAt: ttl === null ? null : now + ttl };
    this.#held.set(resource, lease);
    return { ok: true, lease, takeover };
  }

  renew(resource: string, holder: string, ttlMs: number = LEASE_TTL_MS): boolean {
    const current = this.#held.get(resource);
    if (!current || current.holder !== holder) return false;
    current.expiresAt = this.#now() + ttlMs;
    return true;
  }

  release(resource: string, holder: string): TaskLease | null {
    const current = this.#held.get(resource);
    if (!current || current.holder !== holder) return null;
    this.#held.delete(resource);
    this.#onRelease?.(current);
    return current;
  }

  /** The failure path: everything one task holds, released at once. */
  releaseTask(holder: string): TaskLease[] {
    const released: TaskLease[] = [];
    for (const lease of [...this.#held.values()]) {
      if (lease.holder !== holder) continue;
      this.#held.delete(lease.resource);
      released.push(lease);
      this.#onRelease?.(lease);
    }
    return released;
  }

  /** Cross-task recovery: hand back leases whose holder died without renewing. */
  revokeExpired(): TaskLease[] {
    const now = this.#now();
    const revoked: TaskLease[] = [];
    for (const lease of [...this.#held.values()]) {
      if (lease.expiresAt === null || lease.expiresAt > now) continue;
      this.#held.delete(lease.resource);
      revoked.push(lease);
      this.#onRelease?.(lease);
    }
    return revoked;
  }

  heldBy(holder: string): TaskLease[] { return [...this.#held.values()].filter((lease) => lease.holder === holder); }
  get(resource: string): TaskLease | null { return this.#held.get(resource) ?? null; }
  list(): TaskLease[] { return [...this.#held.values()]; }
}

/**
 * Turn budget in abstract units. Dispatch reserves up front (the ceiling a
 * child may cost), `settle` replaces the reservation with the child's real
 * consumption once terminal — success, failure or cancel all attribute — and
 * `overBudget` gates new dispatch. Entries are kept after settlement so the
 * parent can always answer "which child spent what".
 */
export const DEFAULT_TASK_RESERVE = 8;

export interface BudgetEntry { taskId: string; reserved: number; charged: number; settled: boolean; settledAt: number | null }

export class TaskBudget {
  readonly #entries = new Map<string, BudgetEntry>();
  readonly total: number;

  constructor(total: number) { this.total = total; }

  remaining(): number {
    let committed = 0;
    for (const entry of this.#entries.values()) committed += entry.settled ? entry.charged : entry.reserved;
    return this.total - committed;
  }

  overBudget(units: number): boolean { return units > this.remaining(); }

  reserve(taskId: string, units: number = DEFAULT_TASK_RESERVE): boolean {
    if (this.overBudget(units)) return false;
    this.#entries.set(taskId, { taskId, reserved: units, charged: 0, settled: false, settledAt: null });
    return true;
  }

  /** `units` is what the child really consumed; a cancelled child settles at its reservation unless told otherwise. */
  settle(taskId: string, units?: number): BudgetEntry | null {
    const entry = this.#entries.get(taskId);
    if (!entry) return null;
    entry.charged = Math.max(0, units ?? entry.reserved);
    entry.settled = true;
    entry.settledAt = Date.now() / 1000;
    return { ...entry };
  }

  entry(taskId: string): BudgetEntry | null { const entry = this.#entries.get(taskId); return entry ? { ...entry } : null; }
  entries(): BudgetEntry[] { return [...this.#entries.values()].map((entry) => ({ ...entry })); }
  /** Attribution snapshot for a durable task row. */
  attribution(): { total: number; charged: number; tasks: Record<string, number> } {
    const tasks: Record<string, number> = {};
    let charged = 0;
    for (const entry of this.#entries.values()) { const cost = entry.settled ? entry.charged : entry.reserved; tasks[entry.taskId] = cost; charged += cost; }
    return { total: this.total, charged, tasks };
  }
}

/** Single terminal funnel: status + diagnosable reason + lease release, in that order. */
export function terminateTask(registry: TaskRegistry, leases: TaskLeases | null, taskId: string, outcome: { cancelled: boolean; ok?: boolean; reason?: TerminationReason; detail?: string; summary?: string; error?: string; steps?: number }): Row | null {
  const current = registry.get(taskId);
  if (!current || current.status !== RUNNING) return current ? { ...current } : null;
  const now = Date.now() / 1000;
  if (outcome.cancelled) registry.cancel(taskId);
  else registry.finish(taskId, { ok: outcome.ok === true, summary: outcome.summary, error: outcome.error, steps: outcome.steps });
  // A clean completion needs no reason; every abnormal terminal leaves one behind.
  if (outcome.cancelled || outcome.ok !== true) {
    const reason: TerminationReason = outcome.reason ?? (outcome.cancelled ? TERMINATION_REASONS.parent_stop : TERMINATION_REASONS.child_error);
    registry.update(taskId, { termination: record(reason, outcome.detail ?? outcome.error, now) });
  }
  registry.update(taskId, { workerActive: false });
  const released = leases?.releaseTask(taskId) ?? [];
  const row = registry.get(taskId);
  return row ? { ...row, releasedLeases: released.map((lease) => lease.resource) } : null;
}

export interface RecoveryReport { recovered: string[]; releasedLeases: string[]; revokedLeases: string[]; reasons: Record<string, TerminationReason> }

/**
 * Cross-task recovery after a restart or a coordinator swap: every registry
 * row still `running` without a live worker is an orphan. Each is terminated
 * with `crash_recovery` (its leases and budget settle through the same funnel)
 * and expired leases of already-terminal holders are revoked, so the next
 * dispatch starts from a clean, diagnosable state.
 */
export function recoverLifecycles(registry: TaskRegistry, leases: TaskLeases | null, options: { now?: () => number } = {}): RecoveryReport {
  if (options.now) leases?.clock(options.now);
  const report: RecoveryReport = { recovered: [], releasedLeases: [], revokedLeases: [], reasons: {} };
  const revoked = leases?.revokeExpired() ?? [];
  report.revokedLeases = revoked.map((lease) => `${lease.holder}:${lease.resource}`);
  for (const row of registry.list()) {
    if (row.status !== RUNNING) continue;
    const terminated = terminateTask(registry, leases, String(row.id), {
      cancelled: false, ok: false, reason: TERMINATION_REASONS.crash_recovery,
      detail: "parent run ended before the child reported a result",
    });
    if (!terminated) continue;
    const tid = String(row.id);
    report.recovered.push(tid);
    report.reasons[tid] = TERMINATION_REASONS.crash_recovery;
    const released = Array.isArray(terminated.releasedLeases) ? terminated.releasedLeases.map(String) : [];
    report.releasedLeases.push(...released);
  }
  return report;
}

// F08.02 — the unified background Dispatch/Collect/Resume state machine.

export const OPERATIONS = ["dispatch", "collect", "wait", "send_message", "resume"] as const;
export type TaskOperation = (typeof OPERATIONS)[number];

export interface LifecycleContext {
  /** The parent's coordinator still has a live worker for this task. */
  active: boolean;
  /** The task belongs to this parent's current turn records. */
  known: boolean;
}

const terminal = (status: unknown): boolean => status === COMPLETED || status === FAILED || status === CANCELLED;

/**
 * The legal operations for one task row (null: nothing recorded under this
 * id, so only `dispatch` remains). Rules:
 * - `running` allows non-blocking collect, bounded waits and (with a live
 *   worker) `send_message`; never `resume` — a running child is not stale.
 * - `completed` allows collect-while-uncollected and `resume` with a
 *   follow-up message (`followup_required`); `failed` allows both with the
 *   message optional (`safe_boundary`); `cancelled` is closed forever.
 */
export function nextOperations(task: Row | null, context: LifecycleContext): { operations: TaskOperation[]; resumeRequiresMessage: boolean | null; reason: string } {
  if (!isDict(task) || typeof task.status !== "string") return { operations: context.known ? [] : ["dispatch"], resumeRequiresMessage: null, reason: "no task recorded under this id" };
  const status = task.status;
  if (status === RUNNING) {
    const operations: TaskOperation[] = ["collect", "wait", ...(context.active ? ["send_message"] as TaskOperation[] : [])];
    return { operations, resumeRequiresMessage: null, reason: "task is running in the background; collect without waiting or guide it at a safe boundary" };
  }
  if (!terminal(status)) return { operations: [], resumeRequiresMessage: null, reason: "task status is not a lifecycle state: " + status };
  const operations: TaskOperation[] = ["collect"];
  if (status !== CANCELLED) operations.push("resume");
  return {
    operations,
    resumeRequiresMessage: status === COMPLETED ? true : false,
    reason: status === CANCELLED ? "cancelled tasks never resume" : status === COMPLETED ? "completed tasks continue only with a followup message" : "failed tasks may resume to retry at the safe boundary",
  };
}

export interface CollectSplit { fresh: Row[]; delivered: Row[]; pending: string[] }

/**
 * Deliver-once collection: split this turn's tasks into newly terminal and
 * never collected (`fresh` — the only rows a collect may return), terminal
 * rows a previous collect already returned (`delivered` — repeating them
 * would duplicate results), and still running ids (`pending` — what a bounded
 * wait would wait for).
 */
export function splitForCollect(records: Record<string, Row>, rows: readonly Row[]): CollectSplit {
  const split: CollectSplit = { fresh: [], delivered: [], pending: [] };
  for (const row of rows) {
    if (!isDict(row) || typeof row.id !== "string") continue;
    const record = records[row.id];
    if (row.status === RUNNING) { split.pending.push(row.id); continue; }
    if (!terminal(row.status)) continue;
    if (record && record.collected === true) split.delivered.push(row);
    else split.fresh.push(row);
  }
  return split;
}

export interface ReconnectVerdict { id: string; action: "keep" | "interrupt" | "drop"; status: string }

/**
 * What a parent process that comes back after a restart does with each
 * recorded task: terminal rows are kept as they were durable, rows that
 * claimed to be running with no worker behind them anymore are interrupted
 * (marked failed, collectable exactly once), and foreign or malformed rows
 * are dropped from the turn. Pure — the coordinator's constructor applies it.
 */
export function reconnectPlan(session: Row): ReconnectVerdict[] {
  const verdicts: ReconnectVerdict[] = [];
  const coordination = isDict(session.subagent_coordination) ? session.subagent_coordination : {};
  const saved = new Map<string, Row>();
  for (const row of Array.isArray(session.task_runs) ? session.task_runs : []) if (isDict(row) && typeof row.id === "string") saved.set(row.id, row);
  for (const [id, record] of Object.entries(coordination)) {
    if (!isDict(record)) continue;
    const row = saved.get(id);
    if (!row) { verdicts.push({ id, action: "drop", status: "missing" }); continue; }
    const status = typeof row.status === "string" ? row.status : "unknown";
    if (terminal(status)) verdicts.push({ id, action: "keep", status });
    else if (row.workerActive === true || status === RUNNING) verdicts.push({ id, action: "interrupt", status });
    else verdicts.push({ id, action: "keep", status });
  }
  return verdicts;
}

/** ZCode-style one-line guidance the tools reuse for their `next` hint. */
export function operationHint(task: Row | null, context: LifecycleContext): string {
  const { operations, reason } = nextOperations(task, context);
  if (!operations.length) return reason;
  if (operations.includes("collect") && task && terminal(task.status)) return "terminal result ready: collect it once with task_collect";
  if (operations.includes("wait")) return "still running: continue independent work, then task_collect (wait_seconds only for a dependency)";
  return "legal next operations: " + operations.join(", ");
}
