/**
 * SWE-bench harness task import and evaluation export (H04.01 / H04.02).
 *
 * SWE-bench tasks are distributed as JSONL: one JSON object per line with the
 * standard fields (`instance_id`, `repo`, `base_commit`, `patch`, `test_patch`,
 * `problem_statement`, `hints_text`, `created_at`, `version`, `FAIL_TO_PASS`,
 * `PASS_TO_PASS`, `environment_setup_commit`). Evaluations are reported back as
 * JSONL with one record per instance and a `resolved` flag.
 *
 *  - `importSweBenchTasks` (H04.01) parses a task JSONL document into validated
 *    `SweBenchTask` values. Blank lines and CRLF endings are tolerated, test
 *    list keys are matched case-insensitively (`FAIL_TO_PASS`/`fail_to_pass`),
 *    and every rejected line is reported with its 1-based line number instead
 *    of aborting the whole import;
 *  - `evaluateSweBenchRun` (H04.02) folds a raw run outcome (test id -> status)
 *    against one imported task: an instance resolves only when every
 *    FAIL_TO_PASS test passes and every PASS_TO_PASS test still passes. Tests
 *    missing from the outcome count as not passed;
 *  - `exportSweBenchEvaluations` serializes evaluation records to canonical
 *    JSONL via the deterministic serializer from prefix-cache, so equal inputs
 *    always export byte-identical lines.
 *
 * Pure computation only: no I/O, no clock, no randomness.
 */
import { canonicalJson } from "../prefix-cache.ts";

/** One imported SWE-bench patch task; field names follow the JSONL standard. */
export interface SweBenchTask {
  instanceId: string;
  repo: string;
  baseCommit: string;
  patch: string;
  testPatch: string;
  problemStatement: string;
  hintsText: string;
  createdAt: string;
  version: string;
  environmentSetupCommit: string;
  failToPass: readonly string[];
  passToPass: readonly string[];
}

/** A problem attached to one 1-based line of the imported JSONL document. */
export interface SweBenchImportIssue {
  line: number;
  message: string;
}

/** Result of importing a JSONL document: kept tasks plus per-line issues. */
export interface SweBenchImportResult {
  tasks: readonly SweBenchTask[];
  issues: readonly SweBenchImportIssue[];
}

/** Status of one test execution inside a run outcome. */
export type SweBenchTestStatus = "passed" | "failed" | "error" | "skipped";

/** Raw outcome of running a candidate patch against one task. */
export interface SweBenchRunOutcome {
  instanceId: string;
  /** Test id -> status; tests absent from this map count as not passed. */
  testResults: Readonly<Record<string, SweBenchTestStatus>>;
  /** Patch the candidate produced, kept verbatim for the report. */
  modelPatch: string;
  /** Free-form model identifier recorded in the exported record. */
  model: string;
}

/** One exported evaluation record (snake_case, as SWE-bench reports expect). */
export interface SweBenchEvaluation {
  instance_id: string;
  repo: string;
  base_commit: string;
  resolved: boolean;
  model: string;
  model_patch: string;
  fail_to_pass: Readonly<Record<string, SweBenchTestStatus>>;
  pass_to_pass: Readonly<Record<string, SweBenchTestStatus>>;
}

/** Aggregate metrics over a set of exported evaluation records. */
export interface SweBenchEvaluationSummary {
  total: number;
  resolved: number;
  unresolved: number;
  resolutionRate: number;
}

const REQUIRED_STRINGS: ReadonlyArray<{ key: string; field: keyof SweBenchTask }> = [
  { key: "instance_id", field: "instanceId" },
  { key: "repo", field: "repo" },
  { key: "base_commit", field: "baseCommit" },
  { key: "patch", field: "patch" },
];

const OPTIONAL_STRINGS: ReadonlyArray<{ key: string; field: keyof SweBenchTask }> = [
  { key: "test_patch", field: "testPatch" },
  { key: "problem_statement", field: "problemStatement" },
  { key: "hints_text", field: "hintsText" },
  { key: "created_at", field: "createdAt" },
  { key: "version", field: "version" },
  { key: "environment_setup_commit", field: "environmentSetupCommit" },
];

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readString = (record: Record<string, unknown>, key: string): string => {
  const value = record[key];
  return typeof value === "string" ? value : "";
};

const readTestList = (
  record: Record<string, unknown>,
  keys: readonly string[],
  line: number,
  issues: SweBenchImportIssue[],
): readonly string[] => {
  const present = keys.filter((key) => record[key] !== undefined && record[key] !== null);
  if (present.length === 0) return [];
  const key = present[0] as string;
  const value = record[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    issues.push({ line, message: `${key} must be an array of test id strings` });
    return [];
  }
  return [...(value as unknown[]) as string[]];
};

/** Parse one already-decoded JSONL record; returns null when it is invalid. */
function parseTaskRecord(value: unknown, line: number, issues: SweBenchImportIssue[]): SweBenchTask | null {
  if (!isPlainObject(value)) {
    issues.push({ line, message: "record must be a JSON object" });
    return null;
  }
  for (const { key } of REQUIRED_STRINGS) {
    if (typeof value[key] !== "string" || (value[key] as string).length === 0) {
      issues.push({ line, message: `required field ${key} must be a non-empty string` });
      return null;
    }
  }
  const task: SweBenchTask = {
    instanceId: readString(value, "instance_id"),
    repo: readString(value, "repo"),
    baseCommit: readString(value, "base_commit"),
    patch: readString(value, "patch"),
    testPatch: readString(value, "test_patch"),
    problemStatement: readString(value, "problem_statement"),
    hintsText: readString(value, "hints_text"),
    createdAt: readString(value, "created_at"),
    version: readString(value, "version"),
    environmentSetupCommit: readString(value, "environment_setup_commit"),
    failToPass: readTestList(value, ["fail_to_pass", "FAIL_TO_PASS"], line, issues),
    passToPass: readTestList(value, ["pass_to_pass", "PASS_TO_PASS"], line, issues),
  };
  return task;
}

/**
 * Import a standard SWE-bench JSONL patch-task document (H04.01).
 *
 * Lines are processed in order; malformed lines, non-object records and
 * duplicate instance ids are skipped and reported as issues carrying the
 * 1-based line number. Trailing whitespace, CRLF endings, empty lines and a
 * single trailing newline are all tolerated.
 */
export function importSweBenchTasks(jsonl: string): SweBenchImportResult {
  const tasks: SweBenchTask[] = [];
  const issues: SweBenchImportIssue[] = [];
  const seen = new Set<string>();
  const lines = jsonl.replaceAll("\r\n", "\n").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const text = lines[index] as string;
    if (text.trim().length === 0) continue;
    const line = index + 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      issues.push({ line, message: `invalid JSON: ${(error as Error).message}` });
      continue;
    }
    const task = parseTaskRecord(parsed, line, issues);
    if (!task) continue;
    if (seen.has(task.instanceId)) {
      issues.push({ line, message: `duplicate instance_id ${task.instanceId} skipped` });
      continue;
    }
    seen.add(task.instanceId);
    tasks.push(task);
  }
  return { tasks, issues };
}

const collectStatuses = (
  outcome: SweBenchRunOutcome,
  list: readonly string[],
): Record<string, SweBenchTestStatus> => {
  const statuses: Record<string, SweBenchTestStatus> = {};
  for (const test of list) statuses[test] = outcome.testResults[test] ?? "failed";
  return statuses;
};

/**
 * Evaluate one run outcome against its imported task (H04.02).
 *
 * The instance resolves only when every FAIL_TO_PASS test passes and no
 * PASS_TO_PASS test regressed. Tests without a recorded status are reported as
 * "failed" — an outcome that did not run a required test can never resolve.
 *
 * A task with no FAIL_TO_PASS test proves nothing: `every` would hold
 * vacuously, so such an instance is never reported as resolved. SWE-bench
 * derives the flag from the fail-to-pass set, and an unproven fix must not
 * count toward the resolution rate.
 */
export function evaluateSweBenchRun(task: SweBenchTask, outcome: SweBenchRunOutcome): SweBenchEvaluation {
  const hasGoal = task.failToPass.length > 0 && task.failToPass.every((test) => outcome.testResults[test] === "passed");
  const resolved = hasGoal && task.passToPass.every((test) => outcome.testResults[test] === "passed");
  return {
    instance_id: task.instanceId,
    repo: task.repo,
    base_commit: task.baseCommit,
    resolved,
    model: outcome.model,
    model_patch: outcome.modelPatch,
    fail_to_pass: collectStatuses(outcome, task.failToPass),
    pass_to_pass: collectStatuses(outcome, task.passToPass),
  };
}

/**
 * Export evaluation records as canonical JSONL (H04.02): one line per record,
 * deterministic bytes for equal inputs via the sorted-key serializer.
 */
export function exportSweBenchEvaluations(evaluations: readonly SweBenchEvaluation[]): string {
  return evaluations.map((record) => canonicalJson(record)).join("\n") + (evaluations.length ? "\n" : "");
}

/** Deterministic aggregate metrics over exported evaluation records. */
export function summarizeSweBenchEvaluations(evaluations: readonly SweBenchEvaluation[]): SweBenchEvaluationSummary {
  const total = evaluations.length;
  const resolved = evaluations.filter((record) => record.resolved).length;
  return { total, resolved, unresolved: total - resolved, resolutionRate: total === 0 ? 0 : resolved / total };
}
