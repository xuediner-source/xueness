import { wrapSystemReminderForSource, type AgentContext, type AgentExtension } from "@xueness/agent";
import type { BackgroundTaskInfo, BackgroundTasks, TaskState } from "@xueness/engine-tools";
import type { ShellRuntimeBinding } from "./index.ts";

const MAX_BACKGROUND_TASKS = 32;
const TASK_NOTICE_SOURCE = "task_status" as const;

export interface BackgroundTaskSummary {
  id: string;
  state: TaskState | "lost";
  reason?: "runtime_unavailable";
  exitCode: number | null;
  outputOpen: boolean;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutPath: string;
  stderrPath: string;
  durationMs: number;
}

const SUMMARY_STATES = new Set<string>(["running", "exited", "killed", "timed_out", "failed", "lost"]);
const SUMMARY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const nonnegativeInteger = (value: unknown): number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;

function storedSummary(value: unknown): BackgroundTaskSummary | null {
  if (!isRecord(value) || typeof value.id !== "string" || !SUMMARY_ID.test(value.id) || typeof value.state !== "string" || !SUMMARY_STATES.has(value.state)) return null;
  const state = value.state as BackgroundTaskSummary["state"];
  const exitCode = value.exitCode === null ? null : typeof value.exitCode === "number" && Number.isSafeInteger(value.exitCode) ? value.exitCode : null;
  const summary: BackgroundTaskSummary = {
    id: value.id, state, exitCode, outputOpen: state === "lost" ? false : typeof value.outputOpen === "boolean" ? value.outputOpen : false,
    stdoutBytes: nonnegativeInteger(value.stdoutBytes), stderrBytes: nonnegativeInteger(value.stderrBytes),
    stdoutPath: typeof value.stdoutPath === "string" ? value.stdoutPath : "", stderrPath: typeof value.stderrPath === "string" ? value.stderrPath : "",
    durationMs: typeof value.durationMs === "number" && Number.isFinite(value.durationMs) && value.durationMs >= 0 ? value.durationMs : 0,
  };
  if (state === "lost") { summary.exitCode = null; summary.outputOpen = false; summary.reason = "runtime_unavailable"; }
  return summary;
}

function mergeSummaries(current: readonly BackgroundTaskSummary[], previous: unknown, currentIds: ReadonlySet<string>): BackgroundTaskSummary[] {
  const merged: BackgroundTaskSummary[] = [], seen = new Set<string>();
  for (const task of current) if (!seen.has(task.id) && merged.length < MAX_BACKGROUND_TASKS) { merged.push(task); seen.add(task.id); }
  if (!Array.isArray(previous)) return merged;
  for (const value of previous) {
    if (merged.length >= MAX_BACKGROUND_TASKS) break;
    const task = storedSummary(value);
    if (!task || seen.has(task.id) || currentIds.has(task.id)) continue;
    if (task.state === "running") { task.state = "lost"; task.exitCode = null; task.outputOpen = false; task.reason = "runtime_unavailable"; }
    else if (task.state === "lost") { task.exitCode = null; task.outputOpen = false; task.reason = "runtime_unavailable"; }
    merged.push(task); seen.add(task.id);
  }
  return merged;
}

function sameSummaries(previous: unknown, next: readonly BackgroundTaskSummary[]): boolean {
  if (!Array.isArray(previous) || previous.length !== next.length) return false;
  return previous.every((value, index) => {
    if (!isRecord(value)) return false;
    const expected = next[index] as unknown as Record<string, unknown>;
    const keys = Object.keys(expected);
    return Object.keys(value).length === keys.length && keys.every((key) => value[key] === expected[key]);
  });
}

/** A bounded, output-free snapshot for the session journal and tests. */
export function summarizeBackgroundTasks(tasks: readonly BackgroundTaskInfo[], sessionId: string): BackgroundTaskSummary[] {
  return tasks.filter((task) => task.owner === sessionId).slice(0, MAX_BACKGROUND_TASKS).map((task) => ({
    id: task.id,
    state: task.state,
    exitCode: task.exitCode,
    outputOpen: task.outputOpen,
    stdoutBytes: task.stdout.bytes,
    stderrBytes: task.stderr.bytes,
    stdoutPath: task.stdout.path,
    stderrPath: task.stderr.path,
    durationMs: task.durationMs,
  }));
}

function noticeKeys(messages: unknown): Set<string> {
  if (!Array.isArray(messages)) return new Set();
  return new Set(messages.flatMap((message) => {
    if (!message || typeof message !== "object" || Array.isArray(message)) return [];
    const key = (message as Record<string, unknown>)._background_task_notice;
    return typeof key === "string" ? [key] : [];
  }));
}

function noticeContent(task: BackgroundTaskSummary): string {
  if (task.state === "lost") return `Background task ${task.id} is unavailable because its runtime is no longer available. Its result is unknown and it will not be rerun automatically.`;
  const exitCode = task.exitCode === null ? "" : `; exit code ${task.exitCode}`;
  return `Background task ${task.id} reached terminal state ${task.state}${exitCode}. Use TaskOutput with task ID ${task.id} to read its output.`;
}

async function refresh(context: AgentContext, binding: ShellRuntimeBinding): Promise<boolean> {
  const tasks: BackgroundTasks | undefined = binding.tasks;
  const session = context.session as Record<string, unknown>;
  const sessionId = typeof session.id === "string" ? session.id : null;
  if (!tasks || !sessionId) return false;

  const listed = tasks.list(sessionId);
  const owned = listed.filter((task) => task.owner === sessionId);
  const currentIds = new Set(owned.map((task) => task.id));
  const previousFacts = session.background_tasks;
  const hadFacts = Object.hasOwn(session, "background_tasks");
  const summaries = mergeSummaries(summarizeBackgroundTasks(owned, sessionId), previousFacts, currentIds);
  const factsChanged = hadFacts ? !sameSummaries(previousFacts, summaries) : summaries.length > 0;
  const previousMessages = session.messages;
  const messages = Array.isArray(previousMessages) ? previousMessages as Record<string, unknown>[] : [];
  const originalLength = messages.length;
  const seen = new Set([...noticeKeys(session.messages), ...noticeKeys(session.archived_messages)]);
  const addedKeys: string[] = [];

  if (summaries.length || hadFacts) session.background_tasks = summaries;
  for (const task of summaries) {
    if (task.state === "running") continue;
    const key = `${task.id}:${task.state}`;
    if (seen.has(key)) continue;
    seen.add(key);
    messages.push({
      role: "user",
      content: wrapSystemReminderForSource(TASK_NOTICE_SOURCE, noticeContent(task)),
      _input_kind: "background_notice",
      _background_task_notice: key,
      _meta_source: TASK_NOTICE_SOURCE,
    });
    addedKeys.push(key);
  }

  if (!factsChanged && !addedKeys.length) return false;
  if (addedKeys.length) session.messages = messages;
  try {
    await context.save();
    return addedKeys.length > 0;
  } catch (error) {
    messages.splice(originalLength);
    if (Array.isArray(previousMessages)) session.messages = previousMessages;
    else if (previousMessages === undefined) delete session.messages;
    else session.messages = previousMessages;
    if (hadFacts) session.background_tasks = previousFacts;
    else delete session.background_tasks;
    throw error;
  }
}

/** Shell-owned task snapshots and durable terminal notices; task output remains unread. */
export function shellBackgroundExtension(binding: ShellRuntimeBinding): AgentExtension {
  return {
    id: "shell",
    capabilities: ["shell.background_notifications"],
    async beforeModelRequest(context) { await refresh(context, binding); },
    async beforeFinalResponse(context, _response) { return refresh(context, binding); },
  };
}
