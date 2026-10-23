/**
 * Session-scoped control for dynamic workflow runs (`/dwf`), ported from
 * `xueness/bundled_plugins/workflows/dynamic_runs.py`.
 *
 * A *dynamic run* is a workflow an agent started while working in a session:
 * listing, cancelling and resuming reuse the same records and the same
 * `launch`/`control` paths the CLI and panel use. Resumability is decided here
 * from the record plus whether a live owner still holds the runner lock, and
 * every refusal is `{reason, detail}` so CLI, HTTP and chat agree. Enabling the
 * plugin never authorizes execution.
 */
import { relative, sep } from "node:path";
import { isDict, numericValue, pyCasefold, pyFloat, pyIsSpace, PyKeyError, pySlice, pyStr, PyTypeError, PyValueError } from "@xueness/contracts";
import { isPyKeyError, isPyOSError, isPyValueError, PyBlockingIOError, realish, type SessionStore } from "@xueness/sessions";
import { ACTIVE, type Row } from "./plan.ts";
import { WorkflowStore } from "./store.ts";

const PLUGIN = "workflows";
export const SESSION = /^[0-9a-f]{32}$/;
export const SUBCOMMANDS: readonly string[] = ["list", "cancel", "resume"];
export const USAGE = "dwf [list|cancel [runId]|resume <runId>] --session <id>";
export const CANDIDATE_LIMIT = 8;

/** A refused dwf request: stable reason, human detail, HTTP status. */
export class DynamicRunError extends PyValueError {
  override name = "DynamicRunError";
  readonly reason: string;
  readonly detail: string;
  readonly status: number;
  readonly extra: Row;
  constructor(reason: string, detail: string, status = 400, extra: Row = {}) {
    super(`${reason}: ${detail}`);
    this.reason = reason;
    this.detail = detail;
    this.status = status;
    this.extra = extra;
  }

  payload(): Row {
    return { ok: false, status: this.status, refusal: { reason: this.reason, detail: this.detail }, ...this.extra };
  }
}

/** `plugin_runtime.is_enabled`. The host binds the catalog probe; unbound means on. */
let pluginProbe: ((stateDir: string, pluginId: string) => boolean) | null = null;

export function bindPluginEnabled(probe: ((stateDir: string, pluginId: string) => boolean) | null): void {
  pluginProbe = probe;
}

function requireEnabled(stateDir: string | null | undefined): void {
  let enabled = stateDir !== null && stateDir !== undefined;
  if (enabled && pluginProbe !== null) {
    try {
      enabled = pluginProbe(stateDir as string, PLUGIN) === true;
    } catch {
      enabled = false;
    }
  }
  if (!enabled) throw new DynamicRunError("plugin_disabled", `plugin disabled or dependency unavailable: ${PLUGIN}`, 403);
}

/** The session id a tool call may stamp on a new run, or `null`. */
export function ownerSessionId(session: Row | null | undefined): string | null {
  if (!isDict(session)) return null;
  const sid = Object.hasOwn(session, "id") ? session.id : null;
  return typeof sid === "string" && SESSION.test(sid) ? sid : null;
}

/**
 * dwf only ever manages the workspace of the session it was asked about.
 * `SessionStore.load` is async; `readJournal` is the same journal read with
 * the same backup recovery, so the synchronous dwf surface uses it.
 */
function sessionOf(sessions: SessionStore, sid: unknown): Row {
  if (typeof sid !== "string" || !SESSION.test(sid)) throw new DynamicRunError("invalid_session", "需要 32 位十六进制的会话 id", 400);
  let session: unknown;
  try {
    session = sessions.readJournal(sid);
  } catch (error) {
    if (isPyOSError(error) || isPyValueError(error) || isPyKeyError(error)) throw new DynamicRunError("session_not_found", `未知会话: ${sid}`, 404);
    throw error;
  }
  if (!isDict(session) || typeof session.root !== "string") throw new DynamicRunError("session_not_found", `未知会话: ${sid}`, 404);
  return session;
}

/** `Path(session['root']).resolve()`; an unusable workspace is a refusal. */
function workspaceOf(session: Row): string {
  try {
    return realish(session.root as string);
  } catch {
    throw new DynamicRunError("invalid_session", "会话工作区不可用", 400);
  }
}

/** One dwf request's boundary: the workflow store plus the session's workspace. */
function scope(stateDir: string, sessions: SessionStore, sid: unknown): { store: WorkflowStore; workspace: string } {
  requireEnabled(stateDir);
  const session = sessionOf(sessions, sid);
  return { store: new WorkflowStore(stateDir), workspace: workspaceOf(session) };
}

/**
 * `[matched, how]` — a tagged run belongs to one session, an untagged run
 * (plain `workflow create` / `jobs start`) only to its own workspace.
 */
function attribution(record: Row, sid: string, workspace: string): [boolean, string | null] {
  const owner = Object.hasOwn(record, "owner_session") ? record.owner_session : null;
  if (typeof owner === "string" && owner) return owner === sid ? [true, "session"] : [false, null];
  let same = false;
  try {
    same = realish(typeof record.root === "string" ? record.root : "") === workspace;
  } catch {
    same = false;
  }
  return same ? [true, "workspace"] : [false, null];
}

function records(store: WorkflowStore, sid: string, workspace: string): [Row, string | null][] {
  const found: [Row, string | null][] = [];
  for (const item of store.list()) {
    let record: Row;
    try {
      record = store.load(item.id);
    } catch (error) {
      if (isPyOSError(error) || isPyValueError(error) || isPyKeyError(error)) continue;
      throw error;
    }
    const [matched, how] = attribution(record, sid, workspace);
    if (matched) found.push([record, how]);
  }
  return found;
}

/** True while a detached worker still holds this run's runner lock. */
function liveOwner(store: WorkflowStore, wid: unknown): boolean {
  try {
    store.lock(wid, ".runner", { blocking: false }).release();
    return false;
  } catch (error) {
    if (error instanceof PyBlockingIOError) return true;
    if (isPyOSError(error) || isPyValueError(error)) return false;
    throw error;
  }
}

/** `datetime.fromtimestamp(float(value), timezone.utc).isoformat(timespec='seconds')`; bad input is `None`. */
function stampOf(value: unknown): string | null {
  let seconds: number | null;
  try {
    seconds = typeof value === "string" ? pyFloat(value) : numericValue(value);
  } catch {
    return null;
  }
  if (seconds === null || !Number.isFinite(seconds)) return null;
  const date = new Date(Math.floor(seconds) * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 19) + "+00:00";
}

/** `(any command node, any agent node)` for the stored plan. */
function nodeKinds(record: Row): [boolean, boolean] { // plan nodes decide which approvals resume needs
  const plan = isDict(record.plan) ? record.plan : {};
  const nodes = Array.isArray(plan.nodes) ? plan.nodes : [];
  const rows = nodes.filter(isDict);
  return [
    rows.some((node) => (Object.hasOwn(node, "kind") ? node.kind : "command") === "command"),
    rows.some((node) => node.kind === "agent"),
  ];
}

/** Server-decided status plus whether `resume` could succeed right now. */
function view(store: WorkflowStore, record: Row, how: string | null): Row {
  const status = Object.hasOwn(record, "status") ? record.status : null;
  const live = liveOwner(store, record.id);
  const inFlight = ACTIVE.has(status);
  let blocked: Row | null = null;
  if (inFlight && live) {
    blocked = { reason: "already_running", detail: "运行仍有存活的 owner 进程；如需停止请先取消。" };
  } else if (status === "awaiting_user") {
    blocked = { reason: "awaiting_actor_answer", detail: "actor 正在等待回答，回答后运行会自行继续。" };
  } else if (status === "completed") {
    blocked = { reason: "already_completed", detail: "运行已全部完成；想复用结果请新建运行并指定 reuse。" };
  } else if (status === "created") {
    blocked = { reason: "not_started", detail: "运行尚未启动过，请使用 workflow start 或在面板批准计划后启动。" };
  }
  const [commands, agents] = nodeKinds(record);
  const events = Array.isArray(record.events) ? record.events : [];
  const started = events.find((event) => isDict(event) && event.type === "started");
  const at = isDict(started) && Object.hasOwn(started, "at") ? started.at : null;
  const plan = isDict(record.plan) ? record.plan : {};
  return {
    id: record.id, name: Object.hasOwn(plan, "name") ? plan.name : "Workflow", status, attribution: how,
    inFlight: Boolean(inFlight && live), stale: Boolean(inFlight && !live),
    requiresApproval: commands, requiresRealModel: agents,
    startedAt: stampOf(at !== null ? at : (Object.hasOwn(record, "created_at") ? record.created_at : null)),
    updatedAt: stampOf(Object.hasOwn(record, "updated_at") ? record.updated_at : null),
    resumable: blocked === null, resumeRefusal: blocked,
  };
}

function find(found: [Row, string | null][], runId: unknown): [Row, string | null] {
  if (typeof runId !== "string" || !SESSION.test(runId)) throw new DynamicRunError("invalid_run", "runId 需要 32 位十六进制的工作流 id", 400);
  for (const [record, how] of found) if (record.id === runId) return [record, how];
  throw new DynamicRunError("not_found", `该会话的工作区里没有 id 为 ${runId} 的工作流运行`, 404);
}

export function listRuns(stateDir: string, sessions: SessionStore, sid: string): Row {
  const { store, workspace } = scope(stateDir, sessions, sid);
  const views = records(store, sid, workspace).map(([record, how]) => view(store, record, how));
  return {
    session: sid, workspace, runs: views,
    inFlight: views.filter((item) => item.inFlight).length,
    resumable: views.filter((item) => item.resumable).length,
  };
}

export function cancelRun(stateDir: string, sessions: SessionStore, sid: string, runId?: unknown): Row {
  const { store, workspace } = scope(stateDir, sessions, sid);
  const found = records(store, sid, workspace);
  if (runId === undefined || runId === null) {
    const flight = found.filter(([record]) => ACTIVE.has(Object.hasOwn(record, "status") ? record.status : null));
    if (!flight.length) {
      throw new DynamicRunError("none_in_flight", "该会话当前没有进行中的工作流运行。", 409,
        { runs: found.map(([record, how]) => view(store, record, how)).slice(0, CANDIDATE_LIMIT) });
    }
    if (flight.length > 1) {
      throw new DynamicRunError("ambiguous", "存在多个进行中的运行，请带上 runId 再取消。", 409,
        { candidates: flight.map(([record, how]) => view(store, record, how)).slice(0, CANDIDATE_LIMIT) });
    }
    runId = (flight[0] as [Row, string | null])[0].id;
  }
  const [record, how] = find(found, runId);
  const status = Object.hasOwn(record, "status") ? record.status : null;
  // Idempotent: an already cancelled run is reported, never rewritten.
  if (status === "cancelled") return { ok: true, action: "cancel", alreadyCancelled: true, run: view(store, record, how) };
  if (!ACTIVE.has(status)) throw new DynamicRunError("not_active", `运行已结束（${pyStr(status)}），无法取消；记录保持不变。`, 409);
  let settled: Row;
  try {
    settled = store.control(record.id, "cancel");
  } catch (error) {
    if (isPyValueError(error)) throw new DynamicRunError("not_active", (error as Error).message, 409);
    throw error;
  }
  return { ok: true, action: "cancel", alreadyCancelled: false, run: view(store, settled, how) };
}

export function resumeRun(stateDir: string, sessions: SessionStore, sid: string, runId: unknown,
  options: { approved?: boolean; allowReal?: boolean } = {}): Row {
  const approved = options.approved === true;
  const allowReal = options.allowReal === true;
  const { store, workspace } = scope(stateDir, sessions, sid);
  const [record, how] = find(records(store, sid, workspace), runId);
  const refusal = view(store, record, how).resumeRefusal;
  if (refusal !== null) {
    const row = refusal as Row;
    throw new DynamicRunError(row.reason as string, row.detail as string, 409);
  }
  const [commands, agents] = nodeKinds(record);
  if (commands && !approved) {
    throw new DynamicRunError("approval_required",
      "恢复会执行计划中的命令节点，需要显式批准：CLI 加 --approve，HTTP 传 approve=true。", 403);
  }
  if (agents && !allowReal) {
    throw new DynamicRunError("model_execution_disabled",
      "计划包含 actor 节点，需要宿主允许真实模型调用：CLI 加 --allow-real。", 403);
  }
  let launched: Row;
  try {
    // Same recovery the standalone `workflow recover` does: a stale active run
    // has no live owner, so its interrupted nodes can be re-driven.
    if (ACTIVE.has(Object.hasOwn(record, "status") ? record.status : null)) store.control(record.id, "recover");
    launched = store.launch(record.id, approved, allowReal);
  } catch (error) {
    if (error instanceof PyBlockingIOError) throw new DynamicRunError("already_running", "另一个进程正在驱动该运行。", 409);
    if (error instanceof DynamicRunError) throw error;
    if (isPyValueError(error)) throw new DynamicRunError("not_resumable", (error as Error).message, 409);
    throw error;
  }
  return { ok: true, action: "resume", run: view(store, launched, how) };
}

export function invoke(stateDir: string, sessions: SessionStore, action: string, sid: string, runId?: unknown,
  options: { approved?: boolean; allowReal?: boolean } = {}): Row {
  if (action === "list") return listRuns(stateDir, sessions, sid);
  if (action === "cancel") return cancelRun(stateDir, sessions, sid, runId);
  if (action === "resume") return resumeRun(stateDir, sessions, sid, runId, options);
  throw new DynamicRunError("invalid_arguments", `未知的 dwf 子命令: ${action}；用法 ${USAGE}`, 400);
}

/** `str.split()` with no arguments: split on Python whitespace, dropping empty runs. */
function splitWhitespace(text: string): string[] {
  const tokens: string[] = [];
  let current = "";
  for (let index = 0; index < text.length; index += 1) {
    if (pyIsSpace(text.charCodeAt(index))) {
      if (current) tokens.push(current);
      current = "";
    } else current += text[index];
  }
  if (current) tokens.push(current);
  return tokens;
}

/** `/dwf ...` text → `(action, runId)`, refusing anything unsupported. */
export function parseInvocation(argument: string): [string, string | null] {
  const tokens = splitWhitespace(argument || "");
  if (!tokens.length) return ["list", null];
  const action = pyCasefold(tokens[0] as string);
  if (!SUBCOMMANDS.includes(action)) {
    throw new DynamicRunError("invalid_arguments", `未知的 dwf 子命令: ${tokens[0]}；用法 /${USAGE}`, 400);
  }
  if ((action === "list" && tokens.length > 1) || tokens.length > 2) {
    throw new DynamicRunError("invalid_arguments", `用法 /${USAGE}`, 400);
  }
  if (action === "resume" && tokens.length !== 2) {
    throw new DynamicRunError("invalid_arguments", `resume 必须指定一个 runId；用法 /${USAGE}`, 400);
  }
  return [action, tokens.length > 1 ? (tokens[1] as string) : null];
}

/** Chat-loop face over the same implementation as the CLI and HTTP. */
export function chat(stateDir: string, sessions: SessionStore, session: Row, argument: string): Row {
  const [action, runId] = parseInvocation(argument);
  if (!isDict(session) || typeof session.id !== "string") {
    throw new DynamicRunError("session_not_found", "当前还没有会话，无法管理动态工作流运行。", 404);
  }
  return invoke(stateDir, sessions, action, session.id, runId);
}

export interface DynamicHttpOptions {
  stateDir: string;
  sessions: SessionStore;
  allowedRoots(): readonly string[];
  allowReal?: boolean;
}

/** `Path.is_relative_to` on canonical paths. */
function within(base: string, target: string): boolean {
  const rel = relative(base, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !/^[A-Za-z]:/.test(rel));
}

/** A web request may only manage runs inside a workspace the server permits. */
function webRootAllowed(options: DynamicHttpOptions, sid: unknown): void {
  const session = sessionOf(options.sessions, sid);
  try {
    const target = realish(session.root as string);
    if (options.allowedRoots().map((root) => realish(root)).some((base) => within(base, target))) return;
  } catch {
    // A workspace or root that cannot be resolved is outside every permitted base.
  }
  throw new DynamicRunError("workspace_not_allowed", "会话工作区不在服务器允许的范围内。", 403);
}

/** `(query or {}).get(key, [''])[0]`: a `str` value yields its first code point. */
function firstValue(query: Row, key: string): unknown {
  if (!isDict(query) || !Object.hasOwn(query, key)) return "";
  const value = query[key];
  if (Array.isArray(value)) return value.length ? value[0] : "";
  return typeof value === "string" ? pySlice(value, 1) : value;
}
/** `GET /api/workflows/dwf` plus `POST /api/workflows/dwf/cancel|resume`. */
export function dispatchDynamicRuns(method: string, parts: readonly string[], query: Row, data: Row,
  options: DynamicHttpOptions): [number, unknown] | null {
  if (!Array.isArray(parts) || parts[0] !== "api" || parts[1] !== "workflows" || parts[2] !== "dwf") return null;
  const action = parts.length === 3 ? "list" : parts[3] as string;
  if (parts.length > 4 || !SUBCOMMANDS.includes(action)) return [404, { error: "operation not found" }];
  if ((method === "GET") !== (action === "list")) return [405, { error: "method not allowed" }];
  if (options.sessions === null || options.sessions === undefined) return [500, { error: "session store unavailable" }];
  try {
    let approved = false;
    let sid: unknown;
    let runId: unknown = null;
    if (method === "GET") {
      const requested = firstValue(query, "session");
      if (typeof requested !== "string") return [400, { error: "invalid dwf request" }];
      sid = requested;
    } else {
      const keys = isDict(data) ? Object.keys(data) : [];
      if (!isDict(data) || keys.some((key) => !["session", "runId", "approve"].includes(key))) {
        return [400, { error: "expected session, optional runId and approve" }];
      }
      const requested = Object.hasOwn(data, "session") ? data.session : null;
      sid = typeof requested === "string" ? requested : null;
      runId = Object.hasOwn(data, "runId") ? data.runId : null;
      approved = (Object.hasOwn(data, "approve") ? data.approve : null) === true;
      if (runId !== null && typeof runId !== "string") return [400, { error: "runId must be a string" }];
      if (action === "resume" && typeof runId !== "string") return [400, { error: "resume requires runId" }];
    }
    webRootAllowed(options, sid);
    const result = invoke(options.stateDir, options.sessions, action, sid as string, runId,
      { approved, allowReal: options.allowReal === true });
    return [200, result];
  } catch (error) {
    if (error instanceof DynamicRunError) return [error.status, error.payload()];
    if (error instanceof PyTypeError || error instanceof PyKeyError) return [400, { error: "invalid dwf request" }];
    throw error;
  }
}
