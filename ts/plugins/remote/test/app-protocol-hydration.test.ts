import assert from 'node:assert/strict';
import { it } from 'node:test';
import {
  hydrateBackgroundTask, hydrateConversation, hydrateMediaRestore, hydrateWorkflow, hydrateWorkspace,
  hydrationDigest, type BackgroundTasksView,
} from '../src/app-protocol-hydration.ts';

const sid = 'a'.repeat(32);
const sid2 = 'b'.repeat(32);
const runId = 'd'.repeat(32);
const epoch1 = 'e'.repeat(32);
const epoch2 = 'f'.repeat(32);
const restoreId = '1'.repeat(32);

type Row = Record<string, unknown>;
const envelope = (mode: string, logEpoch: string, seq: number, frames: Row[]): Row =>
  ({ schema: 'xueness.conversation-transport.v1', topic: `conversation/${sid}`, mode, logEpoch, seq, frames });
const snapshotFrame = (logEpoch: string, toSeq: number, snapshot: Row): Row =>
  ({ kind: 'snapshot', logEpoch, fromSeq: 0, toSeq, snapshot });
const deltaFrame = (logEpoch: string, fromSeq: number, toSeq: number, operations: Row[]): Row =>
  ({ kind: 'delta', logEpoch, fromSeq, toSeq, operations });

const baseSnapshot = (): Row => ({
  session: { id: sid, status: 'running', title: 'demo', updated_at: '2026-10-26T00:00:00Z' },
  journal: { message_revision: 4, window: { start: 0, end: 2 }, messages: [{ _message_id: 'm1' }, { _message_id: 'm2' }] },
  timeline: { events: [{ seq: 1, type: 'message.appended' }], nextCursor: 1, hasMore: false },
});

it('cold-start hydrates a conversation snapshot with defaults materialized, then applies contiguous deltas', () => {
  const cold = hydrateConversation(null, envelope('snapshot', epoch1, 1, [snapshotFrame(epoch1, 1, baseSnapshot())]));
  assert.equal(cold.logEpoch, epoch1);
  assert.equal(cold.seq, 1);
  assert.equal(cold.requiresSnapshot, false);
  assert.equal(cold.view.status, 'running');
  assert.equal(cold.view.revision, 4);
  assert.equal(cold.view.messages.length, 2);
  assert.equal(cold.view.events.length, 1);

  const updated = hydrateConversation(cold, envelope('resume', epoch1, 2, [
    deltaFrame(epoch1, 1, 2, [
      { op: 'set', path: ['session', 'status'], value: 'paused' },
      { op: 'append', path: ['journal', 'messages'], value: [{ _message_id: 'm3' }] },
      { op: 'set', path: ['journal', 'window'], value: { start: 0, end: 3 } },
    ]),
  ]));
  assert.equal(updated.view.status, 'paused');
  assert.equal(updated.view.messages.length, 3);
  assert.equal(updated.seq, 2);
  assert.equal(updated.requiresSnapshot, false);

  // Defaults: an empty snapshot still yields defined fields, never undefined.
  const empty = hydrateConversation(null, envelope('snapshot', epoch1, 1, [snapshotFrame(epoch1, 1, {})]));
  assert.equal(empty.view.status, 'initial');
  assert.equal(empty.view.title, '');
  assert.equal(empty.view.revision, 0);
  assert.deepEqual(empty.view.messages, []);
  assert.equal(empty.view.updatedAt, null);
});

it('a foreign epoch or a non-contiguous delta flags requiresSnapshot without corrupting state', () => {
  const start = hydrateConversation(null, envelope('snapshot', epoch1, 3, [snapshotFrame(epoch1, 3, baseSnapshot())]));
  const foreign = hydrateConversation(start, envelope('resume', epoch1, 4, [deltaFrame(epoch2, 3, 4, [
    { op: 'set', path: ['session', 'status'], value: 'must-not-apply' },
  ])]));
  assert.equal(foreign.requiresSnapshot, true);
  assert.equal(foreign.view.status, 'running', 'a foreign epoch must not touch hydrated state');
  assert.equal(foreign.logEpoch, epoch1);

  const hole = hydrateConversation(start, envelope('resume', epoch1, 5, [deltaFrame(epoch1, 4, 5, [
    { op: 'set', path: ['session', 'status'], value: 'must-not-apply-either' },
  ])]));
  assert.equal(hole.requiresSnapshot, true);
  assert.equal(hole.view.status, 'running');

  // The next snapshot heals the subscription without a fresh cold start.
  const healed = hydrateConversation(hole, envelope('snapshot', epoch2, 1, [snapshotFrame(epoch2, 1, {
    ...baseSnapshot(), session: { ...(baseSnapshot().session as Row), status: 'idle' },
  })]));
  assert.equal(healed.requiresSnapshot, false);
  assert.equal(healed.logEpoch, epoch2);
  assert.equal(healed.view.status, 'idle');
});

it('a journal window advance is recorded as a message deletion, and two cold clients converge to one digest', () => {
  const first = hydrateConversation(null, envelope('snapshot', epoch1, 1, [snapshotFrame(epoch1, 1, baseSnapshot())]));
  const compacted = hydrateConversation(first, envelope('snapshot', epoch1, 2, [snapshotFrame(epoch1, 2, {
    session: baseSnapshot().session,
    journal: { message_revision: 6, window: { start: 2, end: 3 }, messages: [{ _message_id: 'm3' }] },
    timeline: { events: [], nextCursor: 1, hasMore: false },
  })]));
  assert.equal(compacted.view.messages.length, 1);
  assert.equal(compacted.view.droppedMessages, 2, 'messages before the window start are deletions');
  assert.ok(compacted.view.droppedMessages > first.view.droppedMessages);

  const replayCold = hydrateConversation(null, envelope('snapshot', epoch1, 1, [snapshotFrame(epoch1, 1, baseSnapshot())]));
  const replayWarm = hydrateConversation(replayCold, envelope('snapshot', epoch1, 2, [snapshotFrame(epoch1, 2, {
    session: baseSnapshot().session,
    journal: { message_revision: 6, window: { start: 2, end: 3 }, messages: [{ _message_id: 'm3' }] },
    timeline: { events: [], nextCursor: 1, hasMore: false },
  })]));
  assert.equal(hydrationDigest({ conversation: compacted }), hydrationDigest({ conversation: replayWarm }));
});

it('controller snapshots default session rows and tombstone sessions that disappear', () => {
  const first = hydrateWorkspace(null, {
    workspaceIdentity: 'w', sessions: [
      { id: sid, root: 'w', status: 'running' },
      { id: sid2, root: 'w' },
    ],
  });
  assert.equal(first.generation, 1);
  assert.equal(first.sessions.length, 2);
  assert.equal(first.sessions.find((row) => row.id === sid2)?.status, 'initial', 'missing status defaults to initial');
  assert.deepEqual(first.tombstones, []);

  const second = hydrateWorkspace(first, { workspaceIdentity: 'w', sessions: [{ id: sid2, root: 'w', status: 'idle' }] });
  assert.equal(second.generation, 2);
  assert.deepEqual(second.tombstones, [sid], 'an absent session is a deletion with a tombstone');
  const removed = second.sessions.find((row) => row.id === sid);
  assert.equal(removed?.status, 'removed');
  assert.equal(second.sessions.find((row) => row.id === sid2)?.status, 'idle');

  // Reappearing clears the tombstone (it is a live session again, not a ghost).
  const third = hydrateWorkspace(second, { workspaceIdentity: 'w', sessions: [{ id: sid, root: 'w' }, { id: sid2, root: 'w' }] });
  assert.deepEqual(third.tombstones, []);
  assert.equal(third.sessions.find((row) => row.id === sid)?.status, 'initial');
});

it('workflow pages stay idempotent, and a declared gap discards buffered history as a deletion', () => {
  let run = hydrateWorkflow(null, { runId, status: 'running', events: [{ seq: 1, type: 'node.started' }, { seq: 2, type: 'node.completed' }] });
  assert.equal(run.status, 'running');
  assert.equal(run.seq, 2);
  const replay = hydrateWorkflow(run, { runId, status: 'running', events: [{ seq: 2, type: 'node.completed' }] });
  assert.equal(replay.events.length, 2, 'replayed events must not duplicate');

  const gapped = hydrateWorkflow(replay, { runId, status: 'running', gap: true, oldestSeq: 5, events: [{ seq: 6, type: 'node.started' }] });
  assert.equal(gapped.requiresReplay, true);
  assert.deepEqual(gapped.events.map((event) => event.seq), [6], 'events below oldestSeq are discarded on a gap');
  assert.equal(gapped.gap, true);

  const resumed = hydrateWorkflow(gapped, { runId, events: [{ seq: 7, type: 'node.completed' }] });
  assert.equal(resumed.status, 'running', 'a page without status keeps the last known status');
  assert.equal(resumed.requiresReplay, true, 'only an authoritative run record clears the replay flag');
});

it('media restore maps state with defaults and rejects unknown states to pending', () => {
  const view = hydrateMediaRestore({ restoreId, state: 'running', messageIndex: 3, revision: 2, restoreEpoch: epoch1, bytes: 4096 });
  assert.equal(view.state, 'running');
  assert.equal(view.bytes, 4096);
  const sparse = hydrateMediaRestore({ restoreId });
  assert.equal(sparse.state, 'pending');
  assert.equal(sparse.messageIndex, 0);
  assert.equal(sparse.restoreEpoch, null);
  const unknown = hydrateMediaRestore({ restoreId, state: 'weird' });
  assert.equal(unknown.state, 'pending');
  assert.throws(() => hydrateMediaRestore({ state: 'running' }), /missing its identity/);
});

it('terminal background tasks leave active and enter a bounded finished ledger', () => {
  let tasks: BackgroundTasksView | null = hydrateBackgroundTask(null, { id: 'task-1', state: 'running', durationMs: 10 });
  assert.equal(tasks.active.length, 1);
  tasks = hydrateBackgroundTask(tasks, { id: 'task-2', state: 'running' });
  assert.equal(tasks.active.length, 2);
  tasks = hydrateBackgroundTask(tasks, { id: 'task-1', state: 'exited', exitCode: 0, durationMs: 500 });
  assert.equal(tasks.active.length, 1);
  assert.equal(tasks.active[0]?.id, 'task-2');
  assert.equal(tasks.finished.length, 1);
  assert.equal(tasks.finished[0]?.exitCode, 0);
  assert.equal(tasks.finished[0]?.finished, true);
  const invalid = hydrateBackgroundTask(tasks, { id: 'task-3', state: 'exploded' });
  assert.equal(invalid.finished.at(-1)?.state, 'failed', 'an unknown state is a failed task, never silently active');
});

it('the full cold-start digest equals the live digest for the same frame sequence', () => {
  const conversationFrames = [
    envelope('snapshot', epoch1, 1, [snapshotFrame(epoch1, 1, baseSnapshot())]),
    envelope('resume', epoch1, 2, [deltaFrame(epoch1, 1, 2, [{ op: 'set', path: ['session', 'status'], value: 'idle' }])]),
  ];
  const workspaceFrames = [
    { workspaceIdentity: 'w', sessions: [{ id: sid, root: 'w' }] },
    { workspaceIdentity: 'w', sessions: [] },
  ];
  const live = { conversation: hydrateConversation(null, conversationFrames[0]) };
  live.conversation = hydrateConversation(live.conversation, conversationFrames[1]!);
  const liveWorkspace = hydrateWorkspace(hydrateWorkspace(null, workspaceFrames[0]), workspaceFrames[1]);
  const liveWorkflow = hydrateWorkflow(null, { runId, status: 'completed', events: [{ seq: 9, type: 'run.completed' }] });
  const liveMedia = [hydrateMediaRestore({ restoreId, state: 'completed' })];
  const liveBackground = hydrateBackgroundTask(null, { id: 'task-9', state: 'timed_out', durationMs: 1 });

  const coldConversation = hydrateConversation(null, conversationFrames[1]!);
  const cold = hydrationDigest({
    conversation: coldConversation,
    workspace: hydrateWorkspace(null, workspaceFrames[1]),
    workflow: hydrateWorkflow(null, { runId, status: 'completed', events: [{ seq: 9, type: 'run.completed' }], gap: false }),
    media: liveMedia,
    background: liveBackground,
  });
  const liveDigest = hydrationDigest({
    conversation: live.conversation, workspace: liveWorkspace, workflow: liveWorkflow,
    media: liveMedia, background: liveBackground,
  });
  // A cold client that missed the first frame must differ (it needs a snapshot),
  // then match after replaying the whole sequence.
  assert.notEqual(cold, liveDigest);
  const replayed = hydrationDigest({
    conversation: (() => {
      let state = hydrateConversation(null, conversationFrames[0]);
      return hydrateConversation(state, conversationFrames[1]!);
    })(),
    workspace: liveWorkspace, workflow: liveWorkflow, media: liveMedia, background: liveBackground,
  });
  assert.equal(replayed, liveDigest);
});

it('invalid envelopes are refused with explicit errors', () => {
  assert.throws(() => hydrateConversation(null, { mode: 'snapshot' }), /missing its session identity/);
  assert.throws(() => hydrateConversation(null, envelope('sideways', epoch1, 1, [])), /invalid conversation transport mode/);
  assert.throws(() => hydrateConversation(null, envelope('snapshot', epoch1, 1, [deltaFrame(epoch1, 0, 1, [])])), /snapshot envelope carries no delta/);
  assert.throws(() => hydrateWorkspace(null, { sessions: [{ id: 'nope' }] }), /missing its identity/);
  assert.throws(() => hydrateWorkflow(null, { runId: 'short' }), /missing its run identity/);
  assert.throws(() => hydrateBackgroundTask(null, { state: 'running' }), /missing its identity/);
});
