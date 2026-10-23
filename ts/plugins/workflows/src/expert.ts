/**
 * Expert workflow runs (Python `bundled_plugins/workflows/expert.py`).
 *
 * A run is a fixed four-node `agent` DAG (`expert-phases.ts`) plus one durable
 * projection record under `<state>/workflows/expert/` holding the task, the
 * bound session, the current phase and a per-phase status/summary/error row.
 * The projection is a cache of the DAG: `refresh` pulls phase progress out of
 * the workflow record and persists only the delta, so a lost or hand-edited
 * projection heals on the next read.
 *
 * Runs are created and launched through the `WorkflowBridge` seam (§4) when the
 * host supplies one, and through this plugin's own `WorkflowStore` otherwise.
 * The actor-answer pair and `update` that `resume`/`stop`/`refresh` need are
 * not part of the bridge, so those use `WorkflowStore` directly, as Python does.
 */
import { isAbsolute, join } from "node:path";
import {
  isDict, numericValue, pyLen, pySlice, pyStr, pyStrip, pyTruthy, PyKeyError, PyValueError, uuid4Hex,
} from "@xueness/contracts";
import { isPyValueError, PyOSError, SessionStore } from "@xueness/sessions";
import { isDirectory, isInside, resolvePath, type Row } from "./plan.ts";
import { WorkflowStore } from "./store.ts";
import {
  ACTIVE_EXPERT, ERROR_MAX, ExpertStore, expertPlan, get, newRecord, phaseLine, PHASE_IDS, projectPhases,
  SID, statusLabel, TASK_MAX, TERMINAL_EXPERT, validateTask,
} from "./expert-phases.ts";

const PLUGIN = "workflows";

// `ExpertStore` is defined beside the phase table it projects; re-exported here
// so callers reach the run store through the same module as `start`/`load`.
export { ExpertStore };

/** Options carry the Python keyword spelling and its camelCase twin. */
const pick = (row: Row, camel: string, snake: string): unknown => (Object.hasOwn(row, camel) ? row[camel] : get(row, snake));

/** `str(exc)`: the raised message, never Node's `Error: ` prefix. */
const errorText = (error: unknown): string => (error instanceof Error ? error.message : pyStr(error));

/** The slash seam answers with text; the contract widens that to `Row`. */
const reply = (text: string): Row => text as unknown as Row;

/** `ctx['state_dir']`: a missing key is Python's `KeyError`. */
function stateDirOf(options: Row): string {
  const value = pick(options, "stateDir", "state_dir");
  if (typeof value !== "string") throw new PyKeyError("'state_dir'");
  return value;
}

/** `FileNotFoundError` for a selection that has no runs at all. */
class FileNotFoundError extends PyOSError { override name = "FileNotFoundError"; }

/** `isinstance(exc, FileNotFoundError)`, including Node's own `ENOENT`. */
const isFileNotFound = (error: unknown): boolean => error instanceof FileNotFoundError
  || (error as Error | null)?.name === "FileNotFoundError" || (error as NodeJS.ErrnoException | null)?.code === "ENOENT";

/** `plugin_runtime.is_enabled`. The host binds the catalog probe; unbound means on. */
let pluginProbe: ((stateDir: string, pluginId: string) => boolean) | null = null;

/** Bind the catalog probe once (the host owns plugin state); `null` means on. */
export function bindExpertPluginEnabled(probe: ((stateDir: string, pluginId: string) => boolean) | null): void {
  pluginProbe = probe;
}

/** `require_enabled(state_dir, 'workflows')`; `PluginDisabled` is a `ValueError`. */
function requireEnabled(stateDir: string): void {
  let enabled = true;
  if (pluginProbe !== null) {
    try { enabled = pluginProbe(stateDir, PLUGIN) === true; } catch { enabled = false; }
  }
  if (!enabled) throw new PyValueError(`plugin disabled or dependency unavailable: ${PLUGIN}`);
}

/** §4: the cross-plugin seam for creating and launching workflow runs. */
interface WorkflowBridge {
  create(plan: unknown, root: string, reuse?: unknown, ownerSession?: unknown): Row;
  launch(wid: string, approved?: boolean, allowReal?: boolean, expectedDigest?: string | null): Row;
  control(wid: string, action: unknown, concurrency?: unknown): Row;
  load(wid: string): Row;
  list(): Row[];
}

/** `options.bridge` when the host supplied one, else this plugin's own store. */
function bridgeFor(stateDir: string, options: Row = {}): WorkflowBridge {
  const given = get(options, "bridge");
  return isDict(given) && typeof given.create === "function" ? (given as unknown as WorkflowBridge) : new WorkflowStore(stateDir);
}

/** `_refresh(experts, store, record)` over the two stores it reads. */
function refresh(experts: ExpertStore, store: WorkflowStore, record: Row): Row {
  return projectPhases(experts, store, record);
}

/** The session's stored `permission_mode`, defaulting to `build` like Python. */
function sessionPermissionMode(stateDir: string, sessionId: string): unknown {
  return get(new SessionStore(stateDir).readJournal(sessionId), "permission_mode") ?? "build";
}

/**
 * Create and launch one expert run for `task` in `root`.
 *
 * `session_id` binds the run to a chat session: it keys the one-active-run
 * limit and supplies the permission_mode that decides whether the implement
 * phase may write. An explicit `permission_mode` is accepted only when there is
 * no session, so a client can never widen a session's own mode.
 */
export function start(stateDir: string, task: unknown, root: string, options: Row = {}): Row {
  requireEnabled(stateDir);
  const text = validateTask(task);
  const workspace = resolvePath(root);
  if (!isDirectory(workspace)) throw new PyValueError("workspace root must be an existing directory");
  const rawSession = pick(options, "sessionId", "session_id");
  let sessionId: string | null = null;
  let permissionMode: unknown = pick(options, "permissionMode", "permission_mode");
  if (rawSession !== null && rawSession !== undefined) {
    if (typeof rawSession !== "string" || !SID.test(rawSession)) throw new PyValueError("invalid session id");
    sessionId = rawSession;
    // An explicit mode may never widen the mode of the session it is bound to.
    if (permissionMode !== null) throw new PyValueError("permission_mode is derived from the bound session");
    permissionMode = sessionPermissionMode(stateDir, sessionId);
  }
  const mode = pyTruthy(permissionMode) ? pyStr(permissionMode) : "build";
  const experts = new ExpertStore(stateDir);
  const plan = expertPlan(text, mode);
  const allowReal = pyTruthy(pick(options, "allowReal", "allow_real"));
  const store = new WorkflowStore(experts.state);
  let runId: string;
  let workflowId: string;
  const mutex = experts.mutex();
  try {
    // The per-session limit is checked and the record created under one mutex.
    for (const row of experts.list()) {
      if (get(row, "session") !== sessionId || !ACTIVE_EXPERT.has(pyStr(get(row, "status")))) continue;
      const live = refresh(experts, store, row);
      if (ACTIVE_EXPERT.has(pyStr(get(live, "status")))) {
        throw new PyValueError("this session already has an active expert run: " + pyStr(get(live, "id")));
      }
    }
    const created = bridgeFor(experts.state, options).create(plan, workspace, undefined, sessionId);
    workflowId = pyStr(get(created, "id"));
    runId = uuid4Hex();
    experts.save(newRecord(runId, workflowId, text, workspace, sessionId, mode));
  } finally {
    mutex.release();
  }
  try {
    bridgeFor(experts.state, options).launch(workflowId, true, allowReal);
  } catch (error) {
    experts.update(runId, (row) => { row.status = "failed"; row.error = pySlice(errorText(error), ERROR_MAX); });
    throw error;
  }
  return load(stateDir, runId);
}

export function load(stateDir: string, runId: string): Row {
  const experts = new ExpertStore(stateDir);
  return refresh(experts, new WorkflowStore(experts.state), experts.load(runId));
}

export function listRuns(stateDir: string, sessionId: string | null = null): Row[] {
  const experts = new ExpertStore(stateDir);
  const store = new WorkflowStore(experts.state);
  return experts.list().filter((row) => sessionId === null || get(row, "session") === sessionId)
    .map((row) => refresh(experts, store, row));
}

/** Latest active run for the selection, else the latest settled one. */
export function resolveTarget(stateDir: string, options: { sessionId?: string | null; runId?: string | null } = {}): Row {
  const experts = new ExpertStore(stateDir);
  const runId = options.runId ?? null;
  if (runId !== null) return experts.load(runId);
  let rows = experts.list();
  const sessionId = options.sessionId ?? null;
  if (sessionId !== null) {
    if (!SID.test(sessionId)) throw new PyValueError("invalid session id");
    rows = rows.filter((row) => get(row, "session") === sessionId);
  }
  if (!rows.length) throw new FileNotFoundError("no expert run found for this selection", "ENOENT");
  const active = rows.filter((row) => ACTIVE_EXPERT.has(pyStr(get(row, "status"))));
  const pool = active.length ? active : rows;
  const createdAt = (row: Row): number => Number(numericValue(get(row, "created_at")) ?? 0);
  // Python's `max` keeps the first maximal element, so ties favour the earlier row.
  return pool.reduce((best, row) => (createdAt(row) > createdAt(best) ? row : best), pool[0] as Row);
}

/**
 * Continue a run: answer a waiting actor, then relaunch the DAG.
 *
 * `WorkflowStore` splits Python's `answer_actor` in two: `actorAwaiting`
 * validates, `actorAnswered` rewrites the record. Appending the answer to the
 * actor transcript belongs to the host (`answerActor`, §3.7), which owns the
 * session journal; `resume` is synchronous and cannot await that save.
 */
export function resume(stateDir: string, runId: string, options: { answer?: unknown; allowReal?: boolean } = {}): Row {
  requireEnabled(stateDir);
  const experts = new ExpertStore(stateDir);
  const store = new WorkflowStore(experts.state);
  const record = refresh(experts, store, experts.load(runId));
  if (TERMINAL_EXPERT.has(pyStr(get(record, "status")))) return record;
  const answer = options.answer ?? null;
  if (answer !== null && (typeof answer !== "string" || !pyStrip(answer) || pyLen(answer) > TASK_MAX)) {
    throw new PyValueError(`answer must be 1..${TASK_MAX} characters`);
  }
  const workflowId = pyStr(get(record, "workflow"));
  const workflow = store.load(workflowId);
  if (get(workflow, "status") === "awaiting_user") {
    if (answer === null) {
      throw new PyValueError("实现阶段代理在等待回答；请用 resume 提交 answer，或在工作流面板回答该问题。");
    }
    const nodes = isDict(workflow.nodes) ? (workflow.nodes as Record<string, Row>) : {};
    const node = PHASE_IDS.find((pid) => isDict(nodes[pid]) && (nodes[pid] as Row).status === "awaiting_user");
    if (node === undefined) throw new PyValueError("workflow actor is not awaiting an answer");
    store.actorAwaiting(workflowId, node, answer);
    store.actorAnswered(workflowId, node, answer as string);
  }
  const allowReal = options.allowReal === true;
  try {
    store.launch(workflowId, true, allowReal);
  } catch (error) {
    // A worker that died mid-run leaves ACTIVE statuses behind; resume repairs
    // that the same way the engine's own recover action does.
    if (!isPyValueError(error) || !errorText(error).includes("recover a stale run first")) throw error;
    store.control(workflowId, "recover");
    store.launch(workflowId, true, allowReal);
  }
  return refresh(experts, store, experts.load(runId));
}

/** Settle or cancel a run; one with no detached owner to observe is settled directly. */
export function stop(stateDir: string, runId: string): Row {
  requireEnabled(stateDir);
  const experts = new ExpertStore(stateDir);
  const store = new WorkflowStore(experts.state);
  const record = refresh(experts, store, experts.load(runId));
  if (TERMINAL_EXPERT.has(pyStr(get(record, "status")))) return record;
  const workflowId = pyStr(get(record, "workflow"));
  const status = get(store.load(workflowId), "status");
  if (status === "created" || status === "paused" || status === "awaiting_user") {
    // No detached owner to observe the control flag: settle directly.
    store.update(workflowId, (row) => {
      row.status = "cancelled";
      store.event(row, "cancelled", { source: "expert stop" });
    });
  } else {
    store.control(workflowId, "cancel");
  }
  return refresh(experts, store, experts.load(runId));
}

export function formatStatus(record: Row): string {
  const status = pyStr(get(record, "status"));
  const lines = [
    `专家工作流 ${pySlice(pyStr(get(record, "id")), 8)} · ${statusLabel(status)}`,
    `任务：${pyStr(get(record, "task"))}`,
    `阶段：${phaseLine(record)}`,
  ];
  if (pyTruthy(get(record, "error"))) lines.push(`错误：${pyStr(get(record, "error"))}`);
  lines.push(ACTIVE_EXPERT.has(status) ? "用 /expert status 查看进度，/expert stop 停止。" : "用 /expert status 查看结果。");
  return lines.join("\n");
}

/** `/expert [status|resume|stop|<task>]` from the in-chat dispatch seam. */
export function handleSlash(argument: string, options: Row): Row | null {
  const stateDir = stateDirOf(options);
  const session = get(options, "session");
  const sessionId = isDict(session) && typeof session.id === "string" ? session.id : null;
  const text = pyStrip(typeof argument === "string" ? argument : "");
  const space = text.indexOf(" ");
  const action = space < 0 ? text : text.slice(0, space);
  const rest = space < 0 ? "" : pyStrip(text.slice(space + 1));
  if (action === "" || action === "status") {
    let target: Row;
    try { target = resolveTarget(stateDir, { sessionId }); } catch (error) {
      if (!isFileNotFound(error)) throw error;
      return reply("暂无专家工作流；用 /expert <任务描述> 启动。");
    }
    return reply(formatStatus(load(stateDir, pyStr(get(target, "id")))));
  }
  if (action === "resume" || action === "stop") {
    let target: Row;
    try { target = resolveTarget(stateDir, { sessionId }); } catch (error) {
      if (!isFileNotFound(error)) throw error;
      return reply(`暂无可${action === "resume" ? "继续" : "停止"}的专家工作流。`);
    }
    const id = pyStr(get(target, "id"));
    return reply(formatStatus(action === "resume"
      ? resume(stateDir, id, { answer: rest ? rest : null, allowReal: true })
      : stop(stateDir, id)));
  }
  const sessionRoot = isDict(session) ? get(session, "root") : null;
  const configured = get(options, "root");
  const root = pyTruthy(sessionRoot) ? pyStr(sessionRoot) : (pyTruthy(configured) ? pyStr(configured) : process.cwd());
  const record = start(stateDir, text, root, { session_id: sessionId, allow_real: true, bridge: get(options, "bridge") });
  return reply(`已启动专家工作流 ${pySlice(pyStr(get(record, "id")), 8)}。\n${formatStatus(record)}`);
}

/** `parse_qs` value -> the `[0]` element Python indexes (`str` yields one char). */
function queryValue(query: Row, key: string): string {
  const value = isDict(query) ? get(query, key) : null;
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : "";
  return typeof value === "string" ? pySlice(value, 1) : "";
}

/** `web._allowed_root`: a browser-created workspace must sit under a permitted base. */
function rootFor(options: Row, value: unknown): string {
  if (typeof value !== "string" || !value) throw new PyValueError("workspace root is required");
  const bases: string[] = [];
  for (const key of ["webRuns", "web_runs", "projectDir", "project_dir"]) {
    const base = get(options, key);
    if (typeof base === "string" && base) bases.push(resolvePath(base));
  }
  const raw = pick(options, "allowedRoots", "allowed_roots");
  const extra = typeof raw === "function" ? (raw as () => unknown)() : raw;
  if (Array.isArray(extra)) for (const base of extra) if (typeof base === "string" && base) bases.push(resolvePath(base));
  // A relative request is resolved against the server-owned web-runs root.
  const webRuns = pick(options, "webRuns", "web_runs");
  const base = typeof webRuns === "string" && webRuns ? resolvePath(webRuns) : process.cwd();
  const target = resolvePath(isAbsolute(value) ? value : join(base, value));
  if (bases.some((root) => isInside(root, target))) return target;
  throw new PyValueError("workspace root not permitted");
}

/** CLI-created runs outside the server's approved roots stay unexposed. */
function visibleRun(stateDir: string, options: Row, runId: string): Row {
  const record = load(stateDir, runId);
  rootFor(options, get(record, "root"));
  return record;
}

/** `/api/workflows/expert` routes; called from the workflows dispatcher. */
export function dispatchExpert(method: string, parts: readonly string[], query: Row, data: Row, options: Row): [number, unknown] | null {
  if (!Array.isArray(parts) || parts[0] !== "api" || parts[1] !== "workflows" || parts[2] !== "expert") return null;
  const stateDir = stateDirOf(options);
  const allowReal = pyTruthy(pick(options, "allowReal", "allow_real"));
  if (parts.length === 3) {
    if (method === "GET") {
      const session = queryValue(query, "session");
      if (session && !SID.test(session)) return [400, { error: "invalid session id" }];
      const runs: Row[] = [];
      for (const row of listRuns(stateDir, session || null)) {
        try { rootFor(options, get(row, "root")); } catch (error) {
          if (isPyValueError(error)) continue;
          throw error;
        }
        runs.push(row);
      }
      return [200, { expert_runs: runs }];
    }
    if (method === "POST") {
      const root = rootFor(options, get(data, "root"));
      return [200, start(stateDir, get(data, "task"), root, {
        session_id: get(data, "session"), allow_real: allowReal, bridge: get(options, "bridge"),
      })];
    }
    return [405, { error: "method not allowed" }];
  }
  const runId = parts[3] as string;
  if (parts.length === 4) {
    return method === "GET" ? [200, visibleRun(stateDir, options, runId)] : [405, { error: "method not allowed" }];
  }
  if (parts.length === 5 && method === "POST") {
    visibleRun(stateDir, options, runId);
    if (parts[4] === "resume") return [200, resume(stateDir, runId, { answer: get(data, "answer"), allowReal })];
    if (parts[4] === "stop") return [200, stop(stateDir, runId)];
  }
  return [404, { error: "operation not found" }];
}
