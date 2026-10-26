/**
 * In-process `TaskRegistry` (Python `task_registry.py`). Metadata only: the
 * prompt is counted, never stored. There is no cross-process session signal;
 * callers in this process see updates on the next read.
 */
import { numericValue, pyLen, pySlice, pyTruthy, uuid4Hex } from "@xueness/contracts";

const SUMMARY_MAX = 4000;
const ERROR_MAX = 500;
export const RUNNING = "running";
export const COMPLETED = "completed";
export const FAILED = "failed";
export const CANCELLED = "cancelled";
type Row = Record<string, unknown>;

const copy = (row: Row): Row => ({ ...row });

export class TaskRegistry {
  readonly #tasks = new Map<string, Row>();
  readonly #coordinators = new Map<string, object>();

  static newId(): string {
    return "task-" + uuid4Hex();
  }

  record(taskId: string, input: { parentSession: unknown; agent: unknown; prompt: unknown; root: unknown }): Row {
    const text = typeof input.prompt === "string" ? input.prompt : "";
    const existing = this.#tasks.get(taskId);
    const task: Row = {
      id: taskId, parent: input.parentSession,
      agent: typeof input.agent === "string" && input.agent ? input.agent : null,
      promptChars: pyLen(text), status: RUNNING, steps: 0, startedAt: Date.now() / 1000,
      endedAt: null, summary: "", error: "", root: input.root == null ? null : String(input.root),
    };
    if (existing?.status === CANCELLED) {
      task.status = CANCELLED;
      task.endedAt = existing.endedAt;
    }
    this.#tasks.set(taskId, task);
    return copy(task);
  }

  update(taskId: string, fields: Row): void {
    const task = this.#tasks.get(taskId);
    if (!task) return;
    for (const [key, value] of Object.entries(fields)) {
      if (key === "id" || key === "parent" || key === "startedAt") continue;
      task[key] = value;
    }
  }

  restore(taskId: string, input: { parentSession: unknown; root: unknown; record: Row }): void {
    if (this.#tasks.has(taskId)) return;
    const record = input.record;
    const terminal = record.status === COMPLETED || record.status === FAILED || record.status === CANCELLED;
    const task: Row = {
      id: taskId, parent: input.parentSession, root: String(input.root),
      agent: typeof record.agent === "string" ? record.agent : null,
      status: terminal ? record.status : FAILED,
      steps: record.steps ?? 0, promptChars: record.promptChars ?? 0,
      startedAt: record.startedAt, endedAt: record.endedAt,
      summary: pySlice(String(record.summary || ""), SUMMARY_MAX),
      error: terminal ? pySlice(String(record.error || ""), ERROR_MAX) : "interrupted before result collection",
      workerActive: false,
    };
    for (const key of ["childSessionId", "parentSessionId", "rootSessionId", "canResume", "recoveryReason", "childStatus", "termination"]) {
      if (Object.hasOwn(record, key)) task[key] = record[key];
    }
    this.#tasks.set(taskId, task);
  }

  restart(taskId: string): boolean {
    const task = this.#tasks.get(taskId);
    if (!task || task.workerActive === true || task.status === CANCELLED) return false;
    task.status = RUNNING;
    task.workerActive = true;
    task.endedAt = null;
    task.error = "";
    task.summary = "";
    // The previous attempt's outcome no longer describes this row: a stale
    // `termination` would misreport a clean re-run, and a stale `notified`
    // stamp would swallow the next completion reminder (C-WFL-04).
    delete task.termination;
    delete task.notified;
    return true;
  }

  finish(taskId: string, outcome: { ok: boolean; summary?: unknown; error?: unknown; steps?: unknown }): Row {
    const task = this.#tasks.get(taskId);
    if (!task) return {};
    if (task.status !== CANCELLED) task.status = outcome.ok ? COMPLETED : FAILED;
    task.endedAt = Date.now() / 1000;
    task.summary = pySlice(String(outcome.summary || ""), SUMMARY_MAX);
    task.error = pySlice(String(outcome.error || ""), ERROR_MAX);
    if (outcome.steps !== undefined) task.steps = outcome.steps;
    return copy(task);
  }

  get(taskId: string): Row | null {
    const task = this.#tasks.get(taskId);
    return task ? copy(task) : null;
  }

  list(parentSession?: unknown): Row[] {
    const tasks = [...this.#tasks.values()].filter((task) => parentSession === undefined || task.parent === parentSession).map(copy);
    tasks.sort(compareTasks);
    return tasks;
  }

  cancel(taskId: string): boolean {
    const task = this.#tasks.get(taskId);
    if (!task || task.status !== RUNNING) return false;
    task.status = CANCELLED;
    task.endedAt = Date.now() / 1000;
    return true;
  }

  isCancelled(taskId: string): boolean {
    return this.#tasks.get(taskId)?.status === CANCELLED;
  }

  forget(taskId: string): void {
    this.#tasks.delete(taskId);
  }

  clear(): void {
    this.#tasks.clear();
    this.#coordinators.clear();
  }

  bindParent(parentSession: unknown, coordinator: object | null): boolean {
    if (typeof parentSession !== "string" || coordinator == null) return false;
    const existing = this.#coordinators.get(parentSession);
    if (existing != null && existing !== coordinator) return false;
    this.#coordinators.set(parentSession, coordinator);
    return true;
  }

  unbindParent(parentSession: unknown, coordinator: object): void {
    if (this.#coordinators.get(String(parentSession)) === coordinator) this.#coordinators.delete(String(parentSession));
  }

  parentFor(parentSession: unknown): object | undefined {
    return this.#coordinators.get(String(parentSession));
  }
}

export function compareTasks(left: Row, right: Row): number {
  const started = startedKey(left) - startedKey(right);
  if (started !== 0) return started;
  return idKey(left) < idKey(right) ? -1 : idKey(left) > idKey(right) ? 1 : 0;
}

function startedKey(row: Row): number {
  if (!pyTruthy(row.startedAt)) return 0;
  const value = numericValue(row.startedAt);
  if (value === null || !Number.isFinite(value)) throw new TypeError("startedAt");
  return value;
}

function idKey(row: Row): string {
  if (!pyTruthy(row.id)) return "";
  if (typeof row.id !== "string") throw new TypeError("id");
  return row.id;
}

export function mirror(registry: TaskRegistry | null, parentSession: unknown): Row[] {
  return registry ? registry.list(parentSession) : [];
}
