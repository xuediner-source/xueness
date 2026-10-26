/**
 * Durable background receipts for delegated subagent tasks (C-WFL-04): a
 * child task that reached a terminal state without being collected produces
 * exactly one hidden notice per task id and status, merged into the same
 * `_input_kind: "background_notice"` stream the shell runtime uses. The
 * sessions turn merging never counts these as human input; count-only
 * changes (steps, wait bookkeeping) stay silent and trigger no extra model
 * request. Delivery is stamped on the durable `task_runs` row (`notified`),
 * so a resumed or restarted parent receives the reminder once, ever.
 */
import { wrapSystemReminderForSource } from "@xueness/agent";
import { isDict } from "@xueness/contracts";
import { CANCELLED, COMPLETED, FAILED } from "./task-registry.ts";
import type { Row } from "./definitions.ts";

export const SUBAGENT_NOTICE_SOURCE = "task_status";
const TERMINAL_STATUSES = new Set<string>([COMPLETED, FAILED, CANCELLED]);
const MAX_NOTICES = 8;
const TASK_ID = /^task-[A-Za-z0-9_-]{1,160}$/;

export interface SubagentNotice {
  taskId: string;
  status: string;
  key: string;
  content: string;
}

/** `subagents:<task>:<status>` — namespaced so shell task keys can never collide. */
export function subagentNoticeKey(taskId: string, status: string): string {
  return `subagents:${taskId}:${status}`;
}

function noticeKeys(messages: unknown): Set<string> {
  if (!Array.isArray(messages)) return new Set();
  return new Set(messages.flatMap((message) => {
    if (!isDict(message)) return [];
    const key = message._background_task_notice;
    return typeof key === "string" ? [key] : [];
  }));
}

/**
 * Terminal, uncollected tasks of this parent that have no durable notice yet.
 * A task already marked `notified` — or whose key survives in current or
 * archived messages — is never reminded again.
 */
export function pendingSubagentNotices(session: Row): SubagentNotice[] {
  const seen = new Set([...noticeKeys(session.messages), ...noticeKeys(session.archived_messages)]);
  const notices: SubagentNotice[] = [];
  for (const row of Array.isArray(session.task_runs) ? session.task_runs : []) {
    if (!isDict(row) || typeof row.id !== "string" || !TASK_ID.test(row.id)) continue;
    if (row.parent !== undefined && row.parent !== session.id) continue;
    if (typeof row.status !== "string" || !TERMINAL_STATUSES.has(row.status)) continue;
    if (row.notified === true) continue;
    const key = subagentNoticeKey(row.id, row.status);
    if (seen.has(key)) continue;
    seen.add(key);
    notices.push({ taskId: row.id, status: row.status, key, content: noticeContent(row.id, row.status) });
    if (notices.length >= MAX_NOTICES) break;
  }
  return notices;
}

/** Status facts only: a child summary is untrusted findings, never notice content. */
function noticeContent(taskId: string, status: string): string {
  return `Background subagent task ${taskId} finished with status ${status}. The result is not attached to this notice. Call task_collect with task_ids ["${taskId}"] to retrieve the findings before finishing; this metadata is not evidence of completed work.`;
}

/**
 * Merge the pending notices into the session journal at a safe boundary and
 * stamp their `task_runs` rows. Returns whether any notice was added (the
 * host continues the loop only then); a failed save rolls the journal and
 * the stamps back so the reminder can be resent.
 */
export async function mergeSubagentNotices(context: { session: Row; save(): Promise<void> }): Promise<boolean> {
  const session = context.session;
  const notices = pendingSubagentNotices(session);
  if (!notices.length) return false;
  const previousMessages = session.messages;
  const messages = Array.isArray(previousMessages) ? [...(previousMessages as Row[])] : [];
  const rows = new Map<string, Row>();
  for (const row of Array.isArray(session.task_runs) ? session.task_runs : []) if (isDict(row) && typeof row.id === "string") rows.set(row.id, row);
  const stamped: string[] = [];
  try {
    for (const notice of notices) {
      messages.push({
        role: "user",
        content: wrapSystemReminderForSource(SUBAGENT_NOTICE_SOURCE, notice.content),
        _input_kind: "background_notice",
        _background_task_notice: notice.key,
        _meta_source: SUBAGENT_NOTICE_SOURCE,
      });
      // The row is the durable delivery record; it is restored below on failure.
      const row = rows.get(notice.taskId);
      if (row && row.notified !== true) { row.notified = true; stamped.push(notice.taskId); }
    }
    session.messages = messages;
    await context.save();
    return true;
  } catch (error) {
    if (previousMessages === undefined) delete session.messages;
    else session.messages = previousMessages;
    for (const taskId of stamped) { const row = rows.get(taskId); if (row) row.notified = false; }
    throw error;
  }
}
