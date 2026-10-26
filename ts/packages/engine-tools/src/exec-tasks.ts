/**
 * The background side of exec. `exec` with `background: true` starts a task
 * and returns its id at once; `exec_output` returns what a task wrote since
 * the last read (optionally waiting for it to finish), or lists the tasks;
 * `exec_kill` stops a task's whole process tree. Tasks are only visible to
 * the session (ToolEnv owner) that started them.
 */
import { BackgroundTaskError, type BackgroundTaskInfo, type BackgroundTasks, type StartTaskOptions, type TaskRead } from "./background.ts";
import { cleanTerminalText } from "./output-capture.ts";
import { failure, type ToolDefinition, type ToolEnv, type ToolResult } from "./tool.ts";

export const EXEC_BACKGROUND_DEFAULT_TIMEOUT_MS = 30 * 60_000;
export const EXEC_BACKGROUND_MAX_TIMEOUT_MS = 24 * 60 * 60_000;
export const EXEC_OUTPUT_MAX_WAIT_MS = 600_000;

const TASK_ID = { type: "string", pattern: "^bg_[0-9a-f]{8}$", description: "Task id returned by exec with background: true." } as const;

function duration(ms: number): string {
  if (ms >= 3_600_000 && ms % 3_600_000 === 0) return `${ms / 3_600_000} h`;
  if (ms >= 60_000) return `${Math.round(ms / 6000) / 10} min`;
  return `${Math.round(ms / 100) / 10}s`;
}

export function describeTask(info: BackgroundTaskInfo): string {
  const elapsed = duration(info.durationMs);
  switch (info.state) {
    case "running":
      return `running for ${elapsed} (pid ${info.pid})${info.adopted ? "; moved to the background at its foreground timeout" : ""}`;
    case "exited":
      return `exited with code ${info.exitCode}${info.signal ? ` (${info.signal})` : ""} after ${elapsed}`;
    case "killed":
      return `killed after ${elapsed}`;
    case "timed_out":
      return `timed out after ${duration(info.timeoutMs)}; the process tree was killed`;
    case "failed":
      return `failed to start: ${info.error?.message ?? "unknown error"}`;
  }
}

export function renderTaskRead(read: TaskRead): string {
  const { info } = read;
  const parts = [`task ${info.id} (${info.command}): ${describeTask(info)}`];
  const stdout = cleanTerminalText(read.stdout.text).replace(/\n+$/, "");
  const stderr = cleanTerminalText(read.stderr.text).replace(/\n+$/, "");
  if (stdout) parts.push(stdout);
  if (stderr) parts.push(`[stderr]\n${stderr}`);
  if (!stdout && !stderr) parts.push("(no new output)");
  for (const name of ["stdout", "stderr"] as const) {
    if (read[name].truncated) parts.push(`[${name}: ${read[name].bytes} new bytes, middle omitted; full output: ${info[name].path}]`);
    const dropped = info[name].bytes - info[name].logged;
    if (dropped > 0) parts.push(`[${name}: log file is capped; the last ${dropped} bytes were not saved]`);
  }
  if (info.state !== "running" && info.outputOpen) parts.push("[processes it started still hold its output open; exec_kill stops them]");
  return parts.join("\n");
}

function taskFailure(error: unknown): ToolResult<never> {
  if (error instanceof BackgroundTaskError) return failure(error.code, error.message);
  throw error;
}

/** Start `request` as a background task of `env.owner`. */
export async function startBackgroundTask(tasks: BackgroundTasks | undefined, request: Omit<StartTaskOptions, "owner">, env: ToolEnv): Promise<ToolResult<BackgroundTaskInfo>> {
  if (!tasks) return failure("unsupported", "background tasks are not available here");
  let info: BackgroundTaskInfo;
  try {
    info = await tasks.start({ ...request, owner: env.owner ?? null });
  } catch (error) {
    return taskFailure(error);
  }
  if (info.state === "failed") {
    const code = info.error?.code ?? "spawn_failed";
    const message = code === "command_not_found" ? `command not found: ${request.file}` : `could not start ${request.file}: ${info.error?.message}`;
    return { ok: false, output: message, data: info, error: { code, message } };
  }
  // ZCode bash-model-content formatBackgroundInfoForModel, minus the completion
  // notification Xueness does not send yet: the model polls with TaskOutput.
  const output = `Command running in background with ID: ${info.id}. Output is being written to: ${info.stdout.path} (stderr: ${info.stderr.path}). `
    + `It is stopped after ${duration(info.timeoutMs)}. Check it with TaskOutput (task_id "${info.id}"), stop it with TaskStop. To check interim output, use Read on that file path.`;
  return { ok: true, output, data: info };
}

export interface ExecOutputInput {
  task_id?: string;
  wait_ms?: number;
}

export function createExecOutputTool(tasks: BackgroundTasks): ToolDefinition<ExecOutputInput, TaskRead | BackgroundTaskInfo[]> {
  return {
    name: "exec_output",
    gate: "planning",
    mutating: false,
    concurrencySafe: false,
    requires: {},
    description: [
      "Read what a background exec task wrote since the last read, with its state and exit code.",
      `wait_ms first waits up to that long (max ${EXEC_OUTPUT_MAX_WAIT_MS / 1000}s) for the task to finish.`,
      "Without task_id, list this session's background tasks.",
    ].join(" "),
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { task_id: TASK_ID, wait_ms: { type: "integer", minimum: 0, maximum: EXEC_OUTPUT_MAX_WAIT_MS } },
    },
    subject: (input) => input.task_id ?? "list",
    subjectKind: "text",
    async run(input, env) {
      const owner = env.owner ?? null;
      if (input.task_id === undefined) {
        const list = tasks.list(owner);
        const output = list.length ? list.map((info) => `${info.id}  ${describeTask(info)}  ${info.command}`).join("\n") : "no background tasks";
        return { ok: true, output, data: list };
      }
      try {
        const read = await tasks.read(input.task_id, { owner, waitMs: input.wait_ms ?? 0, ...(env.signal ? { signal: env.signal } : {}) });
        return { ok: true, output: renderTaskRead(read), data: read };
      } catch (error) {
        return taskFailure(error);
      }
    },
  };
}

export function createExecKillTool(tasks: BackgroundTasks): ToolDefinition<{ task_id: string }, TaskRead> {
  return {
    name: "exec_kill",
    gate: "exec",
    mutating: true,
    concurrencySafe: false,
    requires: {},
    description: "Stop a background exec task and every process it started; returns the output it wrote since the last read.",
    inputSchema: { type: "object", additionalProperties: false, required: ["task_id"], properties: { task_id: TASK_ID } },
    subject: (input) => input.task_id,
    subjectKind: "text",
    async run(input, env) {
      try {
        const read = await tasks.kill(input.task_id, env.owner ?? null);
        return { ok: true, output: renderTaskRead(read), data: read };
      } catch (error) {
        return taskFailure(error);
      }
    },
  };
}
