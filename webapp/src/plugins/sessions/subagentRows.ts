import type { TimelineRow } from "../../xuenessWorkbench";

export type SubagentRow = Extract<TimelineRow, { kind: "subagent" }>;
export type SubagentRowStatus = "running" | "completed" | "failed" | "cancelled" | "unknown";
const STATUSES = new Set(["running", "completed", "failed", "cancelled"]);
const TASK_ID = /^task-[A-Za-z0-9_-]{1,160}$/u;
const SESSION_ID = /^[0-9a-f]{32}$/u;

function plain(value: unknown, limit: number): string {
  return typeof value === "string" ? value.slice(0, limit).replace(/\p{C}/gu, " ").trim() : "";
}

/** Parent-snapshot step count. Not a work-item list and not a child transcript. */
function boundedSteps(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 64 ? value : undefined;
}

/** Saved progress is display data, never an executable task or a transcript. */
export function projectSubagentRows(rows: TimelineRow[], journal: unknown): TimelineRow[] {
  const raw = journal && typeof journal === "object" && !Array.isArray(journal)
    ? (journal as Record<string, unknown>).message_subagents : undefined;
  const entries = new Map<string, Omit<SubagentRow, "kind" | "seq" | "turnId">>();
  const ambiguous = new Set<string>();
  if (Array.isArray(raw)) for (const value of raw.slice(0, 32)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const item = value as Record<string, unknown>;
    if (typeof item.tool_call_id !== "string" || !item.tool_call_id || item.tool_call_id.length > 200
      || /[\s\p{C}]/u.test(item.tool_call_id)
      || typeof item.task_id !== "string" || !TASK_ID.test(item.task_id)) continue;
    // Ambiguous duplicate bindings fail closed rather than selecting a task.
    if (ambiguous.has(item.tool_call_id)) continue;
    if (entries.has(item.tool_call_id)) {
      entries.delete(item.tool_call_id);
      ambiguous.add(item.tool_call_id);
      continue;
    }
    const steps = boundedSteps(item.steps);
    entries.set(item.tool_call_id, {
      toolCallId: item.tool_call_id, taskId: item.task_id,
      agent: plain(item.agent, 80), label: plain(item.label, 80) || plain(item.agent, 80) || "general-purpose",
      status: typeof item.status === "string" && STATUSES.has(item.status) ? item.status as SubagentRowStatus : "unknown",
      summary: plain(item.summary, 600),
      ...(steps !== undefined ? { steps } : {}),
      ...(typeof item.child_session_id === "string" && SESSION_ID.test(item.child_session_id)
        ? { childSessionId: item.child_session_id } : {}),
    });
  }
  if (!entries.size && !rows.some(row => row.kind === "subagent")) return rows;
  const projected: TimelineRow[] = [];
  const attached = new Set<string>();
  for (const row of rows) {
    if (row.kind === "subagent") continue;
    projected.push(row);
    if (row.kind !== "tool" || !["task", "task_resume"].includes(row.name) || attached.has(row.toolCallId)) continue;
    const entry = entries.get(row.toolCallId);
    if (!entry) continue;
    attached.add(row.toolCallId);
    projected.push({ kind: "subagent", seq: row.seq + 0.01, turnId: row.turnId, ...entry });
  }
  return projected;
}

/** Details reuse the subagents plugin and its parent-scoped read-only API. */
export function subagentDetailAllowed(row: SubagentRow, sessionId: string | undefined, effectivePluginIds: ReadonlySet<string> | undefined): boolean {
  return Boolean(effectivePluginIds?.has("sessions") && effectivePluginIds.has("subagents") && effectivePluginIds.has("files")
    && sessionId && SESSION_ID.test(sessionId) && TASK_ID.test(row.taskId)
    && row.childSessionId && SESSION_ID.test(row.childSessionId) && row.childSessionId !== sessionId);
}
