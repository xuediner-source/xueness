/**
 * Tool-call outcomes: how often tool calls fail, why, and what the failures
 * cost in time. The measurement that decides whether a preflight check or a
 * decision model would pay for itself.
 *
 * Every finished call is classified from its result's error code. Groups a
 * check before execution could prevent (arguments, edit mismatch, unknown
 * tool, path, command misuse, network) are "avoidable"; a command that ran
 * and exited non-zero (tests still failing), policy refusals and
 * interruptions are counted but are not model mistakes.
 *
 * Time is measured, not inferred from wall clocks: a failed call's own tool
 * time is exact, and so is a model request whose output could not be parsed
 * as a tool call (a protocol repair). The recovery time is an estimate: the
 * model request that follows a step with avoidable failures is attributed to
 * them in proportion to the step's failed calls, since that request has to
 * read the errors and try again.
 *
 * The aggregate lives on the session (`tool_outcomes`) as bounded counters,
 * so a long session keeps its totals; the usage plugin sums sessions.
 */
import { isDict, pySlice } from "@xueness/contracts";
import type { Row } from "@xueness/agent";

export const OUTCOME_GROUPS = ["arguments", "edit_mismatch", "unknown_tool", "path", "command", "network", "command_exit", "policy", "interrupted", "other"] as const;
export type OutcomeGroup = (typeof OUTCOME_GROUPS)[number];
export const AVOIDABLE_GROUPS: ReadonlySet<OutcomeGroup> = new Set(["arguments", "edit_mismatch", "unknown_tool", "path", "command", "network"]);

const EDIT_TOOLS = new Set(["edit", "apply_patch"]);
const POLICY = new Set(["approval_required", "denied", "user_denied", "permission_denied", "plan_mode_denied", "plugin_denied", "plugin_disabled", "tool_policy_unavailable"]);
const INTERRUPTED = new Set(["run_paused", "cancelled", "command_cancelled", "network_cancelled", "tool_timeout_cancelled"]);
const ARGUMENTS = new Set(["invalid_tool_arguments", "invalid_argument", "invalid_arguments", "schema_error"]);
const UNKNOWN = new Set(["unknown_tool", "not_deferred_tool", "tool_not_active"]);
const PATH = new Set(["not_found", "is_directory", "not_a_directory", "file_exists", "binary_file", "file_too_large", "outside_workspace"]);
const COMMAND = new Set(["command_failed", "command_not_found", "command_timeout", "command_prepare_failed", "shell_not_found", "shell_init_failed", "tool_timeout", "too_many_tasks"]);
const NETWORK = /^(network_|dns_|doh_|http_|redirect_|tls_|ssrf_|fakeip_)|^response_too_large$/u;
/**
 * A command that did not run as written: the shell could not parse it (PowerShell 5.1 has no
 * `&&`, for example) or could not find the program. Anything else with a non-zero exit ran and
 * reported failure, such as tests that still fail, which is information rather than a mistake.
 */
const SHELL_MISUSE = /ParserError|is not a valid statement separator|Unexpected token|Missing (?:closing|expression)|is not recognized as (?:the name of a cmdlet|an internal or external command)|CommandNotFoundException|A (?:positional )?parameter cannot be found that (?:matches parameter name|accepts argument)|ParameterBindingException|syntax error near unexpected token|: command not found|: not found\b/iu;
const NOT_RUN_EXIT = new Set([126, 127, 9009]);

const MAX_TOOLS = 60, MAX_CODES = 40, MAX_MODELS = 20;

export interface OutcomeBucket {
  calls: number; failed: number; avoidable: number;
  toolMs: number; failedToolMs: number; recoveryMs: number;
  protocolRepairs: number; protocolMs: number;
}
export interface ToolOutcomes {
  version: 1;
  updatedAt: string;
  total: OutcomeBucket;
  groups: Partial<Record<OutcomeGroup, { failed: number; failedToolMs: number; recoveryMs: number; avoidable: boolean }>>;
  tools: Record<string, { calls: number; failed: number }>;
  codes: Record<string, number>;
  models: Record<string, OutcomeBucket>;
}

const blank = (): OutcomeBucket => ({ calls: 0, failed: 0, avoidable: 0, toolMs: 0, failedToolMs: 0, recoveryMs: 0, protocolRepairs: 0, protocolMs: 0 });
const ms = (seconds: number): number => Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : 0;

/** The error code of a tool result, or null for a success. */
export function outcomeCode(result: Row): string | null {
  if (result.ok === true && !result.awaiting_approval && !(isDict(result.error) && result.error.code === "approval_required")) return null;
  if (result.awaiting_approval === true) return "approval_required";
  const error = result.error;
  const code = typeof result.error_code === "string" && result.error_code ? result.error_code
    : isDict(error) && typeof error.code === "string" && error.code ? error.code
    : error === "denied" ? "denied"
    : typeof error === "string" && error.startsWith("tool not active") ? "tool_not_active"
    : typeof error === "string" && error.startsWith("unknown tool") ? "unknown_tool"
    : typeof error === "string" && error.startsWith("not executed: run paused") ? "run_paused"
    : "unknown_error";
  return pySlice(code.replace(/[^a-z0-9_]/giu, "_").toLowerCase(), 48);
}

export function outcomeGroup(tool: string, code: string, result: Row = {}): OutcomeGroup {
  if (POLICY.has(code)) return "policy";
  if (INTERRUPTED.has(code)) return "interrupted";
  if (EDIT_TOOLS.has(tool) && (code === "not_found" || code === "ambiguous_match" || code === "no_change")) return "edit_mismatch";
  if (ARGUMENTS.has(code)) return "arguments";
  if (UNKNOWN.has(code)) return "unknown_tool";
  if (PATH.has(code)) return "path";
  if (code === "command_failed") {
    const exit = isDict(result.data) ? result.data.exitCode : undefined;
    const text = `${typeof result.output === "string" ? result.output.slice(0, 4000) : ""}\n${isDict(result.error) && typeof result.error.message === "string" ? result.error.message.slice(0, 1000) : ""}`;
    return typeof exit === "number" && NOT_RUN_EXIT.has(exit) || SHELL_MISUSE.test(text) ? "command" : "command_exit";
  }
  if (COMMAND.has(code)) return "command";
  if (NETWORK.test(code)) return "network";
  return "other";
}

function read(session: Row): ToolOutcomes {
  const value = session.tool_outcomes;
  if (isDict(value) && value.version === 1 && isDict(value.total)) return value as unknown as ToolOutcomes;
  const fresh: ToolOutcomes = { version: 1, updatedAt: new Date().toISOString(), total: blank(), groups: {}, tools: {}, codes: {}, models: {} };
  session.tool_outcomes = fresh;
  return fresh;
}

/** A bounded map entry: new keys beyond the cap share one overflow slot. */
function slot<T>(map: Record<string, T>, key: string, cap: number, make: () => T): T {
  const name = Object.hasOwn(map, key) || Object.keys(map).length < cap ? key : "(other)";
  map[name] ??= make();
  return map[name]!;
}

/**
 * Per-run recorder. `tool` is called as each call finishes; `request` as each
 * model response arrives, which settles the recovery share of the step before.
 */
export class ToolOutcomeRecorder {
  #step = { calls: 0, avoidable: [] as OutcomeGroup[] };

  tool(session: Row, model: string, name: string, result: Row, seconds: number): void {
    const outcomes = read(session), code = outcomeCode(result), spent = ms(seconds);
    const buckets = [outcomes.total, slot(outcomes.models, model || "(unknown model)", MAX_MODELS, blank)];
    const tool = slot(outcomes.tools, pySlice(name, 80), MAX_TOOLS, () => ({ calls: 0, failed: 0 }));
    tool.calls += 1;
    for (const bucket of buckets) { bucket.calls += 1; bucket.toolMs += spent; }
    this.#step.calls += 1;
    if (code !== null) {
      const group = outcomeGroup(name, code, result);
      tool.failed += 1;
      const key = Object.hasOwn(outcomes.codes, code) || Object.keys(outcomes.codes).length < MAX_CODES ? code : "(other)";
      outcomes.codes[key] = (outcomes.codes[key] ?? 0) + 1;
      const share = (outcomes.groups[group] ??= { failed: 0, failedToolMs: 0, recoveryMs: 0, avoidable: AVOIDABLE_GROUPS.has(group) });
      share.failed += 1; share.failedToolMs += spent;
      for (const bucket of buckets) { bucket.failed += 1; bucket.failedToolMs += spent; if (AVOIDABLE_GROUPS.has(group)) bucket.avoidable += 1; }
      if (AVOIDABLE_GROUPS.has(group)) this.#step.avoidable.push(group);
    }
    outcomes.updatedAt = new Date().toISOString();
  }

  /** A model response arrived after `seconds`; `protocolError` when its tool call could not be parsed. */
  request(session: Row, model: string, seconds: number, protocolError: boolean): void {
    const step = this.#step, spent = ms(seconds);
    this.#step = { calls: 0, avoidable: [] };
    if (!spent || !step.avoidable.length && !protocolError) return;
    const outcomes = read(session), buckets = [outcomes.total, slot(outcomes.models, model || "(unknown model)", MAX_MODELS, blank)];
    if (step.avoidable.length && step.calls) {
      const each = spent / step.calls;
      for (const group of step.avoidable) { const share = (outcomes.groups[group] ??= { failed: 0, failedToolMs: 0, recoveryMs: 0, avoidable: AVOIDABLE_GROUPS.has(group) }); share.recoveryMs += Math.round(each); }
      for (const bucket of buckets) bucket.recoveryMs += Math.round(each * step.avoidable.length);
    }
    if (protocolError) for (const bucket of buckets) { bucket.protocolRepairs += 1; bucket.protocolMs += spent; }
    outcomes.updatedAt = new Date().toISOString();
  }
}
