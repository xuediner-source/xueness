/**
 * Live-run blocked reminders (C-WFL-04; upstream
 * `dynamic-workflow-blocked-reminder`): a dynamic run paused on a pending
 * actor question or hole pushes one reminder per run and node state into the
 * host's existing background-notice queue. Reminders are pure descriptors —
 * the host owns the session journal — and only a run actually waiting on an
 * answer produces one; event growth or count-only changes stay silent.
 *
 * The scheduler layer (F10.07) turns those descriptors into hidden persistent
 * reminders at prescribed idle boundaries of the parent session: steering or
 * observable run progress re-arms a blocked node, and the delivered-stage
 * ledger survives compaction and resume (round-tripped through `toJSON`) so a
 * restored session never repeats a reminder it already issued.
 */
import type { DynamicWorkflowRun } from './dynamic-types.ts';

export interface BlockedReminder {
  key: string;
  runId: string;
  runName: string;
  nodeId: string;
  kind: 'ask' | 'hole';
  message: string;
  /** Reminder stage within the idle boundary ladder (0 = first boundary). */
  stage?: number;
  /** Hidden reminders are session metadata, never conversation payload. */
  hidden?: boolean;
}

const MAX_REMINDERS = 8;

/** `dwf:<run>:awaiting_user:<node>` — one key per blocked run and node state. */
export function blockedReminderKey(runId: string, nodeId: string): string {
  return `dwf:${runId}:awaiting_user:${nodeId}`;
}

/**
 * The reminder for one run, or null when the run is not blocked on an
 * answer. A run awaiting the user with no awaiting node (a race between
 * status and node writes) reminds on nothing rather than guessing.
 */
export function blockedReminderFor(run: DynamicWorkflowRun): BlockedReminder | null {
  if (run.status !== 'awaiting_user') return null;
  const entry = Object.entries(run.nodes).find(([, node]) => node.status === 'awaiting_user');
  if (!entry) return null;
  const [nodeId, node] = entry;
  if (node.kind !== 'ask' && node.kind !== 'hole') return null;
  const kind = node.kind === 'hole' ? 'a JSON hole' : 'an actor question';
  const answer = node.kind === 'hole'
    ? 'Answer it with workflow_script_resolve and JSON data'
    : 'Answer it with workflow_script_resolve and the actor reply text';
  return {
    key: blockedReminderKey(run.id, nodeId),
    runId: run.id,
    runName: run.name,
    nodeId,
    kind: node.kind,
    message: `Dynamic workflow ${run.name} (run ${run.id}) is paused awaiting ${kind} on node ${nodeId}. ${answer}; the run continues by itself once resolved and explicitly resumed. This notice is metadata, not the question payload.`,
  };
}

/** Deduped, capped reminder descriptors for a session's owned runs. */
export function blockedReminders(runs: readonly DynamicWorkflowRun[], limit = MAX_REMINDERS): BlockedReminder[] {
  const seen = new Set<string>();
  const reminders: BlockedReminder[] = [];
  for (const run of runs) {
    const reminder = blockedReminderFor(run);
    if (!reminder || seen.has(reminder.key)) continue;
    seen.add(reminder.key);
    reminders.push(reminder);
    if (reminders.length >= limit) break;
  }
  return reminders;
}

