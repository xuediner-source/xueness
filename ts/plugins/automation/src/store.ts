/**
 * Durable cron automations (Python `automation/scheduler.py` lines 52-123).
 *
 * One `automations.json` under the state directory holds every schedule. All
 * mutation goes through `#mutate`: the shared `.plugin-state.lock` flock is
 * taken, the file is re-read under it, changed and replaced atomically, so the
 * CLI, the server and Python's own writers cannot lose each other's edits.
 *
 * Approval binds to a digest of the resolved root and the validated plan, so
 * amending a schedule silently is impossible: the digest changes and the
 * previous approval is dropped. `run` claims a due schedule before touching
 * workflows, which makes a crash mid-launch visible instead of repeating it.
 */
import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  isDict, numericValue, pyDictCopy, pyEncodeUtf8, pyFloatValue, pyJsonDumps, pyJsonLoadsBytes, pyLen, pyStrip,
  pyTruthy, PyKeyError, PyTypeError, PyValueError, pyTypeName, uuid4Hex,
} from "@xueness/contracts";
import {
  fsyncDirectory, isLink, mkstemp, protectPrivateFile, realish, replaceFile, withFileLockSync, writeAll,
} from "@xueness/sessions";
import { nextRun, validZone } from "./cron.ts";

export type Row = Record<string, unknown>;

/** The shared plugin-switch lock; the same name Python's `_config_lock` takes. */
const LOCK_FILE = ".plugin-state.lock";
/** Python blocks forever; a minute means a wedged peer, and the critical section is short. */
const LOCK_SECONDS = 60;
const MAX_BYTES = 2_000_000;
const MAX_ROWS = 100;
const MAX_HISTORY = 100;
const MAX_NAME = 120;

/**
 * §4 of the plugin contract: what automation may do to a workflow run, stated
 * structurally. Declared here rather than imported, because a plugin may not
 * import another plugin; the host injects the real `WorkflowStore`.
 */
export interface WorkflowBridge {
  create(plan: unknown, root: string, reuse?: unknown, ownerSession?: unknown): Row;
  launch(wid: string, approved?: boolean, allowReal?: boolean, expectedDigest?: string | null): Row;
  control(wid: string, action: unknown, concurrency?: unknown): Row;
  load(wid: string): Row;
  list(): Row[];
  /**
   * `validate_plan`. §4 does not list it, but `save` needs it and a plugin may
   * not import the workflows plugin, so it is offered as an optional member
   * here. When the host's bridge has it, saving stores exactly the plan
   * workflows would create a run from; otherwise `minimalPlan` below stands in
   * and only rejects a non-object plan or a non-array `nodes`.
   */
  validatePlan?(value: unknown, root: string): Row;
}

export interface AutomationOptions {
  /**
   * `require_enabled(state, 'automation')`. The host owns plugin state, so the
   * catalog probe is injected; unbound means enabled.
   */
  enabled?: () => boolean;
  /** The host's workflow seam; only `validatePlan` is consulted here. */
  bridge?: WorkflowBridge;
  /** Overrides `bridge.validatePlan`, for a host that wires the validator directly. */
  validatePlan?: (plan: unknown, root: string) => Row;
}

export interface RunOptions {
  /** `due=True`: only fire when the schedule is enabled and its time has come. */
  due?: boolean;
  now?: number;
  allowRealHost?: boolean;
  bridge?: WorkflowBridge;
}

/** Default stand-in for `validate_plan` (see `AutomationOptions.validatePlan`). */
function minimalPlan(plan: unknown, _root: string): Row {
  if (!isDict(plan)) throw new PyValueError("plan fields: name, nodes, concurrency");
  if (!Array.isArray(plan.nodes)) throw new PyValueError("nodes must contain 1..64 entries");
  return plan;
}

function isDirectory(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

/** `_config_lock(state_dir)`: mkdir, refuse a link, take the exclusive flock. */
function withStateLock<T>(state: string, body: () => T): T {
  mkdirSync(state, { recursive: true });
  const path = join(state, LOCK_FILE);
  if (isLink(path)) throw new PyValueError("plugin lock must not be a symlink");
  return withFileLockSync(path, { timeoutSeconds: LOCK_SECONDS }, body);
}

/** `_atomic_write_json`: private temp file, fsync, rename, then fsync the directory. */
function writeJsonAtomic(path: string, value: unknown): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  const temp = mkstemp(directory, ".resource-");
  try {
    try {
      protectPrivateFile(temp.fd);
      writeAll(temp.fd, pyEncodeUtf8(pyJsonDumps(value, { ensureAscii: false, indent: 2 })));
      fsyncSync(temp.fd);
    } finally {
      closeSync(temp.fd);
    }
    replaceFile(temp.path, path);
  } finally {
    if (existsSync(temp.path)) unlinkSync(temp.path);
  }
  try { fsyncDirectory(directory); } catch { /* durability of the rename is best effort */ }
}

/**
 * `row[key]`: Python subscripts every stored row directly, so a row that is not
 * an object is a `TypeError` and a missing key a `KeyError` — never a silent
 * skip. The automation route maps both to the same 400 as a `ValueError`.
 */
function need(row: unknown, key: string): unknown {
  if (!isDict(row)) throw new PyTypeError(`'${pyTypeName(row)}' object is not subscriptable`);
  if (!Object.hasOwn(row, key)) throw new PyKeyError(`'${key}'`);
  return row[key];
}

/** `row['id']`, the key every scan in the Python module indexes. */
function rowId(row: unknown): unknown {
  return need(row, "id");
}

/** `next(r for r in rows if r['id'] == aid)` with its index, or -1. */
function indexOf(rows: Row[], aid: unknown): number {
  for (let index = 0; index < rows.length; index += 1) if (rowId(rows[index]) === aid) return index;
  return -1;
}

/** `mapping.get(key, fallback)`; the carry-overs copy the stored value verbatim. */
function get(row: Row, key: string, fallback: unknown): unknown {
  return Object.hasOwn(row, key) ? row[key] : fallback;
}

/** `value > now` for the stored `nextRunAt`; a non-number is Python's `TypeError`. */
function laterThan(value: unknown, now: number): boolean {
  const number = numericValue(value);
  if (number === null) throw new PyTypeError(`'>' not supported between instances of '${pyTypeName(value)}' and 'float'`);
  return number > now;
}

/** `list(value)` for a stored history; anything else is a `TypeError`. */
function asList(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new PyTypeError(`'${pyTypeName(value)}' object is not iterable`);
  return value;
}

/** `time.time()` as state writes it: always a float. */
const stamp = (seconds: number): unknown => pyFloatValue(seconds);

/**
 * `sha256(json.dumps({'root': root, 'plan': plan}, sort_keys=True))`.
 *
 * CPython's `json.dumps` defaults are `ensure_ascii=True` and separators
 * `(', ', ': ')`; this port defaults `ensureAscii` to false, so it is set
 * explicitly. Without it a digest written by Python and one written here differ
 * for any non-ASCII name or prompt, and a migrated schedule would silently lose
 * its approval.
 */
function digestOf(root: string, plan: Row): string {
  const body = pyJsonDumps({ root, plan }, { sortKeys: true, ensureAscii: true });
  return createHash("sha256").update(body, "utf8").digest("hex");
}

export class Automations {
  readonly state: string;
  readonly path: string;
  readonly #enabled: () => boolean;
  readonly #validatePlan: (plan: unknown, root: string) => Row;

  constructor(state: string, options: AutomationOptions = {}) {
    this.state = state;
    this.path = join(state, "automations.json");
    this.#enabled = options.enabled ?? (() => true);
    // The bridge's validator is a class method on the host side, so it is bound.
    const bridgePlan = options.bridge?.validatePlan;
    this.#validatePlan = options.validatePlan
      ?? (bridgePlan === undefined ? minimalPlan : (plan, root) => bridgePlan.call(options.bridge, plan, root));
  }

  /** `_load`: the stored rows, or none when the file does not exist yet. */
  #load(): Row[] {
    if (isLink(this.path)) throw new PyValueError("automation state cannot be a symlink");
    let raw: Buffer;
    try {
      raw = readFileSync(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    if (raw.length > MAX_BYTES) throw new PyValueError("automation state too large");
    let rows: unknown;
    try {
      // Lossless keeps `2` and `2.0` distinct, so an untouched row re-encodes
      // to the bytes Python wrote (see `py-float.ts`).
      rows = pyJsonLoadsBytes(raw, { lossless: true });
    } catch (error) {
      // `json.JSONDecodeError` is a `ValueError` in Python, and the automation
      // routes classify on that; keep the scanner's message.
      throw new PyValueError(error instanceof Error ? error.message : "invalid automation state");
    }
    if (!Array.isArray(rows)) throw new PyValueError("invalid automation state");
    return rows as Row[];
  }

  list(): Row[] {
    return this.#load();
  }

  /** `mutate`: re-read under the config lock, change, replace atomically. */
  #mutate<T>(change: (rows: Row[]) => T): T {
    return withStateLock(this.state, () => {
      const rows = this.#load();
      const out = change(rows);
      writeJsonAtomic(this.path, rows);
      return out;
    });
  }

  save(data: unknown, aid?: string): Row {
    const now = Date.now() / 1000;
    if (!isDict(data)) throw new PyValueError("automation must be an object");
    return this.#mutate((rows) => {
      // Python scans for the id on every save, even without one, so a malformed
      // stored row fails here too; `None` is the absent-id sentinel it compares.
      const index = indexOf(rows, aid ?? null);
      const previous = index < 0 ? null : rows[index] as Row;
      if (aid && previous === null) throw new PyValueError("automation not found");
      const row: Row = { ...(previous ?? {}), ...data };
      const name = get(row, "name", "Automation");
      const schedule = get(row, "schedule", null);
      const tz = get(row, "timezone", "UTC");
      const enabled = get(row, "enabled", false);
      if (typeof name !== "string" || !pyStrip(name) || pyLen(name) > MAX_NAME || typeof enabled !== "boolean") {
        throw new PyValueError("invalid name or enabled state");
      }
      if (typeof tz !== "string") throw new PyValueError("invalid timezone");
      validZone(tz);
      const workflow = get(row, "workflow", {});
      if (!isDict(workflow) || typeof workflow.root !== "string") throw new PyValueError("workflow root required");
      const root = realish(workflow.root);
      if (!isDirectory(root)) throw new PyValueError("workflow root must exist");
      // `{k: v for k, v in workflow.items() if k != 'root'}`.
      const planInput: Row = {};
      for (const key of Object.keys(workflow)) if (key !== "root") planInput[key] = workflow[key];
      const plan = this.#validatePlan(planInput, root);
      const digest = digestOf(root, plan);
      const carried = previous ?? {};
      const item: Row = {
        id: aid || uuid4Hex(),
        name,
        schedule,
        timezone: tz,
        enabled,
        workflow: { root, ...plan },
        nextRunAt: stamp(nextRun(schedule as string, tz, now)),
        history: get(carried, "history", []),
        approvalRequired: true,
        // An amended plan loses the operator's approval; the root is in the digest.
        approved: get(carried, "digest", null) === digest ? get(carried, "approved", false) : false,
        allowReal: get(carried, "allowReal", false),
        digest,
      };
      if (previous !== null) rows[index] = item;
      else {
        if (rows.length >= MAX_ROWS) throw new PyValueError("automations capped at 100");
        rows.push(item);
      }
      return item;
    });
  }

  delete(aid: string): Row {
    return this.#mutate((rows) => {
      const kept = rows.filter((row) => rowId(row) !== aid);
      rows.splice(0, rows.length, ...kept);
      return { deleted: aid };
    });
  }

  approve(aid: string, allowReal?: unknown): Row {
    return this.#mutate((rows) => {
      const index = indexOf(rows, aid);
      // Python's `next(...)` raises StopIteration; the route maps both to 400.
      if (index < 0) throw new PyValueError("automation not found");
      const row = rows[index] as Row;
      row.approved = true;
      row.allowReal = allowReal === true;
      return row;
    });
  }

  /**
   * Claim one schedule and hand it to workflows. The claim is committed first,
   * so a crash between the two leaves a `claimed` history entry rather than a
   * duplicate launch. Nothing is approved implicitly: an unapproved schedule
   * creates a reviewable plan and stops there.
   */
  run(aid: string, options: RunOptions = {}): Row | null {
    if (!this.#enabled()) throw new PyValueError("plugin disabled or dependency unavailable: automation");
    const due = options.due === true;
    const now = options.now ?? Date.now() / 1000;
    // A caller-supplied `now` is echoed into the history verbatim, as Python does.
    const at = options.now === undefined ? stamp(now) : options.now;
    const claimed = this.#mutate((rows): { row: Row; claimId: string } | null => {
      const index = indexOf(rows, aid);
      if (index < 0) throw new PyValueError("automation not found");
      const row = rows[index] as Row;
      if (due && (!pyTruthy(need(row, "enabled")) || laterThan(need(row, "nextRunAt"), now))) return null;
      if (due) row.nextRunAt = stamp(nextRun(need(row, "schedule") as string, need(row, "timezone") as string, now));
      const claimId = uuid4Hex();
      row.history = [...asList(need(row, "history")), { id: claimId, at, status: "claimed" }].slice(-MAX_HISTORY);
      return { row: { ...row }, claimId };
    });
    if (claimed === null) return null;
    const { row, claimId } = claimed;
    let result: Row;
    try {
      // Python builds `WorkflowStore(self.state)` here as well, so a store that
      // cannot be constructed is a failed launch, not an escaping error.
      const bridge = options.bridge;
      if (bridge === undefined) throw new PyValueError("workflow bridge unavailable");
      const plan = pyDictCopy(asDict(need(row, "workflow")));
      const root = need(plan, "root") as string; // `plan.pop('root')`
      delete plan.root;
      const created = bridge.create(plan, root);
      // `row['approved'] and (not row['allowReal'] or allow_real_host)`.
      const granted = pyTruthy(need(row, "approved"))
        && (!pyTruthy(need(row, "allowReal")) || options.allowRealHost === true);
      const launched = granted ? bridge.launch(need(created, "id") as string, true, need(row, "allowReal") === true) : created;
      result = { id: claimId, at, status: granted ? "started" : "awaiting_approval", workflowId: need(launched, "id") };
    } catch {
      result = { id: claimId, at, status: "failed", error: "workflow launch failed" };
    }
    const settled = result;
    return this.#mutate((rows) => {
      const index = indexOf(rows, aid);
      if (index >= 0) {
        const current = rows[index] as Row;
        // `[result if x['id'] == claim_id else x for x in current['history']]`.
        current.history = asList(need(current, "history"))
          .map((entry) => (rowId(entry) === claimId ? settled : entry));
      }
      return settled;
    });
  }
}

/** `dict(value)`; a non-mapping is Python's `TypeError`. */
function asDict(value: unknown): Row {
  if (!isDict(value)) throw new PyTypeError(`'${pyTypeName(value)}' object is not iterable`);
  return value;
}
