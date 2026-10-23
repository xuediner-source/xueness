/**
 * The durable off-peak queue (`OffPeakQueue` in
 * `xueness/bundled_plugins/automation/off_peak.py`).
 *
 * One JSON array of task rows under `<state>/offpeak.json`, replaced atomically
 * while the dedicated `.offpeak.lock` is held. A claim moves one queued row to
 * `running` exactly once and freezes a snapshot; the workflow behind it is
 * created and launched through the §4 `WorkflowBridge`, so this module never
 * imports the workflows plugin. Nothing here grants a capability: an unattended
 * run still needs the operator's approval of the immutable plan digest, and the
 * host still decides whether a real provider may be called at all.
 */
import { join } from "node:path";
import { isDict, pySlice, pyStr, pyTruthy, PyValueError, uuid4Hex } from "@xueness/contracts";
import { isPyKeyError, isPyOSError, isPyValueError, realish } from "@xueness/sessions";
import {
  ACTIVE, appendHistory, errorText, hostIsIdle, inWindow, MAX_QUEUE_BYTES, MAX_TASKS, nextWindowOpen, pick,
  planFor, QUEUE_FILE, requireEnabled, RUNNING, SETTINGS_FILE, timestamp, type Row, type WorkflowBridge,
} from "./off-peak.ts";
import { buildTaskRow, readStateFile, stopWorkflow, withQueueLock, writeStateJson } from "./off-peak-state.ts";
import { readSettings, writeSettings } from "./off-peak-settings.ts";

/** A task a caller may still edit, approve or cancel. */
const EDITABLE: ReadonlySet<unknown> = new Set(["queued", "failed"]);
/** A status a task never leaves on its own. */
const SETTLED: ReadonlySet<unknown> = new Set(["completed", "cancelled"]);

export interface OffPeakOptions {
  clock?: () => number;
  allowRealHost?: boolean;
  idleCheck?: (state: string) => boolean;
  bridge?: WorkflowBridge;
}

export class OffPeakQueue {
  readonly state: string;
  readonly clock: () => number;
  readonly allowRealHost: boolean;
  readonly path: string;
  readonly settingsPath: string;
  readonly #bridge: WorkflowBridge | null;
  readonly #idleCheck: (state: string) => boolean;

  constructor(state: string, options: OffPeakOptions = {}) {
    this.state = realish(state);
    this.clock = options.clock ?? (() => Date.now() / 1000);
    this.allowRealHost = options.allowRealHost === true;
    this.#bridge = options.bridge ?? null;
    const check = options.idleCheck;
    // `idle_check if callable(idle_check) else lambda: host_is_idle(self.state)`
    this.#idleCheck = typeof check === "function" ? check : (directory: string) => hostIsIdle(directory, this.#bridge);
    this.path = join(this.state, QUEUE_FILE);
    this.settingsPath = join(this.state, SETTINGS_FILE);
  }

  // ------------------------------------------------------------------ reads

  /** `_rows`: the stored task array, or an empty one before the first write. */
  #rows(): Row[] {
    const rows = readStateFile(this.path, MAX_QUEUE_BYTES, "队列");
    if (rows === undefined) return [];
    if (!Array.isArray(rows)) throw new PyValueError("闲时队列必须是 JSON 数组");
    return rows as Row[];
  }

  list(): Row[] { return this.#rows(); }

  get(taskId: string): Row | undefined { return this.#rows().find((row) => pick(row, "id") === taskId); }

  settings(): Row { return readSettings(this.state); }

  overview(): Row {
    const settings = this.settings();
    const now = this.clock();
    const window = settings.window as Row;
    const zone = settings.timezone as string | null;
    return {
      tasks: this.list(), settings, windowOpen: inWindow(now, window, zone),
      nextWindowAt: ((next) => typeof next === "number" ? timestamp(next) : next)(nextWindowOpen(now, window, zone)),
    };
  }

  /** `_window_of`: the task's own window and zone, falling back to the settings. */
  #windowOf(row: Row): [Row, string | null] {
    const settings = this.settings();
    const stored = pick(row, "window");
    const own = pick(row, "timezone");
    return [
      pyTruthy(stored) ? (stored as Row) : (settings.window as Row),
      own !== null ? (own as string | null) : (settings.timezone as string | null),
    ];
  }

  // ------------------------------------------------------------ queue edits

  /** `_mutate`: read, edit and replace the queue under the queue lock. */
  #mutate<T>(body: (rows: Row[]) => T): T {
    return withQueueLock(this.state, () => {
      const rows = this.#rows();
      const result = body(rows);
      writeStateJson(this.path, rows);
      return result;
    });
  }

  add(data: unknown): Row {
    requireEnabled(this.state);
    if (!isDict(data)) throw new PyValueError("闲时任务必须是一个对象");
    const row = buildTaskRow(data, this.clock());
    this.#mutate((rows) => {
      if (rows.length >= MAX_TASKS) throw new PyValueError(`闲时队列已满（上限 ${MAX_TASKS} 项）`);
      rows.push(row);
    });
    return row;
  }

  approve(taskId: string, options: { allowReal?: unknown; confirmed?: unknown } = {}): Row {
    requireEnabled(this.state);
    // `confirmed is not True`: only the literal `True` counts.
    if (options.confirmed !== true) throw new PyValueError("需要先确认所批准的不可变计划");
    if (options.allowReal === true && !this.allowRealHost) throw new PyValueError("real provider disabled by host");
    const now = timestamp(this.clock());
    return this.#mutate((rows) => {
      const row = rows.find((item) => pick(item, "id") === taskId);
      if (row === undefined) throw new PyValueError("闲时任务不存在");
      if (!EDITABLE.has(pick(row, "status"))) throw new PyValueError("只有排队中的任务可以批准");
      row.approved = true;
      row.allowReal = options.allowReal === true;
      row.status = "queued";
      row.nextEligibleAt = now;
      row.holdUntil = null;
      return row;
    });
  }

  cancel(taskId: string): Row {
    requireEnabled(this.state);
    const now = timestamp(this.clock());
    let cancelRun: unknown = null;
    const result = this.#mutate((rows) => {
      const row = rows.find((item) => pick(item, "id") === taskId);
      if (row === undefined) throw new PyValueError("闲时任务不存在");
      if (!SETTLED.has(pick(row, "status"))) {
        if (pick(row, "status") === RUNNING) cancelRun = pick(row, "workflowId");
        row.status = "cancelled";
        row.finishedAt = now;
        appendHistory(row, { id: uuid4Hex(), at: now, status: "cancelled", workflowId: pick(row, "workflowId") });
      }
      return row;
    });
    // A cancelled task must not keep occupying the provider budget.
    if (pyTruthy(cancelRun)) this.#stop(cancelRun);
    return result;
  }

  saveSettings(data: unknown): Row { return writeSettings(this.state, data); }

  /** `_stop_workflow`; without a bridge there is no run to stop. */
  #stop(workflowId: unknown): void {
    if (this.#bridge !== null) stopWorkflow(this.#bridge, workflowId);
  }

  // ------------------------------------------------------------- execution

  /** `_granted`: approval plus the host's real-provider ceiling. */
  #granted(row: Row): boolean {
    return pyTruthy(pick(row, "approved")) && pick(row, "allowReal") === true && this.allowRealHost;
  }

  /** `_hold`: nothing started, so the task keeps its seat for a later window. */
  #hold(row: Row, now: number, status: string, error: string): Row {
    const [window, zone] = this.#windowOf(row);
    row.status = "queued";
    row.holdUntil = nextWindowOpen(now, window, zone);
    appendHistory(row, { id: uuid4Hex(), at: now, status, error });
    return { id: row.id, status, error };
  }

  /** `_claim`: move one queued task to running exactly once, with a snapshot. */
  #claim(taskId: string, now: number, ignoreWindow = false): [string, Row] | null {
    return this.#mutate((rows) => {
      const row = rows.find((item) => pick(item, "id") === taskId);
      if (row === undefined || pick(row, "status") !== "queued") return null;
      const holdUntil = pick(row, "holdUntil");
      if (!ignoreWindow && pyTruthy(holdUntil) && now < Number(holdUntil)) return null;
      if (!this.#granted(row)) {
        const reason = pyTruthy(pick(row, "approved")) ? "real provider disabled by host" : "operator approval is required";
        return ["held", this.#hold(row, now, "awaiting_approval", reason)];
      }
      row.status = RUNNING;
      row.claimedAt = now;
      row.runId = uuid4Hex();
      row.workflowId = null;
      appendHistory(row, { id: row.runId, at: now, status: "claimed" });
      // `dict(row)`: the snapshot is frozen before the queue lock is released.
      return ["claimed", { ...row }];
    });
  }

  /** `_launch`: create and start the workflow behind an already claimed task. */
  #launch(row: Row, now: number): Row {
    const taskId = pyStr(pick(row, "id"));
    let reason = "";
    try {
      const current = this.get(taskId);
      if (current !== undefined && pick(current, "status") === "cancelled") return this.#settle(taskId, now, "cancelled");
      const planned = planFor(row);
      if (planned.digest !== pick(row, "digest")) {
        return this.#settle(taskId, now, "awaiting_approval", "plan changed after approval", undefined, true);
      }
      if (this.#bridge === null) throw new PyValueError("workflow worker launcher is not configured");
      const runId = pyStr(pick(this.#bridge.create(planned.plan, pyStr(pick(row, "root"))), "id"));
      // Publish the workflow identity before launch: a concurrent cancel can now
      // reach it, and a cancel during create prevents launch entirely.
      let permitted = false;
      this.#mutate((rows) => {
        const live = rows.find((item) => pick(item, "id") === taskId);
        if (live === undefined || pick(live, "runId") !== pick(row, "runId")) return;
        live.workflowId = runId;
        permitted = pick(live, "status") === RUNNING;
      });
      if (!permitted) {
        this.#stop(runId);
        return this.#settle(taskId, now, "cancelled", undefined, runId);
      }
      requireEnabled(this.state);
      this.#bridge.launch(runId, true, pick(row, "allowReal") === true);
      return this.#settle(taskId, now, "started", undefined, runId);
    } catch (error) {
      // `except (OSError, ValueError, KeyError, PermissionError)`: anything the
      // bridge refuses is a failed attempt, not a crash of the queue.
      if (!isPyValueError(error) && !isPyOSError(error) && !isPyKeyError(error)) throw error;
      reason = errorText(error);
    }
    return this.#settle(taskId, now, "failed", reason, undefined, true);
  }

  /** `_settle`: fold one attempt's outcome into the task's history in place. */
  #settle(taskId: string, now: number, status: string, error?: string, workflowId?: string, hold = false): Row {
    let cancelId: unknown = null;
    const result = this.#mutate((rows) => {
      const row = rows.find((item) => pick(item, "id") === taskId);
      if (row === undefined) return { id: taskId, status, error: "task removed" };
      const cancelled = pick(row, "status") === "cancelled";
      const record: Row = {
        id: pick(row, "runId"), at: pyTruthy(pick(row, "claimedAt")) ? pick(row, "claimedAt") : now,
        status: cancelled ? "cancelled" : status, workflowId: pyTruthy(workflowId) ? workflowId : pick(row, "workflowId"),
      };
      if (pyTruthy(error)) record.error = pySlice(pyStr(error), 500);
      // One entry per attempt, updated in place: the claim wrote this id.
      const history = Array.isArray(row.history) ? (row.history as Row[]) : [];
      const entry = history.find((item) => isDict(item) && pick(item, "id") === pick(row, "runId"));
      if (entry !== undefined) row.history = history.map((item) => (item === entry ? record : item));
      else appendHistory(row, record);
      if (cancelled) {
        // Launch/failure must not overwrite a cancellation or put the task back
        // in the queue. Launch can race the first stop, so stop again after it
        // returns, outside the queue file lock.
        if (pyTruthy(workflowId)) row.workflowId = workflowId;
        cancelId = pick(row, "workflowId");
        return { id: row.id, status: "cancelled", workflowId: cancelId };
      }
      if (status === "started") {
        row.workflowId = workflowId;
        return { id: row.id, status: "started", workflowId };
      }
      if (SETTLED.has(status)) {
        row.status = status;
        row.finishedAt = now;
      }
      if (hold) {
        const [window, zone] = this.#windowOf(row);
        row.status = "queued";
        row.holdUntil = nextWindowOpen(now, window, zone);
      }
      return { id: row.id, status, error: pick(record, "error") };
    });
    if (pyTruthy(cancelId)) this.#stop(cancelId);
    return result;
  }

  /** `_reconcile`: fold one running task's workflow outcome back into history. */
  #reconcile(row: Row, now: number): Row | null {
    const workflowId = pick(row, "workflowId");
    if (!pyTruthy(workflowId)) return null;
    const taskId = pyStr(pick(row, "id"));
    let record: Row;
    try {
      if (this.#bridge === null) throw new PyValueError("workflow record unavailable");
      record = this.#bridge.load(pyStr(workflowId));
    } catch (error) {
      if (!isPyValueError(error) && !isPyOSError(error) && !isPyKeyError(error)) throw error;
      return this.#settle(taskId, now, "failed", "workflow record unavailable", undefined, true);
    }
    const status = pick(record, "status");
    if (status === "completed") return this.#settle(taskId, now, "completed", undefined, pyStr(workflowId));
    if (ACTIVE.has(status)) {
      const claimedAt = pyTruthy(pick(row, "claimedAt")) ? Number(pick(row, "claimedAt")) : now;
      if (now < claimedAt + Number(pick(row, "deadlineSeconds"))) return null;
      try {
        this.#bridge?.control(pyStr(workflowId), "cancel");
      } catch (error) {
        if (!isPyValueError(error) && !isPyOSError(error) && !isPyKeyError(error)) throw error;
      }
      // `'timed out after %ds' % row['deadlineSeconds']`: `%d` truncates a float.
      return this.#settle(taskId, now, "failed", `timed out after ${Math.trunc(Number(pick(row, "deadlineSeconds")))}s`);
    }
    return this.#settle(taskId, now, "failed", `workflow ${pyStr(status)}`, pyStr(workflowId));
  }

  /** `_due`: every gate that must hold before one task may be claimed. */
  #due(row: Row, now: number, settings: Row): boolean {
    if (pick(row, "status") !== "queued" || now < Number(pick(row, "nextEligibleAt") ?? 0)) return false;
    const holdUntil = pick(row, "holdUntil");
    if (pyTruthy(holdUntil) && now < Number(holdUntil)) return false;
    const stored = pick(row, "window");
    const own = pick(row, "timezone");
    const zone = own !== null ? (own as string | null) : (settings.timezone as string | null);
    if (!inWindow(now, pyTruthy(stored) ? (stored as Row) : (settings.window as Row), zone)) return false;
    if (pyTruthy(pick(row, "onlyWhenIdle")) && !this.#idleCheck(this.state)) return false;
    return true;
  }

  /** One scheduler pass: settle running tasks, then claim what the window allows. */
  tick(now?: number): Row[] {
    requireEnabled(this.state);
    const at = now === undefined ? this.clock() : now;
    const settings = this.settings();
    const outcomes: Row[] = [];
    for (const row of this.list()) {
      if (pick(row, "status") !== RUNNING) continue;
      const settled = this.#reconcile(row, at);
      if (settled !== null) outcomes.push(settled);
    }
    for (const row of this.list()) {
      if (!this.#due(row, at, settings)) continue;
      const claimed = this.#claim(pyStr(pick(row, "id")), at);
      if (claimed === null) continue;
      const [kind, payload] = claimed;
      outcomes.push(kind === "held" ? payload : this.#launch(payload, at));
    }
    return outcomes;
  }

  /** Manual trigger: skips the window, never an approval or the host provider gate. */
  runNow(taskId: string, now?: number): Row {
    requireEnabled(this.state);
    const at = now === undefined ? this.clock() : now;
    const row = this.get(taskId);
    if (row === undefined) throw new PyValueError("闲时任务不存在");
    const status = pick(row, "status");
    if (!EDITABLE.has(status)) throw new PyValueError("任务已开始或已结束");
    if (status === "failed") {
      this.#mutate((rows) => {
        const current = rows.find((item) => pick(item, "id") === taskId);
        if (current === undefined || pick(current, "status") !== "failed") return;
        current.status = "queued";
        current.holdUntil = null;
        current.nextEligibleAt = timestamp(at);
      });
    }
    const claimed = this.#claim(taskId, at, true);
    if (claimed === null) throw new PyValueError("任务已被其他运行领取");
    const [kind, payload] = claimed;
    return kind === "held" ? payload : this.#launch(payload, at);
  }
}
