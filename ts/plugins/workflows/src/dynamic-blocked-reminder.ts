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

/** Idle boundaries of the parent session, in ms: 2m, 10m, 30m. */
export const DEFAULT_IDLE_BOUNDARIES_MS: readonly number[] = [120_000, 600_000, 1_800_000];

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

/**
 * One blocked-progress line per run: name, run id, the awaiting node, and how
 * much of the workflow settled before it blocked.
 */
export function blockedProgressLine(run: DynamicWorkflowRun, now = 0): string {
  const reminder = blockedReminderFor(run);
  if (!reminder) return '';
  const nodes = Object.values(run.nodes);
  const settled = nodes.filter((node) => node.status === 'completed' || node.status === 'failed' || (node.status as string) === 'skipped').length;
  const waiting = new Date(run.updatedAt).getTime();
  const elapsed = Number.isFinite(waiting) && now > waiting
    ? ` for ${Math.max(1, Math.round((now - waiting) / 60_000))}m`
    : '';
  return `${run.name} (run ${run.id}) paused on ${reminder.kind === 'hole' ? 'JSON hole' : 'actor question'} ${reminder.nodeId}${elapsed} — ${settled}/${nodes.length} nodes settled.`;
}

/** Human-readable summary of every blocked run, or '' when none block. */
export function blockedProgressSummary(runs: readonly DynamicWorkflowRun[], now = 0): string {
  const lines = runs
    .map((run) => blockedProgressLine(run, now))
    .filter((line) => line !== '');
  if (lines.length === 0) return '';
  const head = lines.length === 1
    ? '1 dynamic workflow is blocked awaiting you:'
    : `${lines.length} dynamic workflows are blocked awaiting you:`;
  return [head, ...lines.map((line) => `- ${line}`)].join('\n');
}

export interface BlockedNodeLedgerEntry {
  runId: string;
  nodeId: string;
  /** When the node was first seen blocked (ms epoch). */
  firstSeenAt: number;
  /** Last steering or progress touching this node; the idle origin. */
  lastActivityAt: number;
  /** Reminder stages already issued for this node state. */
  deliveredStages: number[];
}

export interface BlockedReminderState {
  version: 1;
  /** Parent-session steering clock (ms epoch). */
  sessionLastActiveAt: number;
  entries: Record<string, BlockedNodeLedgerEntry>;
}

export interface BlockedReminderTrackerOptions {
  boundaries?: readonly number[];
  limit?: number;
}

/**
 * Hidden persistent reminders for one parent session: a node blocked for a
 * boundary of idle time reminds once per stage, steering or progress re-arms
 * the ladder, and the delivered ledger survives `toJSON` round-trips so
 * compaction or resume replays state instead of repeating notices.
 */
export class BlockedReminderTracker {
  readonly boundaries: readonly number[];
  readonly limit: number;
  #sessionLastActiveAt = 0;
  readonly #entries = new Map<string, BlockedNodeLedgerEntry>();

  constructor(options: BlockedReminderTrackerOptions = {}) {
    const boundaries = options.boundaries ?? DEFAULT_IDLE_BOUNDARIES_MS;
    this.boundaries = [...boundaries].sort((a, b) => a - b);
    this.limit = options.limit ?? MAX_REMINDERS;
  }

  /** Parent-session steering: resets the idle clock and re-arms every node. */
  noteSessionActivity(at: number): void {
    this.#sessionLastActiveAt = Math.max(this.#sessionLastActiveAt, at);
    for (const entry of this.#entries.values()) {
      entry.lastActivityAt = Math.max(entry.lastActivityAt, at);
      entry.deliveredStages = [];
    }
  }

  /**
   * Run progress (any non-count-only change to the run): re-arms that run's
   * nodes so the next idle boundary reminds about the *new* blocked state.
   */
  noteRunProgress(runId: string, at: number): void {
    for (const entry of this.#entries.values()) {
      if (entry.runId !== runId) continue;
      entry.lastActivityAt = Math.max(entry.lastActivityAt, at);
      entry.deliveredStages = [];
    }
  }

  /**
   * Due hidden reminders at `now`: every blocked node whose idle origin is at
   * least a boundary old gets the highest unreached stage, once ever (until
   * re-armed). Settled nodes drop out of the ledger entirely.
   */
  poll(runs: readonly DynamicWorkflowRun[], now: number): BlockedReminder[] {
    const liveKeys = new Set<string>();
    const due: BlockedReminder[] = [];
    for (const run of runs) {
      const reminder = blockedReminderFor(run);
      if (!reminder) continue;
      liveKeys.add(reminder.key);
      const entry = this.#entry(reminder.runId, reminder.nodeId, now);
      const idleOrigin = Math.max(entry.firstSeenAt, entry.lastActivityAt, this.#sessionLastActiveAt);
      const idle = now - idleOrigin;
      let stage = -1;
      for (let index = 0; index < this.boundaries.length; index++) {
        if (idle >= this.boundaries[index]!) stage = index;
      }
      if (stage >= 0 && !entry.deliveredStages.includes(stage)) {
        // A node past the batch cap keeps its stage undelivered, so the next
        // poll reminds it instead of silencing it forever.
        if (due.length >= this.limit) continue;
        for (let s = 0; s <= stage; s++) {
          if (!entry.deliveredStages.includes(s)) entry.deliveredStages.push(s);
        }
        due.push({ ...reminder, key: `${reminder.key}:stage${stage}`, stage, hidden: true });
      }
    }
    for (const key of [...this.#entries.keys()]) {
      if (!liveKeys.has(key)) this.#entries.delete(key);
    }
    return due;
  }

  #entry(runId: string, nodeId: string, now: number): BlockedNodeLedgerEntry {
    const key = blockedReminderKey(runId, nodeId);
    let entry = this.#entries.get(key);
    if (!entry) {
      entry = { runId, nodeId, firstSeenAt: now, lastActivityAt: now, deliveredStages: [] };
      this.#entries.set(key, entry);
    }
    return entry;
  }

  /** Persistent snapshot; safe to journal, compact, and restore verbatim. */
  toJSON(): BlockedReminderState {
    const entries: Record<string, BlockedNodeLedgerEntry> = {};
    for (const [key, entry] of this.#entries) {
      entries[key] = { ...entry, deliveredStages: [...entry.deliveredStages] };
    }
    return { version: 1, sessionLastActiveAt: this.#sessionLastActiveAt, entries };
  }

  /** Restore a snapshot; anything malformed starts fresh rather than guessing. */
  static fromJSON(state: unknown, options: BlockedReminderTrackerOptions = {}): BlockedReminderTracker {
    const tracker = new BlockedReminderTracker(options);
    if (typeof state !== 'object' || state === null) return tracker;
    const record = state as Partial<BlockedReminderState>;
    if (record.version !== 1 || typeof record.sessionLastActiveAt !== 'number' || record.sessionLastActiveAt < 0) return tracker;
    if (typeof record.entries !== 'object' || record.entries === null) return tracker;
    tracker.#sessionLastActiveAt = record.sessionLastActiveAt;
    for (const [key, raw] of Object.entries(record.entries)) {
      if (typeof raw !== 'object' || raw === null) continue;
      const entry = raw as Partial<BlockedNodeLedgerEntry>;
      if (typeof entry.runId !== 'string' || typeof entry.nodeId !== 'string') continue;
      if (typeof entry.firstSeenAt !== 'number' || typeof entry.lastActivityAt !== 'number') continue;
      const stages = Array.isArray(entry.deliveredStages)
        ? entry.deliveredStages.filter((stage): stage is number => Number.isInteger(stage) && stage >= 0)
        : [];
      tracker.#entries.set(key, {
        runId: entry.runId,
        nodeId: entry.nodeId,
        firstSeenAt: entry.firstSeenAt,
        lastActivityAt: Math.max(entry.lastActivityAt, 0),
        deliveredStages: stages,
      });
    }
    return tracker;
  }
}
