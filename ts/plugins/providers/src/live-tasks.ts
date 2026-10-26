/**
 * F14.02 representative live-model task scenarios.
 *
 * Runs the five representative scenarios (edit, long task, concurrent
 * subagents, workflow, MCP) against ONE fixed model/config and records what
 * actually happened per scenario. Two invariants are enforced structurally:
 *
 *  1. No paid model call happens without an explicit cost authorization
 *     (authorizedBy + grantRef); without one every scenario is recorded as
 *     `blocked` and the call port is never invoked.
 *  2. Records are raw per-scenario outcomes with traces; summaries carry
 *     category counts only — sample counts never masquerade as success
 *     rates (validators reject rate/coverage fields outright).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const LIVE_TASKS_SCHEMA = "xueness.live-tasks.v1";

export const LIVE_TASK_SCENARIOS = ["edit", "long_task", "concurrent_subagents", "workflow", "mcp"] as const;
export type LiveTaskScenario = (typeof LIVE_TASK_SCENARIOS)[number];

export type LiveTaskStatus = "completed" | "failed" | "blocked";

/** Cost authorization a user granted explicitly for this batch, or its absence. */
export type CostAuthorization =
  | { authorized: true; authorizedBy: string; grantRef: string; note?: string }
  | { authorized: false };

export interface ModelCallUsage {
  inputTokens: number;
  outputTokens: number;
  /** Raw cost as billed; omit when the provider does not report it. */
  cost?: { currency: string; amount: number };
}

/** Outcome of one model invocation; unknown values are omitted, never faked. */
export interface ModelCallOutcome {
  ok: boolean;
  outputText?: string;
  error?: string;
  usage?: ModelCallUsage;
}

/** Transport-agnostic port the runner drives; production wires the providers runtime here. */
export type ModelCallPort = (input: {
  scenario: LiveTaskScenario;
  /** Distinguishes concurrent-subagent children and workflow steps. */
  lane: string;
  prompt: string;
  signal?: AbortSignal;
}) => Promise<ModelCallOutcome>;

export interface LiveTaskSpec {
  scenario: LiveTaskScenario;
  prompt: string;
  /** Concurrent subagents fan-out; defaults to 1. */
  subagents?: number;
  /** Workflow/MCP multi-step count; defaults to 1. */
  steps?: number;
}

export interface LiveTaskEvent {
  at: string;
  type: "scenario_started" | "model_call_started" | "model_call_completed" | "model_call_failed" | "scenario_finished";
  lane: string;
  detail?: string;
}

export interface LiveTaskRecord {
  schema: typeof LIVE_TASKS_SCHEMA;
  scenario: LiveTaskScenario;
  status: LiveTaskStatus;
  /** Single model id shared by every scenario in the batch. */
  model: string;
  /** Stable fingerprint of the shared config (e.g. JSON digest). */
  configFingerprint: string;
  events: readonly LiveTaskEvent[];
  usage?: ModelCallUsage;
  error?: string;
  /** Required for blocked: why nothing ran. */
  blocker?: string;
  startedAt: string;
  finishedAt: string;
}

export interface LiveTaskBatch {
  schema: typeof LIVE_TASKS_SCHEMA;
  round: string;
  model: string;
  configFingerprint: string;
  authorization: { authorized: boolean; authorizedBy?: string; grantRef?: string; note?: string };
  records: readonly LiveTaskRecord[];
  /** Category counts only; rate fields are rejected by validation. */
  summary: { completed: number; failed: number; blocked: number };
  recordedAt: string;
}

export class LiveTasksError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`invalid live task batch: ${problems.join("; ")}`);
    this.name = "LiveTasksError";
    this.problems = problems;
  }
}

export interface RunLiveTasksOptions {
  round: string;
  model: string;
  configFingerprint: string;
  authorization: CostAuthorization;
  tasks: readonly LiveTaskSpec[];
  callModel: ModelCallPort;
  now?: () => Date;
  signal?: AbortSignal;
}

function emptyUsage(usage?: ModelCallUsage): ModelCallUsage | undefined {
  return usage ? { ...usage } : undefined;
}

function addUsage(total: ModelCallUsage | undefined, add?: ModelCallUsage): ModelCallUsage | undefined {
  if (!add) return total;
  const base = total ?? { inputTokens: 0, outputTokens: 0 };
  const merged: ModelCallUsage = { inputTokens: base.inputTokens + add.inputTokens, outputTokens: base.outputTokens + add.outputTokens };
  if (base.cost && add.cost) {
    // Summing across currencies would invent a number; keep the cost only when both sides agree.
    if (base.cost.currency === add.cost.currency) {
      merged.cost = { currency: base.cost.currency, amount: base.cost.amount + add.cost.amount };
    }
  } else if (base.cost ?? add.cost) {
    merged.cost = { ...(base.cost ?? add.cost)! };
  }
  return merged;
}

async function runScenario(
  spec: LiveTaskSpec,
  options: RunLiveTasksOptions,
  clock: () => Date,
): Promise<LiveTaskRecord> {
  const startedAt = clock().toISOString();
  const events: LiveTaskEvent[] = [{ at: clock().toISOString(), type: "scenario_started", lane: "main", detail: spec.scenario }];
  const lanes: string[] =
    spec.scenario === "concurrent_subagents"
      ? Array.from({ length: Math.max(1, spec.subagents ?? 1) }, (_, i) => `subagent-${i + 1}`)
      : spec.scenario === "workflow" || spec.scenario === "mcp"
        ? Array.from({ length: Math.max(1, spec.steps ?? 1) }, (_, i) => `step-${i + 1}`)
        : ["main"];
  const base = { schema: LIVE_TASKS_SCHEMA, scenario: spec.scenario, model: options.model, configFingerprint: options.configFingerprint, startedAt } as const;
  if (options.signal?.aborted) {
    return { ...base, status: "blocked", events: [...events, { at: clock().toISOString(), type: "scenario_finished", lane: "main", detail: "aborted before start" }], blocker: "aborted before start", finishedAt: clock().toISOString() };
  }
  const outcomes = await Promise.all(
    lanes.map(async (lane) => {
      events.push({ at: clock().toISOString(), type: "model_call_started", lane });
      try {
        const outcome = await options.callModel({ scenario: spec.scenario, lane, prompt: spec.prompt, signal: options.signal });
        events.push({ at: clock().toISOString(), type: outcome.ok ? "model_call_completed" : "model_call_failed", lane, detail: outcome.ok ? (outcome.outputText ?? "").slice(0, 200) : outcome.error });
        return outcome;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        events.push({ at: clock().toISOString(), type: "model_call_failed", lane, detail });
        return { ok: false, error: detail } as ModelCallOutcome;
      }
    }),
  );
  let usage: ModelCallUsage | undefined;
  for (const outcome of outcomes) usage = addUsage(usage, outcome.usage);
  const failed = outcomes.filter((outcome) => !outcome.ok);
  const finishedAt = clock().toISOString();
  events.push({ at: finishedAt, type: "scenario_finished", lane: "main", detail: failed.length === 0 ? "all lanes ok" : `${failed.length} lane(s) failed` });
  return {
    ...base,
    status: failed.length === 0 ? "completed" : "failed",
    events,
    usage: emptyUsage(usage),
    error: failed.length === 0 ? undefined : failed.map((outcome) => outcome.error ?? "unknown error").join("; ").slice(0, 500),
    finishedAt,
  };
}

/**
 * Runs the representative scenarios under one shared model/config. Without a
 * cost authorization nothing is invoked and every task is recorded blocked.
 */
export async function runLiveTasks(options: RunLiveTasksOptions): Promise<LiveTaskBatch> {
  const clock = options.now ?? (() => new Date());
  const known = new Set<string>(LIVE_TASK_SCENARIOS);
  for (const spec of options.tasks) {
    if (!known.has(spec.scenario)) throw new LiveTasksError([`unknown scenario ${JSON.stringify(spec.scenario)}`]);
  }
  let records: LiveTaskRecord[];
  const authorization = options.authorization ?? { authorized: false };
  if (authorization.authorized !== true) {
    records = options.tasks.map((spec) => {
      const at = clock().toISOString();
      return {
        schema: LIVE_TASKS_SCHEMA, scenario: spec.scenario, status: "blocked",
        model: options.model, configFingerprint: options.configFingerprint,
        events: [{ at, type: "scenario_started", lane: "main", detail: spec.scenario }, { at, type: "scenario_finished", lane: "main", detail: "no cost authorization" }],
        blocker: "no cost authorization for paid models; nothing executed", startedAt: at, finishedAt: at,
      };
    });
  } else {
    records = [];
    for (const spec of options.tasks) records.push(await runScenario(spec, options, clock));
  }
  const batch: LiveTaskBatch = {
    schema: LIVE_TASKS_SCHEMA,
    round: options.round,
    model: options.model,
    configFingerprint: options.configFingerprint,
    authorization: authorization.authorized
      ? { authorized: true, authorizedBy: authorization.authorizedBy, grantRef: authorization.grantRef, ...(authorization.note ? { note: authorization.note } : {}) }
      : { authorized: false },
    records,
    summary: {
      completed: records.filter((record) => record.status === "completed").length,
      failed: records.filter((record) => record.status === "failed").length,
      blocked: records.filter((record) => record.status === "blocked").length,
    },
    recordedAt: clock().toISOString(),
  };
  const problems = validateLiveTaskBatch(batch);
  if (problems.length > 0) throw new LiveTasksError(problems);
  return batch;
}

const RATE_FIELD = /rate|coverage|percent|success/i;

/** Structural validation for a batch (also applied on file load). */
export function validateLiveTaskBatch(value: unknown): string[] {
  const problems: string[] = [];
  if (typeof value !== "object" || value === null) return ["not an object"];
  const batch = value as Record<string, unknown>;
  if (batch.schema !== LIVE_TASKS_SCHEMA) problems.push(`schema must be ${LIVE_TASKS_SCHEMA}`);
  for (const key of Object.keys(batch)) {
    if (RATE_FIELD.test(key)) problems.push(`aggregate-rate field ${key} is not allowed`);
  }
  if (typeof batch.model !== "string" || batch.model.length === 0) problems.push("model is required (one shared model per batch)");
  if (typeof batch.configFingerprint !== "string" || batch.configFingerprint.length === 0) problems.push("configFingerprint is required");
  const auth = batch.authorization as Record<string, unknown> | undefined;
  if (!auth || typeof auth !== "object" || typeof auth.authorized !== "boolean") {
    problems.push("authorization.authorized (boolean) is required");
  } else if (auth.authorized && (typeof auth.authorizedBy !== "string" || !auth.authorizedBy || typeof auth.grantRef !== "string" || !auth.grantRef)) {
    problems.push("an authorized batch must record authorizedBy and grantRef");
  }
  if (!Array.isArray(batch.records)) return [...problems, "records must be an array"];
  if (batch.records.length === 0) problems.push("a batch must record at least one scenario outcome");
  for (const [index, raw] of (batch.records as unknown[]).entries()) {
    const where = `records[${index}]`;
    if (typeof raw !== "object" || raw === null) { problems.push(`${where}: not an object`); continue; }
    const record = raw as Record<string, unknown>;
    if (!(LIVE_TASK_SCENARIOS as readonly string[]).includes(record.scenario as string)) problems.push(`${where}: unknown scenario ${JSON.stringify(record.scenario)}`);
    if (record.status !== "completed" && record.status !== "failed" && record.status !== "blocked") problems.push(`${where}: status must be completed/failed/blocked`);
    if (record.status === "blocked" && (typeof record.blocker !== "string" || !record.blocker)) problems.push(`${where}: blocked requires a blocker`);
    if ((record.status === "completed" || record.status === "failed") && auth?.authorized !== true) {
      problems.push(`${where}: ${record.status} without cost authorization is invalid`);
    }
    if (record.model !== batch.model) problems.push(`${where}: model ${JSON.stringify(record.model)} differs from batch model`);
    if (record.configFingerprint !== batch.configFingerprint) problems.push(`${where}: config fingerprint differs from the batch`);
    if (!Array.isArray(record.events) || record.events.length === 0) problems.push(`${where}: a trace with at least one event is required`);
    for (const key of Object.keys(record)) {
      if (RATE_FIELD.test(key)) problems.push(`${where}: aggregate-rate field ${key} is not allowed`);
    }
  }
  // Counts must match the records themselves, so a tampered file cannot inflate `completed`.
  const summary = batch.summary as Record<string, unknown> | undefined;
  if (!summary || typeof summary !== "object") {
    problems.push("summary with category counts is required");
  } else {
    for (const status of ["completed", "failed", "blocked"] as const) {
      const actual = (batch.records as Array<Record<string, unknown>>).filter((record) => record?.status === status).length;
      if (typeof summary[status] !== "number") problems.push(`summary.${status} must be a count`);
      else if (summary[status] !== actual) problems.push(`summary.${status} is ${summary[status]} but ${actual} record(s) have that status`);
    }
  }
  return problems;
}

/** Persists a batch under `<stateDir>/live-tasks/`, refusing invalid ones. */
export function saveLiveTaskBatch(batch: LiveTaskBatch, stateDir: string): string {
  const problems = validateLiveTaskBatch(batch);
  if (problems.length > 0) throw new LiveTasksError(problems);
  const directory = join(stateDir, "live-tasks");
  mkdirSync(directory, { recursive: true });
  const file = join(directory, `${batch.recordedAt.slice(0, 10)}-${batch.round}.json`);
  writeFileSync(file, `${JSON.stringify(batch, null, 2)}\n`);
  return file;
}

/** Loads and validates a batch file; invalid files throw instead of loading. */
export function loadLiveTaskBatch(path: string): LiveTaskBatch {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new LiveTasksError([`unreadable or invalid JSON: ${(error as Error).message}`]);
  }
  const problems = validateLiveTaskBatch(parsed);
  if (problems.length > 0) throw new LiveTasksError(problems);
  return parsed as LiveTaskBatch;
}
