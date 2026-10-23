/**
 * What a delegation leaves behind, in Python's layout so the sessions
 * projection, the sidepane and a later Python run read it unchanged:
 * the durable child at `<state>/subagent-sessions/<parent>/<child>.json`
 * (Python `child_sessions.ChildStore`), and the parent's `task_runs` row
 * (Python `TaskRegistry.record` / `finish` + `recovery_info`).
 */
import { mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { isDict, pyLen, pySlice, uuid4Hex } from "@xueness/contracts";
import { isLink } from "@xueness/sessions";
import type { Row } from "./definitions.ts";

export const SUBAGENT_MAX_STEPS = 4;
export const SUBAGENT_MAX_WALL_SECONDS = 120;
export const SUBAGENT_SUMMARY_MAX = 4000;
export const ERROR_MAX = 500;
export const PROMPT_MAX = 24000;
export const MAX_CHILD_SESSIONS = 100;
export const MAX_TASK_RUNS = 100;
const SID = /^[0-9a-f]{32}$/;
export const TASK_ID = /^task-[A-Za-z0-9_-]{1,160}$/;

export const newTaskId = (): string => "task-" + uuid4Hex();
export const validParent = (parent: unknown): parent is string => typeof parent === "string" && SID.test(parent);

/** Python `child_sessions._directory` (0700, one level at a time, links refused) plus `MAX_CHILD_SESSIONS`. */
export function ensureChildDirectory(stateDir: string, parent: string): string {
  if (!validParent(parent)) throw new Error("invalid parent session id");
  if (isLink(stateDir)) throw new Error("invalid child session directory");
  let current = resolve(stateDir);
  for (const name of ["subagent-sessions", parent]) {
    current = join(current, name);
    if (isLink(current)) throw new Error("invalid child session directory");
    try { mkdirSync(current, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  if (readdirSync(current).filter((name) => name.endsWith(".json")).length >= MAX_CHILD_SESSIONS) throw new Error("child session limit reached for parent");
  return current;
}

export interface ChildInput { parent: string; taskId: string; root: string; system: string; prompt: string; agent: string | null; selection: Row; rootSessionId?: string }
/** Python `run_subagent`'s child dict, with the durable `delegation` record. */
export function newChild(input: ChildInput, now = Date.now() / 1000): Row {
  return {
    id: uuid4Hex(), task: input.prompt, root: input.root, status: "pending",
    messages: [{ role: "system", content: input.system }, { role: "user", content: input.prompt }],
    results: {}, compactions: [], archived_messages: [], steps: 0, completion: null, todos: [], pending_question: null,
    read_only: true, permission_mode: "plan", mode: "plan", parent: input.parent,
    delegation: { taskId: input.taskId, parentSessionId: input.parent, rootSessionId: input.rootSessionId ?? input.parent, agent: input.agent,
      modelSelection: input.selection, createdAt: now, contextInherited: false, resumeCount: 0 },
    model_selection: input.selection,
  };
}

/** Python `child_sessions.recovery_info`. */
export function recoveryInfo(child: Row): { canResume: boolean; recoveryReason: string } {
  const status = child.status;
  if (status === "cancelled" || status === "stopped" || isDict(child.delegation) && child.delegation.cancelled === true) return { canResume: false, recoveryReason: "cancelled" };
  if (child.pending_question) return { canResume: false, recoveryReason: "waiting_for_user_answer" };
  const results = isDict(child.results) ? child.results : {};
  const messages = Array.isArray(child.messages) ? child.messages : [];
  const answered = new Set(messages.filter((row) => isDict(row) && row.role === "tool").map((row) => (row as Row).tool_call_id));
  for (const row of messages) {
    if (!isDict(row)) return { canResume: false, recoveryReason: "invalid_transcript" };
    for (const call of Array.isArray(row.tool_calls) ? row.tool_calls : []) {
      const cid = isDict(call) ? call.id : null;
      if (typeof cid !== "string" || !cid || !(cid in results) || !answered.has(cid)) return { canResume: false, recoveryReason: "unfinished_tool_exchange" };
    }
  }
  return { canResume: true, recoveryReason: status === "completed" || status === "needs_review" ? "followup_required" : "safe_boundary" };
}

/** Python `run_subagent`: the completion summary, else the last assistant text. */
export function childSummary(child: Row): string {
  if (isDict(child.completion) && typeof child.completion.summary === "string" && child.completion.summary) return child.completion.summary;
  const messages = Array.isArray(child.messages) ? child.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (isDict(message) && message.role === "assistant" && message.content) return typeof message.content === "string" ? message.content : JSON.stringify(message.content);
  }
  return "";
}

export interface TaskRun { id: string; parent: string; agent: string | null; promptChars: number; status: string; steps: number; startedAt: number; endedAt: number | null; summary: string; error: string; root: string; [key: string]: unknown }
export function startRun(id: string, parent: string, agent: string | null, prompt: string, root: string): TaskRun {
  return { id, parent, agent, promptChars: pyLen(prompt), status: "running", steps: 0, startedAt: Date.now() / 1000, endedAt: null, summary: "", error: "", root };
}
export function finishRun(run: TaskRun, outcome: { ok: boolean; cancelled?: boolean; summary?: string; error?: string; steps?: number }): TaskRun {
  run.status = outcome.cancelled ? "cancelled" : outcome.ok ? "completed" : "failed";
  run.endedAt = Date.now() / 1000;
  run.summary = pySlice(outcome.summary ?? "", SUBAGENT_SUMMARY_MAX);
  run.error = pySlice(outcome.error ?? "", ERROR_MAX);
  if (outcome.steps !== undefined) run.steps = outcome.steps;
  return run;
}
/** Python `save_session`: rows merged by id, the newest 100 kept. */
export function recordRun(session: Row, run: TaskRun): void {
  const rows = new Map<string, Row>();
  for (const row of Array.isArray(session.task_runs) ? session.task_runs : []) if (isDict(row) && "id" in row) rows.set(String(row.id), row);
  rows.set(run.id, { ...run });
  session.task_runs = [...rows.values()].slice(-MAX_TASK_RUNS);
}

/** ZCode `formatAgentOutputForModel` for a completed agent (no SendMessage here, so no continuation hint). */
export function agentOutputText(output: { agentId: string; text: string; toolUses: number; durationMs: number; totalTokens?: number }): string {
  const usage = [...output.totalTokens === undefined ? [] : [`subagent_tokens: ${output.totalTokens}`], `tool_uses: ${output.toolUses}`, `duration_ms: ${output.durationMs}`];
  return [output.text.trim().length > 0 ? output.text : "(Subagent completed but returned no output.)", `agentId: ${output.agentId}`, `<usage>${usage.join("\n")}</usage>`].join("\n");
}
