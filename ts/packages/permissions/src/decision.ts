/**
 * Permission vocabulary: modes, Gate kinds, requests, decisions and settings.
 */
import { parseRule, specifierIssue, type SubjectKind } from "./rules.ts";

export const PERMISSION_MODES = ["build", "edit", "yolo", "plan", "guarded"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];
/** Kinds that never ask: Python lets every known kind outside APPROVAL_KINDS through. */
export const AUTO_ALLOWED_KINDS: readonly string[] = Object.freeze([
  "read", "list", "glob", "grep", "goal_read", "todo_read", "todo_write", "ask_user", "read_session_context", "read_state", "planning",
  "tool_search", "tool_result_read", "list_models",
]);
export const APPROVAL_KINDS: readonly string[] = Object.freeze(["write", "edit", "exec", "mcp", "web_fetch", "web_search"]);
/**
 * Leaving plan mode (ZCode ExitPlanMode, permission `plan.exit`): in plan mode the
 * user must approve the plan every time; outside it the call needs no approval and
 * the tool itself reports that there is no plan mode to leave.
 */
export const PLAN_EXIT_KIND = "plan_exit";
/** EnterPlanMode (ZCode): switching into the read-only plan mode never asks. */
export const PLAN_ENTER_KIND = "plan_enter";
export const KNOWN_KINDS: ReadonlySet<string> = new Set([...AUTO_ALLOWED_KINDS, ...APPROVAL_KINDS, PLAN_EXIT_KIND, PLAN_ENTER_KIND]);
export const EDIT_KINDS: ReadonlySet<string> = new Set(["write", "edit"]);
/** Gate kinds a host-owned directory admits (`PermissionSettings.hostWritable`). */
export const HOST_PATH_KINDS: ReadonlySet<string> = new Set(["read", ...EDIT_KINDS]);

export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === "string" && (PERMISSION_MODES as readonly string[]).includes(value);
}

/** The session's plan draft, the one file plan mode may write (contributed by the sessions plugin). */
export interface PlanDraftPolicy {
  readonly path: string;
  matches(subject: string): boolean;
  denial(kind: string): string;
}

export interface PermissionSettings {
  mode?: PermissionMode;
  allow?: readonly string[];
  deny?: readonly string[];
  ask?: readonly string[];
  /**
   * Rules that always ask, even when the command is read-only, an allow rule
   * matches, or the mode is yolo or plan. Optional; absent means no extra prompts.
   * Deny rules and `disallow` still win. A one-shot approval can pass the prompt.
   */
  alwaysAsk?: readonly string[];
  /** Tool names or Gate kinds refused for this run. */
  disallow?: readonly string[];
  /** Allow commands that only read without asking (default true). */
  readOnlyCommands?: boolean;
  /** The classifier knows POSIX shells only; under PowerShell every command asks unless a rule allows it. */
  shell?: "posix" | "powershell";
  planDraft?: PlanDraftPolicy | null;
  /**
   * Absolute real directories outside the workspace the host owns for this
   * session (the visualization directory): reads and file changes inside them
   * need no approval in any mode. `disallow` and deny rules still win.
   */
  hostWritable?: readonly string[];
  /** Plugin-owned finite danger matcher used only when mode is guarded. */
  guarded?: (request: PermissionRequest) => { ruleId: string; message: string } | null;
}

export interface PermissionRequest {
  tool: string;
  /** Gate kind. */
  kind: string;
  /** Workspace-relative path, command line, URL or other text the decision is about. */
  subject: string;
  subjectKind: SubjectKind;
  callId?: string;
}

export interface RememberOptions {
  /** Rules for exactly this call (one per command not yet allowed). */
  exact: string[];
  /** Wider rules: the same program and subcommand, the directory, the tool or the domain. */
  broad: string[];
}

export type AllowCode = "auto_allowed" | "read_only" | "allow_rule" | "session_rule" | "approved" | "mode" | "plan_draft" | "host_writable";
export type AskCode = "approval_required" | "ask_rule" | "always_ask" | "remote_exec" | "plan_exit" | "guarded";
export type DenyCode = "no_policy" | "disallowed" | "denied_by_rule" | "plan_mode";

export type PermissionDecision =
  | { behavior: "allow"; code: AllowCode; message: string; rule?: string }
  | { behavior: "ask"; code: AskCode; message: string; rule?: string; remember: RememberOptions | null }
  | { behavior: "deny"; code: DenyCode; message: string; rule?: string; planDraft?: string };

export interface PermissionAuditEntry {
  at: number;
  action: "granted" | "consumed" | "cleared" | "remembered" | "forgotten";
  kind?: string;
  callId?: string;
  subject?: string;
  rule?: string;
}

export interface PermissionGrant {
  callId: string;
  kind: string;
  subject: string;
}

export interface PermissionSnapshot {
  mode: PermissionMode;
  rules: string[];
  grants: PermissionGrant[];
}

/** Python's remote SSH subject: a JSON object with string `connection` and `connection_digest` and an `argv` list. */
export function isRemoteExecSubject(subject: string): boolean {
  if (typeof subject !== "string" || !subject) return false;
  try {
    const details = JSON.parse(subject) as Record<string, unknown> | null;
    return typeof details === "object" && details !== null && !Array.isArray(details)
      && typeof details.connection === "string" && typeof details.connection_digest === "string" && Array.isArray(details.argv);
  } catch {
    return false;
  }
}

/** Problems with permission settings, for validating configuration without throwing. */
export function permissionSettingsIssues(settings: PermissionSettings): string[] {
  const issues: string[] = [];
  if (settings.mode !== undefined && !isPermissionMode(settings.mode)) issues.push(`mode must be one of ${PERMISSION_MODES.join(", ")}`);
  if (settings.mode === "guarded" && typeof settings.guarded !== "function") issues.push("guarded mode requires a guarded permission callback");
  for (const list of ["allow", "deny", "ask", "alwaysAsk"] as const) {
    const texts = settings[list] ?? [];
    if (!Array.isArray(texts)) {
      issues.push(`${list} must be a list of rules`);
      continue;
    }
    texts.forEach((text, index) => {
      try {
        const rule = parseRule(text);
        const problem = rule.tool === "exec" ? specifierIssue(rule, "command") : null;
        if (problem) issues.push(`${list}[${index}] ${problem}`);
      } catch (error) {
        issues.push(`${list}[${index}] ${(error as Error).message}`);
      }
    });
  }
  if (settings.disallow !== undefined && (!Array.isArray(settings.disallow) || settings.disallow.some((item) => typeof item !== "string"))) issues.push("disallow must be a list of tool names or kinds");
  return issues;
}
