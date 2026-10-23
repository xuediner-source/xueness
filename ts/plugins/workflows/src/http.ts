/**
 * Web controls for durable workflows (Python
 * `bundled_plugins/workflows/operations_api.py`).
 *
 *   GET  /api/workflows                     visible runs (inside a permitted root)
 *   POST /api/workflows                     create a plan in a permitted workspace
 *   GET  /api/workflows/<id>                one record
 *   GET  /api/workflows/<id>/logs/<node>    the bounded log tail
 *   POST /api/workflows/<id>/actors/<node>/answer
 *   POST /api/workflows/<id>/amend|start|resume|pause|cancel|concurrency|recover
 *
 * `/api/workflows/dwf...` belongs to `dynamic-runs.ts` and `/api/workflows/expert`
 * to the caller's expert module; both are asked first, as in Python. Errors map
 * to the same statuses Python's handler returns, including the generic 400 that
 * never echoes the exception text.
 */
import { isAbsolute, join, relative } from "node:path";
import { isDict, PyValueError } from "@xueness/contracts";
import { isPyKeyError, isPyOSError, isPyValueError, PyBlockingIOError, realish, type SessionStore } from "@xueness/sessions";
import { compileWorkflowScript } from "./dsl.ts";
import type { Row } from "./plan.ts";
import type { WorkflowStore } from "./store.ts";

type Reply = [number, unknown];

export interface WorkflowHttpOptions {
  stateDir: string;
  store(): WorkflowStore;
  sessionStore: SessionStore;
  allowedRoots(): readonly string[];
  allowReal(): boolean;
  allowRealHost(): boolean;
  /** Answer an actor through its own transcript and return the updated workflow row. */
  answerActor(wid: string, nodeId: string, answer: string): Promise<Row>;
  /** `/api/workflows/expert...`; null when the expert module does not own the path. */
  expert(options: Row): [number, unknown] | null;
  /** `/api/workflows/dwf...`; null when the path is not a dynamic-run request. */
  dynamicRuns(method: string, parts: readonly string[], query: Row, data: Row): [number, unknown] | null;
}

/** Declared route patterns; `*` is one path segment. */
export const WORKFLOW_ROUTES: readonly string[] = [
  "GET /api/workflows", "POST /api/workflows", "GET /api/workflows/*", "GET /api/workflows/*/logs/*",
  "POST /api/workflows/*/actors/*/answer", "POST /api/workflows/*/amend", "POST /api/workflows/*/start",
  "POST /api/workflows/*/resume", "POST /api/workflows/*/pause", "POST /api/workflows/*/cancel",
  "POST /api/workflows/*/concurrency", "POST /api/workflows/*/recover", "GET /api/workflows/dwf",
  "POST /api/workflows/dwf/*", "GET /api/workflows/expert", "POST /api/workflows/expert",
  "GET /api/workflows/expert/*", "POST /api/workflows/expert/*/*",
];

const OPERATION_NOT_FOUND = "operation not found";
const NOT_PERMITTED = "workspace root not permitted";
const INVALID = "invalid operation, plan, approval or workspace";

/** `Path.is_relative_to` on two resolved paths. */
function within(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * `web._allowed_root`: a relative root is resolved against the server's runs
 * directory and the target must sit inside a permitted base. The host passes
 * `allowedRoots()` already containing web-runs and the project directory, so
 * that list is the fence; its first entry is the base for relative values.
 */
function fence(options: WorkflowHttpOptions, value: unknown): string {
  if (typeof value !== "string" || !value) throw new PyValueError("workspace root is required");
  if (value.includes("\0")) throw new PyValueError("embedded null byte");
  const roots = options.allowedRoots().map((root) => realish(root));
  const target = realish(isAbsolute(value) ? value : join(roots[0] ?? realish(options.stateDir), value));
  if (roots.some((root) => within(root, target))) return target;
  throw new PyValueError(NOT_PERMITTED);
}

/** `submitted_plan`: exactly one of a literal plan or DSL source, validated later by `create`. */
function submittedPlan(payload: Row, root: string): unknown {
  const hasPlan = Object.hasOwn(payload, "plan"), hasScript = Object.hasOwn(payload, "script");
  if (hasPlan === hasScript) throw new PyValueError("provide exactly one of plan or script");
  if (hasPlan) return payload.plan;
  return compileWorkflowScript(payload.script as string, root);
}

/** `FileNotFoundError` from a record, template or log read. */
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException | null)?.code === "ENOENT";

/**
 * Python's `except` ladder, in its order: `BlockingIOError` (an `OSError`
 * subclass) is 409, `FileNotFoundError` 404, and `ValueError` / `TypeError` /
 * `KeyError` collapse into one generic 400 that never echoes the text. A
 * launcher that cannot spawn raises an `OSError` too, and the family answers
 * that with the same generic 400 instead of a 500 body.
 */
function failure(error: unknown): Reply {
  if (error instanceof PyBlockingIOError) return [409, { error: "run has a live owner" }];
  if (missing(error)) return [404, { error: "resource not found" }];
  if (isPyValueError(error) || isPyKeyError(error) || error instanceof TypeError || error instanceof RangeError) {
    return [400, { error: INVALID }];
  }
  if (isPyOSError(error)) return [400, { error: INVALID }];
  throw error;
}

/** `GET /api/workflows`: only runs whose root this server would still accept. */
function visible(options: WorkflowHttpOptions): Row[] {
  const rows: Row[] = [];
  for (const item of options.store().list()) {
    try {
      fence(options, item.root);
      rows.push(item);
    } catch (error) {
      if (!isPyValueError(error)) throw error;
    }
  }
  return rows;
}

/** `record = store.load(wid); root_for(record['root'])`: loaded, then fenced. */
function record(options: WorkflowHttpOptions, wid: string): Row {
  const found = options.store().load(wid);
  fence(options, found.root);
  return found;
}

export function createWorkflowHttp(options: WorkflowHttpOptions) {
  const owns = (method: string, parts: readonly string[]): boolean => {
    void method;
    return parts.length >= 2 && parts[0] === "api" && parts[1] === "workflows";
  };
  /** `POST <id>/<action>`: amend, start/resume, or a control (`store.control` judges the action). */
  const act = (wid: string, action: string, data: Row, found: Row): Reply => {
    const store = options.store();
    if (action === "amend") {
      const root = fence(options, found.root);
      return [200, store.amend(wid, submittedPlan(data, root), root)];
    }
    if (action === "start" || action === "resume") {
      // Python hands `launch` the host's real-provider switch, not the session's.
      return [200, store.launch(wid, data.approve === true, options.allowRealHost())];
    }
    return [200, store.control(wid, action, data.concurrency)];
  };
  /** `POST <id>/actors/<node>/answer`: the store validates the answer before the host writes it. */
  const answer = async (wid: string, nodeId: string, data: Row): Promise<Reply> => {
    const text = data.answer;
    // `answer_actor` starts by refusing anything that is not 1..5000 characters.
    options.store().actorAwaiting(wid, nodeId, text);
    return [200, await options.answerActor(wid, nodeId, text as string)];
  };
  return {
    routes: WORKFLOW_ROUTES,
    owns,
    async dispatch(method: string, parts: readonly string[], query: Row, data: Row): Promise<Reply | null> {
      if (!owns(method, parts)) return null;
      const body = isDict(data) ? data : {};
      try {
        // Dynamic runs and the expert workflow own their own sub-trees.
        if (parts.length >= 3 && parts[2] === "dwf") return options.dynamicRuns(method, parts, query, body);
        if (parts.length >= 3 && parts[2] === "expert") return options.expert({ method, parts, query, data: body, stateDir: options.stateDir });
        if (parts.length === 2) {
          if (method === "GET") return [200, { workflows: visible(options) }];
          if (method === "POST") {
            const root = fence(options, body.root);
            return [200, options.store().create(submittedPlan(body, root), root, body.reuse)];
          }
          return [404, { error: OPERATION_NOT_FOUND }];
        }
        const wid = parts[2] as string;
        // Every deeper route is fenced before it looks at the method or action.
        const found = record(options, wid);
        if (parts.length === 3 && method === "GET") return [200, found];
        if (parts.length === 5 && parts[3] === "logs" && method === "GET") {
          const log = options.store().log(wid, parts[4]);
          return [200, { output: log.output, truncated: log.truncated }];
        }
        if (parts.length === 6 && parts[3] === "actors" && parts[5] === "answer" && method === "POST") {
          return await answer(wid, parts[4] as string, body);
        }
        if (parts.length === 4 && method === "POST") return act(wid, parts[3] as string, body, found);
        return [404, { error: OPERATION_NOT_FOUND }];
      } catch (error) {
        return failure(error);
      }
    },
  };
}
