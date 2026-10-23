/**
 * The agent branch of Python `workflows._execute`, plus the permission ceiling
 * helpers it consults (`_owner_permission_ceiling`, `workflow_child_writable`,
 * `workflow_command_allowed`) and the `ProviderGovernor` slot wait.
 *
 * A plugin may not run a model itself, so the actor execution is delegated to
 * the host through `AgentNodeHost` (`workflows.agent`). Everything that decides
 * *what* to run stays here: the plan-mode ceiling, the dependency context, the
 * provider bucket, the slot wait and the status mapping.
 */
import { join } from "node:path";
import { isDict, numericValue, pyJsonDumps, pySlice, pyTruthy, PyValueError, uuid4Hex } from "@xueness/contracts";
import { ProviderGovernor } from "./governor.ts";
import { ID, nowSeconds, resolvePath, type Row } from "./plan.ts";
import { readJson } from "./state-file.ts";
import { type WorkflowStore } from "./store.ts";
import type { RunControl } from "./execute-command.ts";

/** The host's actor runner: it owns the model, the Gate and the session journal. */
export interface AgentNodeHost {
  /** Run one read-only or writable actor; returns Python `run()`'s result row. */
  run(request: {
    prompt: string; root: string; sessionId: string | null; writable: boolean;
    providerId: string | null; model: string | null; context: string | null;
    timeoutSeconds: number; shouldStop(): boolean;
    /** The run's actor transcripts: `workflows/<wid>-sessions`. */
    sessions: string;
    /** Host-owned dynamic workflow cancellation; legacy DAG callers may omit it. */
    signal?: AbortSignal;
  }): Promise<Row>;
  /** Open or create the actor session in `sessions`; returns its id. */
  ensureSession(prompt: string, cwd: string, existingId: string | null, sessions: string): Promise<string>;
  enabled(id: string): boolean;
  /**
   * `provider_name + ':' + str(model)` for the resolved provider: the profile id
   * or `type(provider).__name__.casefold()`, and the node model or the
   * provider's own. Resolving may throw, as Python's `resolve` does.
   */
  bucket?(providerId: string | null, model: string | null): string;
}

/** `core.MODES`: the kernel's hard ceiling, separate from the permission mode. */
const MODES: ReadonlySet<string> = new Set(["plan", "build"]);
/** `plan_mode.PERMISSION_MODES`: the session's own permission vocabulary. */
const PERMISSION_MODES: ReadonlySet<string> = new Set(["build", "edit", "yolo", "plan"]);
const SLOT_POLL_MS = 50;
const DEPENDENCY_CHARS = 12_000;
const DEPENDENCY_OUTPUT_CHARS = 3_000;

const pause = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });
const isPermissionMode = (value: unknown): value is string => typeof value === "string" && PERMISSION_MODES.has(value);
const get = (row: Row, key: string, fallback: unknown): unknown => (Object.hasOwn(row, key) ? row[key] : fallback);

/** `Store(directory).load(sid)`, or null when it cannot be read (`OSError` / `ValueError`). */
function readJournal(directory: string, sid: unknown): Row | null {
  if (typeof sid !== "string" || !ID.test(sid)) return null;
  try {
    const value = readJson(join(directory, sid + ".json"));
    return isDict(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Live permission of the session that owns this run.
 *
 * Operator runs (no `owner_session`) return `[null, null]` and keep the plan
 * they were approved with. A stamped owner that cannot be loaded, or a stored
 * mode outside the vocabulary, fails closed to plan.
 */
export function ownerPermissionCeiling(store: WorkflowStore, record: Row): [string | null, string | null] {
  const owner = record.owner_session;
  if (typeof owner !== "string" || !owner) return [null, null];
  const session = readJournal(store.state, owner);
  if (session === null) return ["plan", "plan"];
  const rawPermission = get(session, "permission_mode", "build");
  const rawKernel = get(session, "mode", "build");
  const permissionMode = isPermissionMode(rawPermission) ? rawPermission : "plan";
  const kernelMode = typeof rawKernel === "string" && MODES.has(rawKernel) ? rawKernel : "plan";
  return [permissionMode, kernelMode];
}

/** A plan ceiling wins over a node that opted into writes. */
export function workflowChildWritable(nodeWritable: unknown, permissionMode: string | null, kernelMode: string | null): boolean {
  if (permissionMode === "plan" || kernelMode === "plan") return false;
  return pyTruthy(nodeWritable);
}

/** Command nodes bypass Gate, so a plan owner refuses them outright. */
export function workflowCommandAllowed(permissionMode: string | null, kernelMode: string | null): boolean {
  if (permissionMode === null && kernelMode === null) return true;
  return permissionMode !== "plan" && kernelMode !== "plan";
}

/** `store.log(wid, node)['output'][-3000:]`. */
function logTail(store: WorkflowStore, wid: string, node: string): string {
  let output = "";
  try { output = store.log(wid, node).output; } catch { output = ""; }
  const points = Array.from(output);
  return points.length <= DEPENDENCY_OUTPUT_CHARS ? output : points.slice(-DEPENDENCY_OUTPUT_CHARS).join("");
}

/**
 * `'Dependency results (untrusted):\n' + json.dumps(dependencies, ensure_ascii=False)`
 * truncated to 12 000 characters; `null` when the node has no dependencies.
 */
export function dependencyContext(store: WorkflowStore, wid: string, spec: Row): string | null {
  const needs = Array.isArray(spec.needs) ? (spec.needs as string[]) : [];
  if (!needs.length) return null;
  const current = store.load(wid);
  const nodes = isDict(current.nodes) ? current.nodes : {};
  const dependencies: Row[] = needs.map((parent) => {
    const state = isDict(nodes[parent]) ? (nodes[parent] as Row) : {};
    return { node: parent, summary: get(state, "summary", ""), output: logTail(store, wid, parent) };
  });
  const body = "Dependency results (untrusted):\n" + pyJsonDumps(dependencies, { ensureAscii: false });
  return pySlice(body, DEPENDENCY_CHARS);
}

/** A thrown provider failure that reports congestion, for the governor's backoff. */
function congestionOf(error: unknown): { congestion: boolean; retryAfter: number | null } {
  const failure = error as { name?: unknown; status?: unknown; retryAfter?: unknown } | null;
  const congested = failure?.name === "ProviderRequestError" && (failure.status === 429 || failure.status === 503);
  if (!congested) return { congestion: false, retryAfter: null };
  return { congestion: true, retryAfter: typeof failure.retryAfter === "number" ? failure.retryAfter : null };
}

/** `s.get('steps', 0)` from the actor transcript this run appends to. */
function startingSteps(store: WorkflowStore, wid: string, sid: string): number {
  const session = readJournal(join(store.directory, wid + "-sessions"), sid);
  const steps = session === null ? 0 : numericValue(get(session, "steps", 0));
  return steps === null ? 0 : steps;
}

/**
 * Wait for a provider slot. Returns the row to answer with when the wait was
 * abandoned, or null once the ticket is held (the caller must `finish` it).
 */
async function acquireSlot(
  store: WorkflowStore, wid: string, control: RunControl, host: AgentNodeHost,
  bucketKey: string, ticket: string, timeout: number,
): Promise<Row | null> {
  const governor = new ProviderGovernor(store.state);
  governor.enqueue(bucketKey, wid, ticket);
  const waitStart = nowSeconds();
  while (!governor.tryAcquire(bucketKey, ticket)) {
    if (store.load(wid).control === "cancel" || control.ownerGone()) {
      governor.cancel(bucketKey, ticket);
      return { status: "cancelled" };
    }
    if (!host.enabled("workflows") || !host.enabled("providers")) {
      governor.cancel(bucketKey, ticket);
      return { status: "paused", error: "workflow or provider plugin disabled" };
    }
    if (nowSeconds() - waitStart >= timeout) {
      governor.cancel(bucketKey, ticket);
      return { status: "failed", error: "provider slot wait timed out" };
    }
    await pause(SLOT_POLL_MS);
  }
  return null;
}

/** Python's status mapping for a finished actor run. */
function resultRow(result: Row, sessionId: string): Row {
  if (result.status === "awaiting_user") {
    const question = get(result, "pending_question", "");
    return { status: "awaiting_user", question: pySlice(typeof question === "string" ? question : "", 2000), summary: "", session_id: sessionId };
  }
  const completion = isDict(result.completion) ? result.completion : {};
  const summary = get(completion, "summary", "");
  const status = result.status === "completed" ? "completed"
    : result.status === "stopped" ? "cancelled"
      : result.status === "paused" ? "paused" : "failed";
  return { status, summary: pySlice(typeof summary === "string" ? summary : "", 4000), session_id: sessionId };
}

/**
 * Run one agent node. The plan ceiling is applied before anything else, the
 * actor transcript is opened through the host, and the slot wait ends on
 * cancel, owner loss, a disabled plugin or the node timeout.
 */
export async function executeAgentNode(
  store: WorkflowStore, record: Row, spec: Row, control: RunControl, host: AgentNodeHost,
): Promise<Row> {
  const wid = String(record.id), nid = String(spec.id);
  const [permissionMode, kernelMode] = ownerPermissionCeiling(store, record);
  if (spec.kind === "command" && !workflowCommandAllowed(permissionMode, kernelMode)) {
    return { status: "failed", error: "command denied in plan mode" };
  }
  if (spec.kind !== "agent") throw new PyValueError("kind must be command or agent");
  const root = String(record.root);
  const cwd = resolvePath(join(root, String(get(spec, "cwd", "."))));
  const nodes = store.load(wid).nodes;
  const node = isDict(nodes) && isDict(nodes[nid]) ? (nodes[nid] as Row) : {};
  const recorded = get(node, "session_id", null);
  const existing = typeof recorded === "string" && recorded ? recorded : null;
  const prompt = String(get(spec, "prompt", ""));
  const sessions = join(store.directory, wid + "-sessions");
  const sessionId = await host.ensureSession(prompt, cwd, existing, sessions);
  if (existing === null) store.update(wid, (row) => { ((row.nodes as Record<string, Row>)[nid] as Row).session_id = sessionId; });
  if (!host.enabled("workflows")) return { status: "paused", error: "workflows plugin disabled", session_id: sessionId };
  if (!host.enabled("providers")) return { status: "paused", error: "providers plugin disabled", session_id: sessionId };

  const timeout = Number(numericValue(get(spec, "timeout", 300)) ?? 300);
  const providerId = typeof spec.provider_id === "string" && spec.provider_id ? spec.provider_id : null;
  const model = typeof spec.model === "string" && spec.model ? spec.model : null;
  // Python resolves the provider here, before the context; a bad profile fails the node.
  const bucketKey = host.bucket ? host.bucket(providerId, model) : (providerId ?? "default") + ":" + String(model ?? "default");
  const context = dependencyContext(store, wid, spec);
  const writable = workflowChildWritable(get(spec, "writable", false), permissionMode, kernelMode);
  const ticket = uuid4Hex();
  const startStep = startingSteps(store, wid, sessionId);

  const abandoned = await acquireSlot(store, wid, control, host, bucketKey, ticket, timeout);
  if (abandoned !== null) return { ...abandoned, session_id: sessionId };

  const governor = new ProviderGovernor(store.state);
  let result: Row;
  try {
    result = await host.run({
      prompt, root, sessionId, writable, providerId, model, context, timeoutSeconds: timeout, sessions,
      shouldStop: () => control.ownerGone() || store.load(wid).control === "cancel" || !host.enabled("workflows"),
    });
  } catch (error) {
    const { congestion, retryAfter } = congestionOf(error);
    governor.finish(bucketKey, ticket, null, { congestion, retryAfter });
    throw error;
  }
  const steps = numericValue(get(result, "steps", 0));
  governor.finish(bucketKey, ticket, steps !== null && steps > startStep ? true : null);
  return resultRow(result, sessionId);
}
