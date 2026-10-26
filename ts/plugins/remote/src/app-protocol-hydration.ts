/**
 * Cold-start hydration of the projection subscriptions (F11.05).
 *
 * The server already publishes conversation/controller/workflow projection
 * frames, media restore status and background-task notifications. This
 * module is the client half: it maps those wire rows onto one typed local
 * state so a client that starts from nothing converges to the same view as
 * one that watched every frame.
 *
 * Semantics mirror the baselines exactly:
 *  - conversation deltas are `history.difference` operations (`set`, `delete`,
 *    `append` with array paths) replayed with `history.apply`; a frame from a
 *    foreign `logEpoch` or a non-contiguous `fromSeq` never corrupts state —
 *    it flags `requiresSnapshot` and the caller resubscribes;
 *  - missing fields materialize as documented defaults (`seq` 0, session
 *    status "initial", revision 0, empty windows/events), never as `undefined`;
 *  - incremental deletions are explicit: journal-window advance drops
 *    messages, controller snapshots tombstone absent sessions, workflow
 *    `gap` discards events below `oldestSeq`, terminal background tasks move
 *    from active to a bounded finished ledger.
 */
import { isDict, isPyIntValue, pyDeepCopy, pyDictGet } from '@xueness/contracts';
import { apply, digest, type HistoryOperation } from '@xueness/sessions';

export const HYDRATION_SCHEMA = 'xueness.projection-hydration.v1';
export const CONTROLLER_TOMBSTONES = 64;
export const WORKFLOW_EVENTS = 512;
export const FINISHED_TASKS = 32;
const SESSION_ID = /^[0-9a-f]{32}$/;
const EPOCH = /^[0-9a-f]{16,64}$/;
const TERMINAL_TASKS = new Set(['exited', 'killed', 'timed_out', 'failed']);
const TASK_STATES = new Set(['running', 'exited', 'killed', 'timed_out', 'failed']);

type Row = Record<string, unknown>;
const int = (value: unknown, fallback = 0): number => (isPyIntValue(value) && Number(value) >= 0 ? Number(value) : fallback);
const text = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);

/** Default materialization of one conversation projection row. */
export interface ConversationView {
  sessionId: string;
  status: string;
  title: string;
  updatedAt: string | null;
  revision: number;
  windowStart: number;
  messages: unknown[];
  droppedMessages: number;
  events: unknown[];
  nextCursor: number;
  hasMore: boolean;
}

interface ConversationHydration {
  sessionId: string;
  logEpoch: string | null;
  seq: number;
  state: unknown;
  view: ConversationView;
  requiresSnapshot: boolean;
}

function conversationView(sessionId: string, state: unknown): ConversationView {
  const source = isDict(state) ? state : {};
  const session = isDict(pyDictGet(source, 'session')) ? pyDictGet(source, 'session') as Row : {};
  const journal = isDict(pyDictGet(source, 'journal')) ? pyDictGet(source, 'journal') as Row : {};
  const timeline = isDict(pyDictGet(source, 'timeline')) ? pyDictGet(source, 'timeline') as Row : {};
  const window = isDict(pyDictGet(journal, 'window')) ? pyDictGet(journal, 'window') as Row : {};
  const start = int(pyDictGet(window, 'start'));
  const rawMessages = pyDictGet(journal, 'messages');
  const messages: unknown[] = Array.isArray(rawMessages) ? pyDeepCopy(rawMessages) as unknown[] : [];
  const rawEvents = pyDictGet(timeline, 'events');
  const events: unknown[] = Array.isArray(rawEvents) ? pyDeepCopy(rawEvents) as unknown[] : [];
  return {
    sessionId,
    status: text(pyDictGet(session, 'status'), 'initial'),
    title: text(pyDictGet(session, 'title')),
    updatedAt: typeof pyDictGet(session, 'updated_at') === 'string' ? pyDictGet(session, 'updated_at') as string : null,
    revision: int(pyDictGet(journal, 'message_revision')),
    windowStart: start,
    messages,
    droppedMessages: start,
    events,
    nextCursor: int(pyDictGet(timeline, 'nextCursor')),
    hasMore: pyDictGet(timeline, 'hasMore') === true,
  };
}

function emptyConversation(sessionId: string): ConversationHydration {
  return { sessionId, logEpoch: null, seq: 0, state: {}, view: conversationView(sessionId, {}), requiresSnapshot: true };
}

/**
 * Apply one conversation-transport envelope. A snapshot frame resets state
 * and epoch; resume frames must continue the same epoch from the current
 * seq. Anything else leaves state untouched and flags `requiresSnapshot`.
 */
export function hydrateConversation(current: ConversationHydration | null, envelope: unknown): ConversationHydration {
  if (!isDict(envelope)) throw new Error('conversation envelope must be an object');
  const sessionId = text(pyDictGet(envelope, 'topic')).startsWith('conversation/')
    ? text(pyDictGet(envelope, 'topic')).slice('conversation/'.length) : '';
  if (!SESSION_ID.test(sessionId)) throw new Error('conversation envelope is missing its session identity');
  const hydration: ConversationHydration = current && current.sessionId === sessionId ? current : emptyConversation(sessionId);
  const frames = Array.isArray(pyDictGet(envelope, 'frames')) ? pyDictGet(envelope, 'frames') as unknown[] : [];
  const mode = text(pyDictGet(envelope, 'mode'), 'snapshot');
  if (mode !== 'snapshot' && mode !== 'resume') throw new Error('invalid conversation transport mode');
  let { state } = hydration;
  let epoch = hydration.logEpoch;
  let seq = hydration.seq;
  let requiresSnapshot = false;
  let dropped = hydration.view.droppedMessages;
  for (const frame of frames) {
    if (!isDict(frame)) throw new Error('conversation frame must be an object');
    const kind = text(pyDictGet(frame, 'kind'));
    const frameEpoch = pyDictGet(frame, 'logEpoch');
    if (kind === 'snapshot') {
      if (typeof frameEpoch !== 'string' || !EPOCH.test(frameEpoch)) throw new Error('snapshot frame is missing its projection epoch');
      state = pyDeepCopy(pyDictGet(frame, 'snapshot'));
      epoch = frameEpoch;
      seq = int(pyDictGet(frame, 'toSeq'), seq);
      const fresh = conversationView(sessionId, state);
      // A window advance is a deletion: messages before `start` are gone.
      dropped = Math.max(dropped, fresh.windowStart);
      requiresSnapshot = false;
      continue;
    }
    if (kind !== 'delta') throw new Error('invalid conversation frame kind');
    if (mode === 'snapshot') throw new Error('a snapshot envelope carries no delta frames');
    if (epoch === null || frameEpoch !== epoch || int(pyDictGet(frame, 'fromSeq'), -1) !== seq) {
      requiresSnapshot = true;
      continue;
    }
    const operations = pyDictGet(frame, 'operations');
    if (operations !== undefined && !Array.isArray(operations)) throw new Error('delta operations must be an array');
    try {
      state = apply(state, operations ?? []);
    } catch {
      requiresSnapshot = true;
      continue;
    }
    seq = int(pyDictGet(frame, 'toSeq'), seq);
    const fresh = conversationView(sessionId, state);
    dropped = Math.max(dropped, fresh.windowStart);
  }
  const next: ConversationHydration = {
    sessionId, logEpoch: epoch, seq, state,
    view: { ...conversationView(sessionId, state), droppedMessages: dropped },
    requiresSnapshot: requiresSnapshot || epoch === null,
  };
  if (isPyIntValue(pyDictGet(envelope, 'seq'))) next.seq = int(pyDictGet(envelope, 'seq'), next.seq);
  return next;
}

/** Default materialization of the controller (workspace session index). */
export interface WorkspaceView {
  generation: number;
  sessions: { id: string; status: string; root: string }[];
  tombstones: string[];
}

/**
 * Apply a controller snapshot. Sessions absent from the new snapshot are
 * deletions: they leave `sessions` and enter a bounded tombstone ledger, so
 * a cold client can tell "finished" from "never seen".
 */
export function hydrateWorkspace(current: WorkspaceView | null, snapshot: unknown): WorkspaceView {
  if (!isDict(snapshot)) throw new Error('controller snapshot must be an object');
  const generation = (current?.generation ?? 0) + 1;
  const rows = Array.isArray(pyDictGet(snapshot, 'sessions')) ? pyDictGet(snapshot, 'sessions') as unknown[] : [];
  const known = new Map((current?.sessions ?? []).map((row) => [row.id, row]));
  const tombstones = new Set(current?.tombstones ?? []);
  const sessions: WorkspaceView['sessions'] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!isDict(row)) throw new Error('controller session row must be an object');
    const id = text(pyDictGet(row, 'id'));
    if (!SESSION_ID.test(id)) throw new Error('controller session row is missing its identity');
    if (seen.has(id)) throw new Error('duplicate controller session identity');
    seen.add(id);
    tombstones.delete(id);
    known.delete(id);
    sessions.push({ id, status: text(pyDictGet(row, 'status'), 'initial'), root: text(pyDictGet(row, 'root')) });
  }
  for (const removed of known.keys()) tombstones.add(removed);
  // The tombstone ledger is bounded, so the removed rows it summarizes must be
  // too: replaying every past snapshot must not grow `sessions` without limit.
  const retained = new Set([...tombstones].slice(-CONTROLLER_TOMBSTONES));
  for (const removed of known.keys()) {
    if (retained.has(removed)) sessions.push({ ...(known.get(removed)!), status: 'removed' });
  }
  return { generation, sessions, tombstones: [...retained] };
}

/** Default materialization of one workflow run's event page. */
export interface WorkflowView {
  runId: string;
  status: string;
  seq: number;
  events: { seq: number; type: string }[];
  gap: boolean;
  requiresReplay: boolean;
}

function workflowRow(runId: string): WorkflowView {
  return { runId, status: 'unknown', seq: 0, events: [], gap: false, requiresReplay: false };
}

/**
 * Apply a workflow events page. Events are appended only above the current
 * seq (replays stay idempotent). A declared `gap` discards every buffered
 * event below `oldestSeq` — that history is a deletion, not a hole to fill
 * locally — and flags `requiresReplay`: the authoritative run record must be
 * refetched before older events can be trusted again.
 */
export function hydrateWorkflow(current: WorkflowView | null, page: unknown): WorkflowView {
  if (!isDict(page)) throw new Error('workflow page must be an object');
  const runId = text(pyDictGet(page, 'runId'));
  if (!/^[0-9a-f]{32}$/.test(runId)) throw new Error('workflow page is missing its run identity');
  const view: WorkflowView = current && current.runId === runId
    ? { ...current, events: [...current.events] }
    : workflowRow(runId);
  const status = pyDictGet(page, 'status');
  if (typeof status === 'string' && status) view.status = status;
  const gap = pyDictGet(page, 'gap') === true;
  const oldest = int(pyDictGet(page, 'oldestSeq'));
  if (gap) {
    view.events = view.events.filter((event) => event.seq >= oldest);
    view.gap = true;
    view.requiresReplay = true;
  }
  const rows = Array.isArray(pyDictGet(page, 'events')) ? pyDictGet(page, 'events') as unknown[] : [];
  for (const row of rows) {
    if (!isDict(row)) continue;
    const seq = int(pyDictGet(row, 'seq'), -1);
    if (seq < 0 || seq <= view.seq) continue;
    view.events.push({ seq, type: text(pyDictGet(row, 'type')) });
    view.seq = seq;
  }
  view.events = view.events.slice(-WORKFLOW_EVENTS);
  return view;
}

/** Default materialization of a media restore status row. */
export interface MediaRestoreView {
  restoreId: string;
  state: string;
  messageIndex: number;
  revision: number;
  restoreEpoch: string | null;
  bytes: number;
}

/** Map one media restore/preview status; absent fields stay defaults, never `undefined`. */
export function hydrateMediaRestore(row: unknown): MediaRestoreView {
  if (!isDict(row)) throw new Error('media restore status must be an object');
  const restoreId = text(pyDictGet(row, 'restoreId'));
  if (!/^[0-9a-f]{32}$/.test(restoreId)) throw new Error('media restore status is missing its identity');
  const rawState = text(pyDictGet(row, 'state'), pyDictGet(row, 'status') as string | undefined ?? 'pending');
  const epoch = pyDictGet(row, 'restoreEpoch');
  return {
    restoreId,
    state: ['pending', 'running', 'completed', 'failed', 'aborted'].includes(rawState) ? rawState : 'pending',
    messageIndex: int(pyDictGet(row, 'messageIndex')),
    revision: int(pyDictGet(row, 'revision')),
    restoreEpoch: typeof epoch === 'string' && EPOCH.test(epoch) ? epoch : null,
    bytes: int(pyDictGet(row, 'bytes')),
  };
}

/** Default materialization of a background task notification. */
export interface BackgroundTaskView {
  id: string;
  state: string;
  exitCode: number | null;
  durationMs: number;
  finished: boolean;
}

export interface BackgroundTasksView {
  active: BackgroundTaskView[];
  finished: BackgroundTaskView[];
}

/**
 * Apply one background task notification. A terminal state (`exited`,
 * `killed`, `timed_out`, `failed`) is the deletion event: the task leaves
 * `active` and is retained in a bounded `finished` ledger.
 */
export function hydrateBackgroundTask(current: BackgroundTasksView | null, row: unknown): BackgroundTasksView {
  if (!isDict(row)) throw new Error('background task notification must be an object');
  const id = text(pyDictGet(row, 'id'));
  if (!id) throw new Error('background task notification is missing its identity');
  const rawState = text(pyDictGet(row, 'state'));
  const state = TASK_STATES.has(rawState) ? rawState : 'failed';
  const exitCode = pyDictGet(row, 'exitCode');
  const view: BackgroundTaskView = {
    id,
    state,
    exitCode: typeof exitCode === 'number' && Number.isSafeInteger(exitCode) ? exitCode : null,
    durationMs: int(pyDictGet(row, 'durationMs')),
    finished: TERMINAL_TASKS.has(state),
  };
  const base: BackgroundTasksView = { active: [], finished: [] };
  const prior = current ?? base;
  const active = prior.active.filter((task) => task.id !== id);
  const finished = prior.finished.filter((task) => task.id !== id);
  (view.finished ? finished : active).push(view);
  return { active, finished: finished.slice(-FINISHED_TASKS) };
}

/**
 * A stable digest of everything hydrated: two clients that consumed the
 * same frame sequence — one cold, one live — match exactly when their
 * digests match.
 */
export function hydrationDigest(parts: {
  conversation?: ConversationHydration | null;
  workspace?: WorkspaceView | null;
  workflow?: WorkflowView | null;
  media?: MediaRestoreView[];
  background?: BackgroundTasksView;
}): string {
  return digest({
    schema: HYDRATION_SCHEMA,
    conversation: parts.conversation
      ? { epoch: parts.conversation.logEpoch, seq: parts.conversation.seq, requiresSnapshot: parts.conversation.requiresSnapshot, view: parts.conversation.view }
      : null,
    workspace: parts.workspace ?? null,
    workflow: parts.workflow ?? null,
    media: parts.media ?? [],
    background: parts.background ?? { active: [], finished: [] },
  });
}

/** The delta operations type re-exported for hydration consumers. */
export type { HistoryOperation };
