/**
 * Model-facing workflow and background-job tools (Python
 * `bundled_plugins/workflows/tools.py`).
 *
 * Plans are strict JSON DAGs: nothing is ever evaluated. Starting a workflow
 * or a command is an exec-gated action bound to the exact journaled arguments,
 * so `subject()` renders the same compact, sorted JSON as Python's `_subject`
 * and an approval recorded by either backend replays against the same text.
 *
 * Python checks its Gate by hand at a fixed point inside each handler. The
 * kernel here authorizes before `run`, so the checks Python makes *before* its
 * Gate live in `precheck` and the remaining ones stay in `run`, in order. That
 * split is load-bearing: a refusal Python returns as a value
 * (`{"ok": False, ...}`) or raises before `gate.check` must not become an
 * approval prompt.
 */
import { isDict, pyGetItem, pyJsonDumps, pyTruthy, PyValueError, type CapabilityDeclaration, type JsonSchema } from "@xueness/contracts";
import type { ToolDefinition, ToolResult } from "@xueness/engine-tools";
import { PyOSError } from "@xueness/sessions";
import { compileWorkflowScript } from "./dsl.ts";
import { ownerSessionId } from "./dynamic-runs.ts";
import { isDirectory, resolvePath, workflowPlanDigest, type Row } from "./plan.ts";
import { latestRunPlan, sourcePlan, templatePlanDigest, type SavedWorkflowLibrary } from "./saved-library.ts";
import type { WorkflowStore } from "./store.ts";
import { dynamicWorkflowTools } from './dynamic-tools.ts';
import type { DynamicWorkflowService } from './dynamic-service.ts';

export interface WorkflowToolsOptions {
  dynamic?: DynamicWorkflowService;
  store(): WorkflowStore;
  library(): SavedWorkflowLibrary;
  stateDir: string;
  session(): Row | null;
  /** The session's real-model permission; the HTTP surface hands it to `launch`. */
  allowReal(): boolean;
  /** Host ceiling: the web real-provider switch, checked before any approval. */
  allowRealHost(): boolean;
  /** Answer an actor through its own transcript and return the updated workflow row. */
  answerActor(wid: string, nodeId: string, answer: string): Promise<Row>;
}

/** `PermissionError`, an `OSError`: a workspace boundary, not a malformed value. */
class PermissionError extends PyOSError {
  override name = "PermissionError";
}

const denied = (message: string): PermissionError => new PermissionError(message, "permission_denied");
/** `ValueError` carrying the result code the kernel reports for a bad argument. */
const invalid = (message: string): PyValueError => Object.assign(new PyValueError(message), { code: "invalid_argument" });
const get = (row: Row, key: string, fallback: unknown): unknown => (Object.hasOwn(row, key) ? row[key] : fallback);

/** `_subject`: `json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))`. */
const subject = (value: unknown): string => pyJsonDumps(value, { ensureAscii: false, sortKeys: true, separators: [",", ":"] });

/** A Python handler's `{"ok": True, ...}` dict as a tool result. */
const reply = (data: Row): ToolResult<Row> => ({ ok: true, output: pyJsonDumps(data), data });
/** `{"ok": False, "error": ...}`: the refusal Python returns instead of raising. */
function refused(message: string): ToolResult<Row> {
  const data: Row = { ok: false, error: message };
  return { ok: false, output: pyJsonDumps(data), data, error: { code: "permission_denied", message } };
}

/** State records, plus the workspace reads plan validation and the fingerprint make. */
const STATE: CapabilityDeclaration = { fs: { write: ["state"], read: ["workspace"] } };
/** Starting a run spawns the detached worker, so these also need the exec grant. */
const EXEC: CapabilityDeclaration = { exec: ["*"], fs: { write: ["state"], read: ["workspace"] } };
/** `list_saved_workflows` reads the library and nothing else. */
const SAVED: CapabilityDeclaration = { fs: { read: ["state"] } };

/** `_string`: a bounded, nonempty string. */
const text = (description: string, maximum = 256): JsonSchema => ({ type: "string", minLength: 1, maxLength: maximum, description });
const flag = (description: string): JsonSchema => ({ type: "boolean", description });
/** Python's published shape: `additionalProperties: false` plus the required keys. */
const schema = (properties: Record<string, JsonSchema>, required: readonly string[] = []): JsonSchema =>
  ({ type: "object", additionalProperties: false, properties, required });
const WORKFLOW_ID = (): JsonSchema => text("Workflow id", 32);
const JOB_ID = (): JsonSchema => text("Workflow job id", 32);

/** `_root(session)`: the session's workspace, which every tool is fenced to. */
function workspaceOf(options: WorkflowToolsOptions): string {
  const session = options.session();
  if (!isDict(session) || typeof session.root !== "string") throw invalid("workflow tools require an active session");
  const root = resolvePath(session.root);
  if (!isDirectory(root)) throw invalid("session workspace is unavailable");
  return root;
}

/** One stored run, only when it belongs to this session's workspace. */
function owned(options: WorkflowToolsOptions, wid: unknown, message: string): Row {
  const record = options.store().load(wid);
  if (get(record, "root", null) !== workspaceOf(options)) throw denied(message);
  return record;
}

/**
 * Python's `allow_real and gate.web_approval_gate and not gate.allow_real`:
 * the host's real-provider switch is the ceiling. `allowReal()` is the
 * session's own permission, which these handlers never consult.
 */
const hostDisabled = (options: WorkflowToolsOptions, input: Row): boolean =>
  get(input, "allow_real", false) === true && !options.allowRealHost();

/** `_plan`: exactly one of a literal plan or DSL source. */
function planOf(args: Row, root: string): unknown {
  const hasPlan = Object.hasOwn(args, "plan"), hasScript = Object.hasOwn(args, "script");
  if (hasPlan === hasScript) throw invalid("provide exactly one of plan or script");
  if (hasPlan) return args.plan;
  return compileWorkflowScript(args.script as string, root);
}

/** `_saved_source`: exactly one template source, and the provenance to record. */
function savedSource(options: WorkflowToolsOptions, args: Row, workspace: string): { plan: Row; source: Row } {
  const latest = get(args, "latest", false);
  if (typeof latest !== "boolean") throw invalid("latest must be a boolean");
  const sources = ["plan", "script", "workflow_id"].filter((key) => Object.hasOwn(args, key));
  if (latest) sources.push("latest");
  if (sources.length !== 1) throw invalid("provide exactly one of plan, script, workflow_id or latest");
  const kind = sources[0] as string;
  if (kind === "plan" || kind === "script") return { plan: planOf(args, workspace) as Row, source: { kind } };
  const state = options.store().state;
  const found = kind === "workflow_id" ? sourcePlan(state, args.workflow_id, workspace) : latestRunPlan(state, workspace);
  return { plan: found.plan as Row, source: found.source as Row };
}

/** `_run_subject`. */
function runSubject(args: Row): string {
  return subject({ workflow_id: pyGetItem(args, "workflow_id"), approved: true, allow_real: get(args, "allow_real", false), plan_digest: pyGetItem(args, "plan_digest") });
}

/** `_saved_subject`: the digest comes from the template's current content. */
function savedSubject(record: Row, args: Row): string {
  return subject({ saved_workflow: pyGetItem(record, "name"), approved: true, allow_real: get(args, "allow_real", false), plan_digest: templatePlanDigest(pyGetItem(record, "plan") as Row) });
}

/**
 * `_run`'s checks, shared by `precheck` (before approval) and `run`. It also
 * proves `input.plan_digest` is the record's current digest, which is why
 * `run` can hand that same value to `launch` as `expected_digest`: a plan
 * edited during the approval wait then fails there, exactly as in Python.
 */
function verified(options: WorkflowToolsOptions, input: Row): Row {
  const record = options.store().load(pyGetItem(input, "workflow_id"));
  if (get(record, "root", null) !== workspaceOf(options)) throw denied("workflow belongs to another workspace");
  if (input.plan_digest !== workflowPlanDigest(record)) throw invalid("workflow plan changed; inspect status and approve the current digest");
  return record;
}

/**
 * The template `precheck` bound the approval to. Python loads it once, before
 * `gate.check`, and hands that same object to `create`; re-loading after the
 * wait could instantiate a template the operator never saw.
 */
const BOUND_TEMPLATE = new WeakMap<object, Row>();

export function workflowTools(options: WorkflowToolsOptions): ToolDefinition[] {
  const tools: ToolDefinition<Row, Row>[] = [
    {
      name: "workflow_create",
      description: "Create a declarative workflow DAG in this session workspace",
      inputSchema: schema({
        plan: { type: "object", description: "Literal declarative DAG; exclusive with script" },
        script: { type: "string", maxLength: 32000, description: "Safe phase/agent/parallel/pipeline DSL; exclusive with plan" },
        reuse: text("Settled workflow id to reuse unchanged nodes", 32),
      }),
      gate: "planning", mutating: false, concurrencySafe: false, requires: STATE,
      async run(input) {
        const workspace = workspaceOf(options);
        const row = options.store().create(planOf(input, workspace), workspace, get(input, "reuse", null), ownerSessionId(options.session()));
        return reply({ ok: true, workflow: row });
      },
    },
    {
      name: "workflow_amend",
      description: "Replace a settled workflow plan; completed work is invalidated",
      inputSchema: schema({
        workflow_id: WORKFLOW_ID(), plan: { type: "object" }, script: { type: "string", maxLength: 32000 },
      }, ["workflow_id"]),
      gate: "planning", mutating: false, concurrencySafe: false, requires: STATE,
      async run(input) {
        const workspace = workspaceOf(options);
        return reply({ ok: true, workflow: options.store().amend(pyGetItem(input, "workflow_id"), planOf(input, workspace), workspace) });
      },
    },
    {
      name: "workflow_run",
      description: "Start an approved workflow; this action requires operator approval",
      inputSchema: schema({
        workflow_id: WORKFLOW_ID(), allow_real: flag("Opt in to real model calls by actor nodes"),
        plan_digest: text("Digest returned by workflow_status/create; approval binds to this plan", 64),
      }, ["workflow_id", "plan_digest"]),
      gate: "exec", mutating: true, concurrencySafe: false, requires: EXEC,
      subject: (input) => runSubject(input),
      precheck(input) {
        // Python validates the record, the workspace, the digest and the host
        // switch before its Gate: a refusal must not become an approval prompt.
        verified(options, input);
        return hostDisabled(options, input) ? refused("real provider disabled by host") : null;
      },
      async run(input) {
        // `precheck` proved this is the digest the approval was bound to.
        return reply({ ok: true, workflow: options.store().launch(pyGetItem(input, "workflow_id"), true, get(input, "allow_real", false) === true, pyGetItem(input, "plan_digest") as string) });
      },
    },
    {
      name: "workflow_status",
      description: "Inspect workflow state and its bounded event journal",
      inputSchema: schema({ workflow_id: WORKFLOW_ID() }, ["workflow_id"]),
      gate: "planning", mutating: false, concurrencySafe: false, requires: STATE,
      async run(input) {
        const row = owned(options, pyGetItem(input, "workflow_id"), "workflow belongs to another workspace");
        row.plan_digest = workflowPlanDigest(row);
        return reply({ ok: true, workflow: row });
      },
    },
    {
      name: "background_exec",
      description: "Start a literal argv command as a durable background job; requires operator approval",
      inputSchema: schema({
        argv: { type: "array", minItems: 1, maxItems: 128, items: { type: "string", maxLength: 16000 } },
        timeout: { type: "number", minimum: 0.1, maximum: 3600 }, name: text("Optional job label", 120),
      }, ["argv"]),
      gate: "exec", mutating: true, concurrencySafe: false, requires: EXEC,
      subject: (input) => subject(pyGetItem(input, "argv")),
      async run(input) {
        const argv = pyGetItem(input, "argv") as string[];
        const root = workspaceOf(options);
        const label = get(input, "name", null);
        // `args.get("name") or argv[0]`: an empty label falls back to the program.
        const plan: Row = { name: pyTruthy(label) ? label : argv[0], nodes: [{ id: "command", argv, timeout: get(input, "timeout", 300) }] };
        const store = options.store();
        const created = store.create(plan, root, null, ownerSessionId(options.session()));
        return reply({ ok: true, workflow: store.launch(created.id, true) });
      },
    },
    {
      name: "background_status",
      description: "Inspect a background command job",
      inputSchema: schema({ job_id: JOB_ID() }, ["job_id"]),
      gate: "planning", mutating: false, concurrencySafe: false, requires: STATE,
      async run(input) {
        return reply({ ok: true, job: owned(options, pyGetItem(input, "job_id"), "job belongs to another workspace") });
      },
    },
    {
      name: "background_cancel",
      description: "Request cancellation of a background command job",
      inputSchema: schema({ job_id: JOB_ID() }, ["job_id"]),
      gate: "exec", mutating: true, concurrencySafe: false, requires: STATE,
      subject: (input) => subject(["background_cancel", pyGetItem(input, "job_id")]),
      precheck(input) {
        // Python loads and fences the job before `gate.check`.
        owned(options, pyGetItem(input, "job_id"), "job belongs to another workspace");
        return null;
      },
      async run(input) {
        return reply({ ok: true, job: options.store().control(pyGetItem(input, "job_id"), "cancel") });
      },
    },
    {
      name: "background_logs",
      description: "Read the bounded output tail of a background command job",
      inputSchema: schema({ job_id: JOB_ID() }, ["job_id"]),
      gate: "planning", mutating: false, concurrencySafe: false, requires: STATE,
      async run(input) {
        owned(options, pyGetItem(input, "job_id"), "job belongs to another workspace");
        const log = options.store().log(pyGetItem(input, "job_id"), "command");
        return reply({ ok: true, output: log.output, truncated: log.truncated });
      },
    },
    {
      name: "workflow_answer_actor",
      description: "Answer a paused workflow actor and resume its transcript",
      inputSchema: schema({
        workflow_id: WORKFLOW_ID(), node_id: text("Actor node id", 64), answer: text("Operator answer", 5000),
      }, ["workflow_id", "node_id", "answer"]),
      gate: "exec", mutating: true, concurrencySafe: false, requires: STATE,
      subject: (input) => subject(["workflow_answer_actor", pyGetItem(input, "workflow_id"), pyGetItem(input, "node_id"), pyGetItem(input, "answer")]),
      precheck(input) {
        owned(options, pyGetItem(input, "workflow_id"), "workflow belongs to another workspace");
        return null;
      },
      async run(input) {
        const row = await options.answerActor(pyGetItem(input, "workflow_id") as string, pyGetItem(input, "node_id") as string, pyGetItem(input, "answer") as string);
        return reply({ ok: true, workflow: row });
      },
    },
    {
      name: "save_workflow",
      description: "Save a validated workflow DAG as a named reusable template (pure data, no code)",
      inputSchema: schema({
        name: text("Template name: letters/digits/dot/dash/underscore, 1..64 chars, starting with a letter or digit", 64),
        plan: { type: "object", description: "Literal declarative DAG; one source only" },
        script: { type: "string", maxLength: 32000, description: "Safe phase/agent/parallel/pipeline DSL; one source only" },
        workflow_id: text("Save the plan of this settled run in the current workspace", 32),
        latest: flag("Save the most recent run in the current workspace"),
        description: text("Human-readable template description", 500),
        overwrite: flag("Explicitly replace an existing template of the same name"),
      }, ["name"]),
      gate: "planning", mutating: false, concurrencySafe: false, requires: STATE,
      async run(input) {
        const workspace = workspaceOf(options);
        const { plan, source } = savedSource(options, input, workspace);
        const saved = options.library().save(plan, pyGetItem(input, "name"), workspace, {
          description: get(input, "description", undefined), overwrite: get(input, "overwrite", undefined), source,
        });
        return reply({ ok: true, saved });
      },
    },
    {
      name: "list_saved_workflows",
      description: "List saved workflow templates: name, description, node count and save time",
      inputSchema: schema({}),
      gate: "planning", mutating: false, concurrencySafe: true, requires: SAVED,
      async run() {
        return reply({ ok: true, saved: options.library().list() });
      },
    },
    {
      name: "run_saved_workflow",
      description: "Instantiate a saved workflow template in this workspace and start it; requires operator approval",
      inputSchema: schema({ name: text("Saved template name", 64), allow_real: flag("Opt in to real model calls by actor nodes") }, ["name"]),
      gate: "exec", mutating: true, concurrencySafe: false, requires: STATE,
      // Approval replay recomputes the subject from the template's current
      // content, so a template changed after approval is no longer approvable.
      subject: (input) => savedSubject(options.library().load(input.name), input),
      precheck(input) {
        // Python loads the template, then the workspace, then the host switch,
        // all before its Gate.
        BOUND_TEMPLATE.set(input, options.library().load(pyGetItem(input, "name")));
        workspaceOf(options);
        return hostDisabled(options, input) ? refused("real provider disabled by host") : null;
      },
      async run(input) {
        const record = BOUND_TEMPLATE.get(input) ?? options.library().load(pyGetItem(input, "name"));
        const workspace = workspaceOf(options);
        // Instantiation reuses the create/launch path of a hand-written plan:
        // validation, Gate checks and the real-model opt-in all run again.
        const store = options.store();
        const created = store.create(pyGetItem(record, "plan"), workspace, null, ownerSessionId(options.session()));
        return reply({ ok: true, saved_workflow: pyGetItem(record, "name"), workflow: store.launch(created.id, true, get(input, "allow_real", false) === true) });
      },
    },
  ];
  return [...tools, ...dynamicWorkflowTools({ service: () => options.dynamic, session: options.session })];
}
