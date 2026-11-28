/**
 * Deterministic, model-free preflight checks (`tool_judge.preflight`).
 *
 * Runs before approval prompts and tool execution even when no judge model is
 * chosen:
 *  1. Input JSON Schema validation (and exec command/argv exclusivity)
 *  2. Workspace-scoped path existence checks (fails open outside workspace)
 *  3. File freshness / unread checks before `edit` and overwriting `write`
 *  4. `edit` `old_string` match checks (`no_change`, `not_found`, `ambiguous_match`)
 *  5. Windows PowerShell 5.1 shell dialect mismatch detection
 *  6. `exec` executable availability on `PATH` / workspace (no subprocesses)
 *  7. Repeated failing call guard (rejects once per identical call until a mutating tool succeeds)
 */
import type { Stats } from "node:fs";
import { readFile } from "node:fs/promises";
import { isDict, formatSchemaIssues, validateSchema, type JsonSchema } from "@xueness/contracts";
import {
  FileStateTracker, PathOutsideWorkspaceError, StaleFileError, UnreadFileError, ambiguousMessage,
  decodeText, detectEncoding, locateEdit, looksBinary, missingFileMessage, resolveWorkspacePath, statOrNull, toLf,
} from "@xueness/engine-tools";
import { signature } from "./verdicts.ts";
import { checkProgramOnPath, checkShellDialect } from "./preflight-shell.ts";

type Row = Record<string, unknown>;

export type PreflightRule =
  | "schema"
  | "path"
  | "stale_read"
  | "edit_match"
  | "shell_dialect"
  | "path_program"
  | "repeated_failure";

export interface PreflightFailure {
  rule: PreflightRule;
  code: string;
  message: string;
  userReason: string;
}

export interface PreflightPorts {
  root(): string;
  tracker?: FileStateTracker;
  schemaOf?(name: string): Row | null;
  shell: "posix" | "powershell";
  env?: NodeJS.ProcessEnv;
  shellInitConfigured?: boolean;
}

const MAX_EDIT_CHECK_BYTES = 2 * 1024 * 1024;
const MUTATING_TOOLS = new Set(["write", "edit", "apply_patch", "exec"]);
const TRANSIENT_OR_POLICY_CODES = new Set([
  "approval_required", "denied", "user_denied", "permission_denied", "plan_mode_denied",
  "plugin_denied", "plugin_disabled", "tool_policy_unavailable", "run_paused", "cancelled",
  "command_cancelled", "network_cancelled", "tool_timeout", "tool_timeout_cancelled",
  "command_timeout", "judge_rejected", "repeated_failed_call",
]);

function fail(rule: PreflightRule, code: string, message: string, userReason: string): PreflightFailure {
  return { rule, code, message, userReason };
}

function isTransientOrPolicy(code: string | null): boolean {
  if (!code) return true;
  if (TRANSIENT_OR_POLICY_CODES.has(code)) return true;
  return /^(?:network_|dns_|doh_|http_|redirect_|tls_|ssrf_|fakeip_)/u.test(code);
}

function extractErrorCode(result: Row): string | null {
  if (result.ok === true && !result.awaiting_approval) return null;
  if (result.awaiting_approval === true) return "approval_required";
  if (typeof result.error_code === "string" && result.error_code) return result.error_code;
  if (isDict(result.error) && typeof result.error.code === "string" && result.error.code) return result.error.code;
  return "tool_failed";
}

interface SessionRepeatState {
  failed: Map<string, { code: string; warned: boolean }>;
  execCount: number;
}

/** Tracks identical failed calls per session; cleared as soon as any mutating tool succeeds. */
export class RepeatedFailureTracker {
  readonly #sessions = new WeakMap<object, SessionRepeatState>();

  #state(session: object): SessionRepeatState {
    let entry = this.#sessions.get(session);
    if (!entry) {
      entry = { failed: new Map(), execCount: 0 };
      this.#sessions.set(session, entry);
    }
    return entry;
  }

  execCount(session: object): number {
    return this.#sessions.get(session)?.execCount ?? 0;
  }

  check(session: object, name: string, input: Row): PreflightFailure | null {
    const state = this.#sessions.get(session);
    if (!state) return null;
    const sig = signature(name, input);
    const entry = state.failed.get(sig);
    if (!entry || entry.warned) return null;
    entry.warned = true;
    return fail(
      "repeated_failure",
      "repeated_failed_call",
      `This exact '${name}' call already failed (${entry.code}) and no file edit or command has succeeded since. Change your approach or inspect the error; calling it unchanged once more will allow it to run.`,
      "前置检查拦截一次：刚失败过的完全相同调用尚未有状态变更，修改方案或再次原样调用以放行。",
    );
  }

  recordFinished(session: object, call: { name: string; input?: unknown }, result: Row, gateOf: (name: string) => string | null): void {
    const state = this.#state(session);
    const input = isDict(call.input) ? call.input : null;
    if (result.preflight === true || !input) return;
    const gate = gateOf(call.name);
    if (result.ok === true) {
      if (call.name === "exec" || gate === "exec") state.execCount += 1;
      if (MUTATING_TOOLS.has(call.name) || (gate !== null && ["write", "edit", "exec", "mcp"].includes(gate))) {
        state.failed.clear();
      } else {
        state.failed.delete(signature(call.name, input));
      }
      return;
    }
    const code = extractErrorCode(result);
    if (isTransientOrPolicy(code)) return;
    if (state.failed.size >= 100) {
      const oldest = state.failed.keys().next().value;
      if (oldest !== undefined) state.failed.delete(oldest);
    }
    state.failed.set(signature(call.name, input), { code: code!, warned: false });
  }
}

export function checkInputSchema(name: string, input: Row, schema: Row | null): PreflightFailure | null {
  if (name === "exec" && (input.command === undefined) === (input.argv === undefined)) {
    return fail(
      "schema",
      "invalid_tool_arguments",
      "Invalid arguments for exec: provide exactly one of 'command' or 'argv'.",
      "前置检查拦截：exec 必须且只能提供 command 或 argv 之一。",
    );
  }
  if (!schema || !isDict(schema)) return null;
  if (Array.isArray((schema as Record<string, unknown>).oneOf)) return null;
  const issues = validateSchema(schema as JsonSchema, input);
  if (!issues.length) return null;
  const props = isDict(schema.properties) ? Object.keys(schema.properties) : [];
  const hint = schema.additionalProperties === false && props.length ? ` Allowed keys: ${props.join(", ")}.` : "";
  return fail(
    "schema",
    "invalid_tool_arguments",
    `Invalid arguments for ${name}: ${formatSchemaIssues(issues)}.${hint}`,
    `前置检查拦截：工具「${name}」参数不符合 Schema。`,
  );
}

async function resolveInsideWorkspace(rawPath: string, root: string): Promise<{ absolute: string; display: string } | null> {
  try {
    return await resolveWorkspacePath(rawPath, root, [root]);
  } catch (error) {
    if (error instanceof PathOutsideWorkspaceError) return null;
    return null;
  }
}

async function checkFileTools(
  name: string,
  input: Row,
  preflight: PreflightPorts,
  session: object,
  repeated: RepeatedFailureTracker,
): Promise<PreflightFailure | null> {
  const rawPath = typeof input.path === "string" ? input.path.trim() : "";
  if (name === "edit") {
    const oldStr = input.old_string;
    const newStr = input.new_string;
    if (typeof oldStr === "string" && typeof newStr === "string" && oldStr === newStr) {
      return fail("edit_match", "no_change", "No changes to make: old_string and new_string are identical.", "前置检查拦截：old_string 与 new_string 完全相同。");
    }
  }
  if (!rawPath) return null;
  const root = preflight.root();
  const target = await resolveInsideWorkspace(rawPath, root);
  if (!target) return null;
  const info: Stats | null = await statOrNull(target.absolute);

  if (name === "read" || name === "grep") {
    if (!info) return fail("path", "not_found", await missingFileMessage(target.absolute, root), `前置检查拦截：找不到路径「${target.display}」。`);
    if (name === "read" && info.isDirectory()) return fail("path", "is_directory", `Path is a directory: ${target.display}`, `前置检查拦截：「${target.display}」是目录，请用 list 或 glob。`);
    return null;
  }
  if (name === "list" || name === "glob") {
    if (!info) return fail("path", "not_found", await missingFileMessage(target.absolute, root), `前置检查拦截：找不到目录「${target.display}」。`);
    if (!info.isDirectory()) return fail("path", "not_a_directory", `Path is not a directory: ${target.display}`, `前置检查拦截：「${target.display}」不是目录。`);
    return null;
  }
  if (name !== "write" && name !== "edit") return null;
  if (info?.isDirectory()) return fail("path", "is_directory", `Path is a directory: ${target.display}`, `前置检查拦截：「${target.display}」是目录。`);

  const oldString = name === "edit" && typeof input.old_string === "string" ? input.old_string : null;
  if (name === "edit" && !info) {
    if (oldString === "") return null; // empty old_string creates a new file
    return fail("path", "not_found", await missingFileMessage(target.absolute, root), `前置检查拦截：要编辑的文件「${target.display}」不存在。`);
  }
  if (!info) return null; // write to a new file creates it and parent dirs

  if (preflight.tracker) {
    try {
      const allowPartial = name === "edit" && oldString !== "";
      await preflight.tracker.assertFresh(target.absolute, target.display, { allowPartial });
    } catch (error) {
      if (error instanceof UnreadFileError) {
        return fail("stale_read", "read_required", error.message, `前置检查拦截：修改「${target.display}」前需要先用 read 读取。`);
      }
      if (error instanceof StaleFileError) {
        const execHint = repeated.execCount(session) > 0 ? " A prior exec command in this session may have modified it." : "";
        return fail("stale_read", "stale_file", `${error.message}${execHint}`, `前置检查拦截：「${target.display}」自上次读取后已被修改，请先重新 read。`);
      }
      throw error;
    }
  }

  if (name === "edit" && oldString !== null && oldString !== "" && info.size <= MAX_EDIT_CHECK_BYTES) {
    const bytes = await readFile(target.absolute);
    const encoding = decodeText(bytes, detectEncoding(bytes));
    if (encoding.encoding === "utf-8" && looksBinary(bytes)) return null;
    const match = locateEdit(toLf(encoding.text), toLf(oldString), toLf(typeof input.new_string === "string" ? input.new_string : ""), input.replace_all === true);
    if (match.status === "not_found") {
      return fail("edit_match", "not_found", `String to replace not found in ${target.display}. Read exact lines before retrying edit.`, `前置检查拦截：未在「${target.display}」中找到 old_string。`);
    }
    if (match.status === "ambiguous") {
      return fail("edit_match", "ambiguous_match", ambiguousMessage(match.count, oldString), `前置检查拦截：「${target.display}」中有 ${match.count} 处匹配 old_string，需要更多上下文或 replace_all。`);
    }
  }
  return null;
}

/** Run all deterministic model-free preflight checks for one tool call. Returns null when ready to run. */
export async function runPreflight(
  session: object,
  call: { name: string; input?: unknown },
  options: { schemas?: Map<string, Row>; preflight?: PreflightPorts; repeated: RepeatedFailureTracker },
): Promise<PreflightFailure | null> {
  const input = isDict(call.input) ? call.input : null;
  if (!input) return null;
  const schema = options.preflight?.schemaOf?.(call.name) ?? options.schemas?.get(call.name) ?? null;
  const schemaFailure = checkInputSchema(call.name, input, schema);
  if (schemaFailure) return schemaFailure;

  if (options.preflight) {
    const fileFailure = await checkFileTools(call.name, input, options.preflight, session, options.repeated);
    if (fileFailure) return fileFailure;

    if (call.name === "exec") {
      if (typeof input.cwd === "string" && input.cwd.trim()) {
        const root = options.preflight.root();
        const cwd = await resolveInsideWorkspace(input.cwd.trim(), root);
        if (cwd) {
          const info = await statOrNull(cwd.absolute);
          if (!info || !info.isDirectory()) {
            return fail("path", "not_a_directory", `Working directory not found: ${cwd.display}`, `前置检查拦截：工作目录「${cwd.display}」不存在或不是目录。`);
          }
        }
      }
      if (typeof input.command === "string") {
        const dialectFailure = checkShellDialect(input.command, options.preflight.shell);
        if (dialectFailure) return dialectFailure;
      }
      const pathFailure = checkProgramOnPath(input, {
        shell: options.preflight.shell,
        root: options.preflight.root(),
        env: options.preflight.env ?? process.env,
        shellInitConfigured: options.preflight.shellInitConfigured,
      });
      if (pathFailure) return pathFailure;
    }
  }

  return options.repeated.check(session, call.name, input);
}
