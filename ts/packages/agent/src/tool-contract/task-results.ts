/**
 * TaskOutput / TaskStop model text from the Xueness exec_output / exec_kill
 * result data, in the shape of ZCode v3.15.1 (aac4755, Apache-2.0)
 * `core/src/tool/handlers/task-output.ts` (formatTaskOutputModelContent,
 * truncateTaskOutput) and `task-stop.ts` (formatTaskStopModelContent).
 *
 * Xueness returns the output written since the last read, not the whole log;
 * the log path is named when that chunk was cut.
 */
import { isDict } from "@xueness/contracts";

type Row = Record<string, unknown>;
const TASK_TYPE = "local_bash";

function status(info: Row): string {
  switch (info.state) {
    case "running": return "running";
    case "exited": return info.exitCode === 0 ? "completed" : "failed";
    case "killed": return "killed";
    default: return "failed";
  }
}

function chunk(read: Row, name: "stdout" | "stderr"): string {
  const part = isDict(read[name]) ? read[name] as Row : {};
  const info = isDict(read.info) && isDict((read.info as Row)[name]) ? (read.info as Row)[name] as Row : {};
  const text = typeof part.text === "string" ? part.text.trimEnd() : "";
  if (!text) return "";
  return part.truncated === true && typeof info.path === "string" ? `[Truncated. Full output: ${info.path}]\n\n${text}` : text;
}

/** `exec_output` data (a TaskRead) → ZCode TaskOutput text; undefined for other shapes (the task list). */
export function taskOutputText(data: unknown, input: Row | null): string | undefined {
  if (!isDict(data) || !isDict(data.info)) return undefined;
  const info = data.info as Row;
  const state = status(info);
  const waited = typeof input?.wait_ms === "number" && input.wait_ms > 0;
  const retrieval = state === "running" ? (waited ? "timeout" : "not_ready") : "success";
  const blocks = [`<retrieval_status>${retrieval}</retrieval_status>`, `<task_id>${String(info.id)}</task_id>`, `<task_type>${TASK_TYPE}</task_type>`, `<status>${state}</status>`];
  if (typeof info.exitCode === "number") blocks.push(`<exit_code>${info.exitCode}</exit_code>`);
  const output = [chunk(data, "stdout"), chunk(data, "stderr")].filter(Boolean).join("\n");
  if (output.trim()) blocks.push(`<output>\n${output}\n</output>`);
  if (info.state === "timed_out") blocks.push(`<error>Task timed out after ${Math.round(Number(info.timeoutMs) / 1000)}s and was stopped</error>`);
  else if (isDict(info.error) && typeof info.error.message === "string") blocks.push(`<error>${info.error.message}</error>`);
  return blocks.join("\n\n");
}

/** `exec_kill` data → ZCode TaskStop JSON. */
export function taskStopText(data: unknown): string | undefined {
  if (!isDict(data) || !isDict(data.info)) return undefined;
  const info = data.info as Row;
  const command = typeof info.command === "string" ? info.command : undefined;
  return JSON.stringify({ message: `Successfully stopped task: ${String(info.id)} (${command ?? TASK_TYPE})`, task_id: info.id, task_type: TASK_TYPE, ...(command ? { command } : {}) });
}

/** ZCode's text for a task id the registry does not know. */
export function unknownTaskText(input: Row | null): string | undefined {
  const id = input?.task_id;
  return typeof id === "string" ? `No task found with ID: ${id}` : undefined;
}

const TODO_STATUS: Readonly<Record<string, string>> = { pending: "pending", in_progress: "in_progress", done: "completed" };
function modelTodos(value: unknown): Row[] {
  return (Array.isArray(value) ? value : []).filter(isDict).map((todo) => ({
    content: String(todo.text ?? todo.content ?? ""), status: TODO_STATUS[String(todo.status)] ?? "pending", priority: typeof todo.priority === "string" ? todo.priority : "medium",
  }));
}

/** ZCode TodoRead output, serialized as JSON (ZCode has no formatter for it). */
export function todoReadText(data: unknown): string | undefined {
  return isDict(data) ? JSON.stringify({ todos: modelTodos(data.todos) }) : undefined;
}

/** ZCode TodoWrite output: old and new lists and the status summary, as JSON. */
export function todoWriteText(data: unknown): string | undefined {
  if (!isDict(data)) return undefined;
  const todos = modelTodos(data.todos);
  const count = (status: string): number => todos.filter((todo) => todo.status === status).length;
  return JSON.stringify({
    oldTodos: modelTodos(data.oldTodos), todos,
    summary: { total: todos.length, pending: count("pending"), inProgress: count("in_progress"), completed: count("completed") },
  });
}
