/**
 * exec: run a command in the workspace.
 *
 * `command` runs through a shell (bash/sh on POSIX, PowerShell on Windows);
 * `argv` runs an executable directly, as the Python tool did. The result
 * always comes back to the model: a missing command, a non-zero exit, a
 * timeout or a cancel are results with stable codes, never a run-ending
 * exception. stdout and stderr stay separate; long output keeps its head and
 * tail and the full text is saved under the artifacts directory.
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { BackgroundTaskInfo, BackgroundTasks } from "./background.ts";
import { EXEC_BACKGROUND_DEFAULT_TIMEOUT_MS, EXEC_BACKGROUND_MAX_TIMEOUT_MS, startBackgroundTask } from "./exec-tasks.ts";
import { cleanTerminalText } from "./output-capture.ts";
import { resolveWorkspacePath } from "./paths.ts";
import { runProcess, type ProcessResult } from "./process.ts";
import { failure, statOrNull, type ToolDefinition, type ToolEnv, type ToolResult } from "./tool.ts";
import { persistedOutputEnvelope } from "./zcode-text.ts";

export const EXEC_DEFAULT_TIMEOUT_MS = 120_000;
export const EXEC_MAX_TIMEOUT_MS = 600_000;
export const EXEC_MAX_CAPTURE_BYTES = 24 * 1024;
/** Environment variables that look like credentials are not passed to commands. */
export const SECRET_ENV_PATTERN = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i;

export interface ExecInput {
  command?: string;
  argv?: string[];
  cwd?: string;
  timeout_ms?: number;
  description?: string;
  background?: boolean;
}

export interface ExecStreamInfo {
  bytes: number;
  truncated: boolean;
  fullOutputPath?: string;
}

export interface ExecData {
  command: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
  stdout: ExecStreamInfo;
  stderr: ExecStreamInfo;
}

export interface PreparedExecInvocation {
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Set only for a cmd.exe batch-file bridge whose arguments need exact Windows quoting. */
  windowsVerbatimArguments?: boolean;
}

export interface ExecOptions {
  /** Shell prefix for `command`, e.g. ["/bin/bash", "-c"]. */
  shell?: readonly string[];
  defaultTimeoutMs?: number;
  maxCaptureBytes?: number;
  /** Drop credential-looking variables from the child environment (default true). */
  scrubEnv?: boolean;
  /** Variable names to pass even when they look like credentials. */
  passEnv?: readonly string[];
  /** Runs `background: true` calls; without it they are refused. */
  tasks?: BackgroundTasks;
  backgroundTimeoutMs?: number;
  /** Prepare a validated invocation after Gate authorization and before either spawn path. */
  prepareInvocation?(input: ExecInput, env: ToolEnv, base: { argv: string[]; cwd: string; env: NodeJS.ProcessEnv }): Promise<PreparedExecInvocation>;
}

export function defaultShell(): string[] {
  if (process.platform === "win32") return ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command"];
  return existsSync("/bin/bash") ? ["/bin/bash", "-c"] : ["/bin/sh", "-c"];
}

export function commandEnv(base: NodeJS.ProcessEnv, options: ExecOptions = {}): NodeJS.ProcessEnv {
  const pass = new Set(options.passEnv ?? []);
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if ((options.scrubEnv ?? true) && SECRET_ENV_PATTERN.test(name) && !pass.has(name)) continue;
    env[name] = value;
  }
  delete env.FORCE_COLOR;
  return { ...env, GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", PAGER: "cat", GIT_EDITOR: "true", NO_COLOR: "1" };
}

function streamInfo(captured: ProcessResult["stdout"]): ExecStreamInfo {
  return { bytes: captured.totalBytes, truncated: captured.truncated, ...(captured.fullOutputPath ? { fullOutputPath: captured.fullOutputPath } : {}) };
}

/**
 * Model text in the shape of ZCode v3.15.1 (aac4755, Apache-2.0)
 * `core/src/tool/handlers/bash-model-content.ts`: stdout (leading blank lines
 * dropped, trailing space trimmed), then stderr; `Exit code N` first on a real
 * failure; an aborted command gets the `<error>` line; truncated output goes
 * into a `<persisted-output>` envelope pointing at the full log.
 */
function render(result: ProcessResult, command: string): string {
  const stdout = cleanTerminalText(result.stdout.text).replace(/^(\s*\n)+/, "").trimEnd();
  let stderr = cleanTerminalText(result.stderr.text).trim();
  if (result.timedOut || result.cancelled) stderr = `${stderr ? `${stderr}\n` : ""}<error>Command was aborted before completion</error>`;
  const envelope = (text: string, captured: ProcessResult["stdout"]): string => captured.truncated && captured.fullOutputPath
    ? persistedOutputEnvelope(text, bashByteSize(captured.totalBytes), captured.fullOutputPath, 2_000, "2KB")
    : text;
  const failed = !result.timedOut && !result.cancelled && result.exitCode !== 0 && result.exitCode !== null && !semanticNonErrorExit(command, result.exitCode);
  return [
    failed ? `Exit code ${result.exitCode}` : "",
    envelope(stdout, result.stdout),
    envelope(stderr, result.stderr),
    result.signal && !result.timedOut && !result.cancelled ? `Command exited due to signal ${result.signal}` : "",
  ].filter(Boolean).join("\n");
}

/** ZCode formatBashOutputByteSize. */
export function bashByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 bytes";
  const trim = (value: number): string => value.toFixed(1).replace(/\.0$/, "");
  const kb = bytes / 1024;
  if (kb < 1) return `${bytes} bytes`;
  if (kb < 1024) return `${trim(kb)}KB`;
  const mb = kb / 1024;
  return mb < 1024 ? `${trim(mb)}MB` : `${trim(mb / 1024)}GB`;
}

/** ZCode bash-semantics semanticNonErrorExit: exit 1 of the last command that only means "no". */
export function semanticNonErrorExit(command: string, exitCode: number): string | undefined {
  if (exitCode !== 1) return undefined;
  const last = command.split(/&&|\|\||[;|\n]/).map((part) => part.trim()).filter(Boolean).at(-1);
  const words = (last ?? "").split(/\s+/).filter((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
  let name = (words[0] ?? "").replace(/^.*\//, "");
  if (name === "git") name = words.slice(1).find((word) => !word.startsWith("-")) ?? "";
  if (["egrep", "fgrep", "grep", "rg"].includes(name)) return "No matches found";
  if (name === "find") return "Some directories were inaccessible";
  if (name === "diff") return "Files differ";
  if (name === "test" || name === "[") return "Condition is false";
  return undefined;
}

function commandNotFound(result: ProcessResult): boolean {
  return (result.exitCode === 127 && /not found|not recognized|No such file/i.test(result.stderr.text))
    || (process.platform === "win32" && result.exitCode !== 0 && /(?:CommandNotFoundException|ObjectNotFound[^\r\n]*CommandNotFoundException)/.test(result.stderr.text));
}

/** Shell-quote one word for display and for permission rules. */
export function shellQuote(word: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`;
}

/** What the call runs, as one line: the shell command, or the argv words quoted. */
export function execSubject(input: Pick<ExecInput, "command" | "argv">): string {
  return input.command ?? (input.argv ?? []).map(shellQuote).join(" ");
}

export function createExecTool(options: ExecOptions = {}): ToolDefinition<ExecInput, ExecData | BackgroundTaskInfo> {
  return {
    name: "exec",
    gate: "exec",
    mutating: true,
    concurrencySafe: false,
    // Any program, plus the artifacts directory for full output (outside the workspace).
    requires: { exec: ["*"], fs: { write: ["workspace", "state"] } },
    description: [
      "Run a command in the workspace and return its stdout, stderr and exit code.",
      process.platform === "win32" ? "`command` runs in PowerShell." : "`command` runs in bash (or sh).",
      "`argv` runs one executable directly without a shell. Give exactly one of them.",
      `Timeout defaults to ${EXEC_DEFAULT_TIMEOUT_MS / 1000}s (max ${EXEC_MAX_TIMEOUT_MS / 1000}s); the whole process tree is killed on timeout.`,
      "Long output keeps its beginning and end; the full output is saved to a file whose path is shown. stdin is closed.",
      "With background: true the command keeps running and a task id comes back at once (servers, watchers, long builds);",
      `read it with exec_output, stop it with exec_kill. A background task's timeout defaults to ${EXEC_BACKGROUND_DEFAULT_TIMEOUT_MS / 60_000} min (max ${EXEC_BACKGROUND_MAX_TIMEOUT_MS / 3_600_000} h).`,
    ].join(" "),
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        command: { type: "string", minLength: 1, maxLength: 100_000 },
        argv: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
        cwd: { type: "string", minLength: 1, description: "Working directory, relative to the workspace." },
        timeout_ms: { type: "integer", minimum: 1, maximum: EXEC_BACKGROUND_MAX_TIMEOUT_MS, description: `At most ${EXEC_MAX_TIMEOUT_MS} unless background is true.` },
        description: { type: "string", maxLength: 200, description: "Short description shown to the user." },
        background: { type: "boolean", description: "Start the command as a background task and return its id at once." },
      },
    },
    subject: execSubject,
    subjectKind: "command",
    async run(input, env): Promise<ToolResult<ExecData | BackgroundTaskInfo>> {
      if ((input.command === undefined) === (input.argv === undefined)) {
        return failure("invalid_argument", "give exactly one of command or argv");
      }
      if (!input.background && (input.timeout_ms ?? 0) > EXEC_MAX_TIMEOUT_MS) {
        return failure("invalid_argument", `timeout_ms above ${EXEC_MAX_TIMEOUT_MS} needs background: true`);
      }
      const cwd = await resolveWorkspacePath(input.cwd ?? ".", env.cwd, env.roots);
      const cwdInfo = await statOrNull(cwd.absolute);
      if (!cwdInfo?.isDirectory()) return failure("not_a_directory", `working directory not found: ${cwd.display}`);
      const shell = options.shell ?? defaultShell();
      const baseArgv = input.argv ?? [...shell, input.command as string];
      let invocation: PreparedExecInvocation = { argv: baseArgv, cwd: cwd.absolute, env: commandEnv(process.env, options) };
      if (options.prepareInvocation) {
        try {
          invocation = await options.prepareInvocation(input, env, invocation);
          if (!Array.isArray(invocation.argv) || invocation.argv.length === 0 || typeof invocation.argv[0] !== "string" || !invocation.argv[0]) {
            return failure("invalid_argument", "prepared command must include an executable");
          }
        } catch (error) {
          const code = (error as { code?: unknown } | null)?.code;
          const errorCode = typeof code === "string" && /^[a-z_]+$/.test(code) ? code : "command_prepare_failed";
          const message = error instanceof Error ? error.message : String(error);
          return failure(errorCode, message);
        }
      }
      const file = invocation.argv[0] as string;
      const args = invocation.argv.slice(1);
      const display = execSubject(input);
      if (input.background) {
        const logDir = join(env.artifactsDir, "tasks");
        await mkdir(logDir, { recursive: true, mode: 0o700 });
        const timeoutMs = input.timeout_ms ?? options.backgroundTimeoutMs ?? EXEC_BACKGROUND_DEFAULT_TIMEOUT_MS;
        return startBackgroundTask(options.tasks, {
          file, args, cwd: invocation.cwd, cwdDisplay: cwd.display, env: invocation.env, command: display, timeoutMs, logDir,
          ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
        }, env);
      }
      const timeoutMs = input.timeout_ms ?? options.defaultTimeoutMs ?? EXEC_DEFAULT_TIMEOUT_MS;
      const spoolDir = join(env.artifactsDir, "exec");
      await mkdir(spoolDir, { recursive: true, mode: 0o700 });
      const stem = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(4).toString("hex")}`;
      const result = await runProcess({
        file, args, cwd: invocation.cwd, env: invocation.env, timeoutMs,
        maxCaptureBytes: options.maxCaptureBytes ?? EXEC_MAX_CAPTURE_BYTES,
        spool: { stdout: join(spoolDir, `${stem}.stdout.log`), stderr: join(spoolDir, `${stem}.stderr.log`) },
        ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
        ...(env.signal ? { signal: env.signal } : {}),
      });
      const data: ExecData = {
        command: display, exitCode: result.exitCode, signal: result.signal, timedOut: result.timedOut,
        cancelled: result.cancelled, durationMs: result.durationMs, stdout: streamInfo(result.stdout), stderr: streamInfo(result.stderr),
      };
      if (result.spawnError) {
        const missing = result.spawnError.code === "ENOENT";
        const message = missing ? `command not found: ${file}` : `could not start ${file}: ${result.spawnError.message}`;
        return { ok: false, output: message, data, error: { code: missing ? "command_not_found" : "spawn_failed", message } };
      }
      const output = render(result, display);
      if (result.timedOut) return { ok: false, output, data, error: { code: "command_timeout", message: `timed out after ${timeoutMs}ms` } };
      if (result.cancelled) return { ok: false, output, data, error: { code: "command_cancelled", message: "cancelled" } };
      if (result.exitCode !== 0) {
        const code = commandNotFound(result) ? "command_not_found" : "command_failed";
        return { ok: false, output, data, error: { code, message: result.signal ? `killed by ${result.signal}` : `exit code ${result.exitCode}` } };
      }
      return { ok: true, output, data };
    },
  };
}

export const execTool = createExecTool();
