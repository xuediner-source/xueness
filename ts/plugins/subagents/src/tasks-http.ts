/**
 * GET /api/sessions/<id>/tasks plus resume, message, transcript and cancel
 * (Python `child_api.handle` then `cancel_one.handle`). Any other tasks
 * action stays unowned. Disabled answers carry no `code`.
 */
import { isAbsolute, join, relative } from "node:path";
import { deriveEvents, headSeq, isDict, isPyIntValue, pyLen, pyStrip, pyTruthy, PyKeyError, PyValueError, uuid4Hex } from "@xueness/contracts";
import { isPyKeyError, isPyOSError, isPyValueError, pyExceptionName, realish } from "@xueness/sessions";
import { ChildJournal, projectChild } from "./child-journal.ts";
import { TaskCoordinator } from "./coordinator.ts";
import { validParent } from "./records.ts";
import { compareTasks, TaskRegistry } from "./task-registry.ts";

export interface SubagentTasksHttpOptions {
  stateDir: string | null;
  enabled(id: string): boolean;
  store: { load(sid: string): Promise<unknown> };
  projectDir: string;
  webRuns: string;
  allowedRoots(): readonly string[];
  registry?: TaskRegistry;
  cancelEnabled(): boolean;
  authorize?(session: Record<string, unknown>, tool: string, subject: string, requestId: string): Record<string, unknown> | null;
}
type Reply = [number, unknown];
type Row = Record<string, unknown>;
type Query = Record<string, readonly string[] | undefined>;
const TASK = /^task-[A-Za-z0-9_-]{1,160}$/;
const REQUEST = /^[A-Za-z0-9._:-]{1,160}$/;
const ACTIONS = new Set(["resume", "message", "messages", "transcript", "cancel"]);
const ACTIVE = "messages require this parent\u2019s active child";
const METHOD = [405, { error: "method not allowed" }] as Reply;
const EMPTY = [400, { error: "request body must be empty" }] as Reply;
export const SUBAGENT_TASK_ROUTES = ["GET /api/sessions/:id/tasks", "POST /api/sessions/:id/tasks/:task/cancel", "POST /api/sessions/:id/tasks/:task/resume", "POST /api/sessions/:id/tasks/:task/message", "POST /api/sessions/:id/tasks/:task/messages", "GET /api/sessions/:id/tasks/:task/transcript"];

const disabled = (): Reply => [403, { error: "plugin disabled or dependency unavailable: subagents", plugin: "subagents" }];
const refused = (): Reply => [403, { error: "workspace root not permitted" }];
const childMiss = (error: unknown): boolean => pyExceptionName(error) === "FileNotFoundError" || isPyOSError(error) || error instanceof TypeError || isPyValueError(error);

function fencedRoot(value: unknown, o: SubagentTasksHttpOptions): string {
  if (typeof value !== "string" || value.includes("\0")) throw new PyValueError("workspace root not permitted");
  const target = realish(isAbsolute(value) ? value : join(realish(o.webRuns), value));
  const roots = [o.webRuns, o.projectDir, ...o.allowedRoots()].map((root) => realish(root));
  if (!roots.some((root) => { const rel = relative(root, target); return rel === "" || !rel.startsWith("..") && !isAbsolute(rel); })) throw new PyValueError("workspace root not permitted");
  return target;
}

function visibleText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.filter((item) => isDict(item) && item.type === "text" && typeof item.text === "string").map((item) => (item as Row).text).join("\n");
}

export function createSubagentTasksHttp(o: SubagentTasksHttpOptions) {
  const registry = o.registry ?? new TaskRegistry();
  const owns = (_method: string, parts: readonly string[]): boolean => parts.length >= 4 && parts[0] === "api" && parts[1] === "sessions" && parts[3] === "tasks"
    && (parts.length === 4 || parts.length === 6 && ACTIONS.has(parts[5] ?? ""));
  const open = async (sid: string): Promise<{ session: Row; root: string } | Reply> => {
    if (!validParent(sid)) return refused();
    try {
      const session = await o.store.load(sid);
      if (!isDict(session)) throw new TypeError("session");
      if (!Object.hasOwn(session, "root")) throw new PyKeyError("root");
      return { session, root: fencedRoot(session.root, o) };
    } catch (error) {
      if (pyExceptionName(error) === "FileNotFoundError") return [404, { error: "session not found" }];
      if (isPyOSError(error) || isPyKeyError(error) || isPyValueError(error) || error instanceof TypeError || error instanceof Error && error.name === "RuntimeError") return refused();
      throw error;
    }
  };
  const rows = (session: Row, root: string): Row[] => {
    if (o.stateDir == null) throw new TypeError("state_dir");
    const parentId = session.id;
    const byId = new Map<string, Row>();
    for (const row of Array.isArray(session.task_runs) ? session.task_runs : []) if (isDict(row) && typeof row.id === "string") byId.set(row.id, { ...row });
    for (const row of registry.list(parentId)) if (typeof row.id === "string") byId.set(row.id, { ...row });
    const children = new ChildJournal(o.stateDir, String(parentId), { root }).children();
    const childByTask = new Map<string, Row>();
    for (const child of children) {
      if (!isDict(child.delegation) || typeof child.delegation.taskId !== "string") continue;
      const taskId = child.delegation.taskId;
      childByTask.set(taskId, child);
      const durable = projectChild(child);
      let current = registry.get(taskId);
      if (current == null) {
        const record = { ...byId.get(taskId) ?? {}, ...durable };
        registry.restore(taskId, { parentSession: parentId, root, record });
        current = registry.get(taskId) ?? record;
      } else if (!byId.has(taskId)) byId.set(taskId, current);
      current = { ...current };
      for (const key of ["childSessionId", "parentSessionId", "rootSessionId", "childStatus", "canResume", "recoveryReason", "summary", "error", "steps", "startedAt", "endedAt"]) {
        if (Object.hasOwn(durable, key)) current[key] = durable[key];
      }
      current.root = root;
      byId.set(taskId, current);
    }
    const parent = registry.parentFor(parentId);
    const canResumeNow = parent instanceof TaskCoordinator && parent.canResumeNow();
    for (const [taskId, row] of byId) {
      row.canResumeNow = canResumeNow && row.canResume === true;
      row.canGuide = row.status === "running" && row.workerActive === true && canResumeNow && childByTask.has(taskId);
      delete row.lastResumeRequestId;
      delete row.lastResumeRequestDigest;
    }
    return [...byId.values()].sort(compareTasks).slice(-100);
  };
  const coordinatorFor = (session: Row): TaskCoordinator | Reply => {
    const parent = registry.parentFor(session.id);
    if (!(parent instanceof TaskCoordinator) || parent.session.id !== session.id || !parent.canResumeNow()) return [409, { error: ACTIVE }];
    return parent;
  };
  const policy = (coordinator: TaskCoordinator, tool: string, taskId: string, requestId: string): Reply | null => {
    const denial = o.authorize?.(coordinator.session, tool, taskId, requestId) ?? null;
    if (denial == null) return null;
    return [denial.error_code === "approval_required" ? 409 : 403, denial];
  };
  const resume = async (method: string, taskId: string, data: unknown, session: Row, root: string): Promise<Reply> => {
    if (method !== "POST") return METHOD;
    if (!isDict(data) || Object.keys(data).some((key) => key !== "message" && key !== "requestId")) return [400, { error: "request body must contain only message and requestId" }];
    if (!TASK.test(taskId)) return [404, { error: "subtask not found" }];
    const message = data.message;
    if (message != null && (typeof message !== "string" || !pyStrip(message) || pyLen(message) > 24000)) return [400, { error: "message must contain 1..24000 characters" }];
    const supplied = data.requestId;
    const requestId = supplied == null || supplied === "" ? uuid4Hex() : supplied;
    if (typeof requestId !== "string" || !REQUEST.test(requestId)) return [400, { error: "requestId must contain 1..160 safe characters" }];
    const parent = registry.parentFor(session.id);
    if (!(parent instanceof TaskCoordinator) || parent.session.id !== session.id || !parent.canResumeNow()) return [409, { error: "start a parent turn before resuming this child" }];
    if (o.stateDir == null) return [404, { error: "subtask not found" }];
    try { new ChildJournal(o.stateDir, String(session.id), { taskId, root }).findTask(taskId); }
    catch (error) { if (childMiss(error)) return [404, { error: "subtask not found" }]; throw error; }
    const denial = policy(parent, "task_resume", taskId, requestId);
    if (denial) return denial;
    const result = parent.resume(requestId, { task_id: taskId, message });
    if (result.ok !== true) return [409, { error: result.error || "child could not be resumed" }];
    const body: Row = {};
    for (const key of ["task_id", "childSessionId", "status", "background", "evidence_eligible"]) if (Object.hasOwn(result, key)) body[key] = result[key];
    return [202, body];
  };
  const message = async (method: string, taskId: string, data: unknown, session: Row, root: string): Promise<Reply> => {
    if (method !== "POST") return METHOD;
    if (!isDict(data) || Object.keys(data).some((key) => key !== "message" && key !== "requestId")) return [400, { error: "request body must contain only message and requestId" }];
    if (!TASK.test(taskId)) return [404, { error: "subtask not found" }];
    if (typeof data.requestId !== "string" || !REQUEST.test(data.requestId)) return [400, { error: "requestId must contain 1..160 safe characters" }];
    if (typeof data.message !== "string" || !pyStrip(data.message) || pyLen(data.message) > 24000) return [400, { error: "message must contain 1..24000 characters" }];
    const task = registry.get(taskId);
    if (!task || task.parent !== session.id || task.status !== "running" || task.workerActive !== true) return [409, { error: ACTIVE }];
    if (o.stateDir == null) return [409, { error: "child could not accept this message" }];
    let child: Row;
    try { child = new ChildJournal(o.stateDir, String(session.id), { taskId, root }).findTask(taskId); }
    catch (error) { if (childMiss(error)) return [409, { error: "child could not accept this message" }]; throw error; }
    const parent = coordinatorFor(session);
    if (Array.isArray(parent)) return parent;
    const denial = policy(parent, "task_send_message", taskId, data.requestId);
    if (denial) return denial;
    const result = parent.sendMessage({ task_id: taskId, message: data.message }, data.requestId);
    if (result.ok !== true) return [409, { error: result.error || "child could not accept this message" }];
    return [202, { task_id: taskId, childSessionId: child.id, receipt: result.receipt, delivery: result.delivery }];
  };
  const transcript = (method: string, taskId: string, data: unknown, session: Row, root: string): Reply => {
    if (method !== "GET") return METHOD;
    if (pyTruthy(data)) return EMPTY;
    if (!TASK.test(taskId)) return [404, { error: "subtask not found" }];
    if (o.stateDir == null) return [404, { error: "subtask not found" }];
    let child: Row;
    try { child = new ChildJournal(o.stateDir, String(session.id), { taskId, root }).findTask(taskId); }
    catch (error) { if (childMiss(error)) return [404, { error: "subtask not found" }]; throw error; }
    const timeline = deriveEvents(child);
    const messages = (Array.isArray(child.messages) ? child.messages : []).filter(isDict);
    let firstUser = false;
    const userTexts: string[] = [], assistantTexts: string[] = [];
    for (const item of messages) {
      if (item.role === "user") {
        if (!firstUser) firstUser = true;
        else if (item._input_kind !== "guide") userTexts.push(visibleText(item.content ?? ""));
      } else if (item.role === "assistant" && pyTruthy(item.content)) assistantTexts.push(visibleText(item.content ?? ""));
    }
    let userIndex = 0, assistantIndex = 0;
    for (const event of timeline) {
      if (event.type === "turn.user" && userIndex < userTexts.length) event.preview = userTexts[userIndex++];
      else if (event.type === "assistant.text" && assistantIndex < assistantTexts.length) event.preview = assistantTexts[assistantIndex++];
    }
    const head = headSeq(timeline);
    const steps = isPyIntValue(child.steps) && typeof child.steps === "number" ? child.steps : 0;
    const envelope = { schema: "xueness.events.v1", protocolVersion: 1, sessionId: child.id, status: pyTruthy(child.status) ? String(child.status) : "", steps, mode: pyTruthy(child.mode) ? String(child.mode) : "plan", events: timeline, cursor: 0, nextCursor: head, head, hasMore: false };
    let initialPrompt = "";
    for (const item of Array.isArray(child.messages) ? child.messages : []) {
      if (!isDict(item) || item.role !== "user") continue;
      initialPrompt = visibleText(item.content ?? "");
      break;
    }
    return [200, { childSessionId: child.id, status: envelope.status, initialPrompt, timeline: envelope }];
  };
  const cancel = async (method: string, taskId: string, data: unknown, session: Row, root: string): Promise<Reply> => {
    if (method !== "POST") return METHOD;
    if (pyTruthy(data)) return EMPTY;
    if (!o.cancelEnabled()) return [403, { error: "single subtask cancellation is disabled" }];
    const task = registry.get(taskId);
    if (!task) return [404, { error: "subtask not found" }];
    if (task.parent !== session.id) return [403, { error: "subtask does not belong to session" }];
    if (typeof task.root !== "string") return [403, { error: "subtask workspace does not match session" }];
    try { if (realish(task.root) !== root) return [403, { error: "subtask workspace does not match session" }]; }
    catch { return [403, { error: "subtask workspace does not match session" }]; }
    if (!registry.cancel(taskId)) return [409, { error: "subtask is not running" }];
    return [200, { cancelled: true, taskId }];
  };
  return {
    routes: SUBAGENT_TASK_ROUTES, registry, owns,
    async dispatch(method: string, parts: string[], _query: Query, data: unknown): Promise<Reply | null> {
      const verb = method.toUpperCase();
      if (!owns(verb, parts)) return null;
      if (!o.enabled("subagents")) return disabled();
      // cancel_one answers method, body and the disabled flag before any lookup.
      if (parts.length === 6 && parts[5] === "cancel") {
        if (verb !== "POST") return METHOD;
        if (pyTruthy(data)) return EMPTY;
        if (!o.cancelEnabled()) return [403, { error: "single subtask cancellation is disabled" }];
      }
      const opened = await open(parts[2] ?? "");
      if (Array.isArray(opened)) return opened;
      if (parts.length === 4) {
        if (verb !== "GET") return METHOD;
        if (pyTruthy(data)) return EMPTY;
        try { return [200, { tasks: rows(opened.session, opened.root) }]; }
        catch (error) { if (isPyOSError(error) || error instanceof TypeError || isPyValueError(error)) return [200, { tasks: [] }]; throw error; }
      }
      const taskId = parts[4] ?? "";
      if (parts[5] === "cancel") return cancel(verb, taskId, data, opened.session, opened.root);
      if (parts[5] === "resume") return resume(verb, taskId, data, opened.session, opened.root);
      if (parts[5] === "message" || parts[5] === "messages") return message(verb, taskId, data, opened.session, opened.root);
      return transcript(verb, taskId, data, opened.session, opened.root);
    },
  };
}
