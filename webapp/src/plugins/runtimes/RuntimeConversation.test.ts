import test from 'node:test';
import assert from 'node:assert/strict';
import { applyRuntimeConversationFrame, startRuntimeConversation } from './RuntimeConversation';
import { runtimeConversationRows } from '../sessions/runtimeConversationProjection';

const revision = 'sha256:' + 'a'.repeat(64);
function initial() {
  const rows = [{rowId: 90, kind: 'userInput', turnId: 'turn-1', text: 'request', createdAtSeq: 1, messageIndex: 1},
    {rowId: 4, kind: 'assistantText', turnId: 'turn-1', text: 'partial', state: 'streaming', createdAtSeq: 2}];
  return {ack: {subscriptionId: 's', mode: 'snapshot', logEpoch: 'e'}, frame: {topic: 'conversation/id', subscriptionId: 's', fromSeq: 0, toSeq: 2,
    payload: {kind: 'snapshot', snapshot: {protocolVersion: 1, sessionId: 'id', logEpoch: 'e', seq: 2, revision: 1,
      rows: {window: rows, totalCount: 2, firstRowId: 90}, meta: {rowOrder: [90, 4], session: {id: 'id', status: 'running', pending: [], approved: {}},
        window: {start: 0, end: 2, total: 2, hasOlder: false, messageRevision: revision, prefixRevision: ''}}}}}};
}
function resumed(fromSeq: number, deltas: object[]) {
  return {ack: {subscriptionId: 'r', mode: 'resume', logEpoch: 'e'}, frame: {topic: 'conversation/id', subscriptionId: 'r',
    fromSeq, toSeq: fromSeq + deltas.length, payload: {kind: 'deltas', deltas}}};
}

test('runtime frames keep source order and reject gaps atomically', () => {
  const before = applyRuntimeConversationFrame(undefined, initial(), 'id');
  const meta = {...before.meta, rowOrder: [90, 4, 2], window: {...before.meta.window as object, total: 3, end: 3}};
  const after = applyRuntimeConversationFrame(before, resumed(2, [
    {op: 'row.upserted', row: {...before.rows.window[1], text: 'complete', state: 'complete'}},
    {op: 'row.appended', row: {rowId: 2, kind: 'userInput', turnId: 'turn-2', text: 'next', createdAtSeq: 3}},
    {op: 'state.updated', patch: {meta, revision: 2}},
  ]), 'id');
  assert.deepEqual(after.rows.window.map(row => row.rowId), [90, 4, 2]);
  assert.equal(before.rows.window[1].text, 'partial');
  assert.throws(() => applyRuntimeConversationFrame(after, resumed(2, []), 'id'), /cursor mismatch/);
  assert.throws(() => applyRuntimeConversationFrame(after, resumed(5, [{op: 'row.appended', row: after.rows.window[0]}]), 'id'), /Duplicate/);
  assert.equal(after.seq, 5);
  assert.throws(() => applyRuntimeConversationFrame(before, resumed(2, [{op: 'state.updated', patch: {rows: {order: []}}}]), 'id'), /Unsupported/);
});

test('one subscription read survives transport failure and stops without late publication', async () => {
  const calls: {body: object; signal: AbortSignal}[] = [];
  const updates: string[] = [];
  let rejectPending: ((error: Error) => void) | undefined;
  const client = startRuntimeConversation('id', state => updates.push(state.status), {
    subscribeVisibility: () => () => undefined, schedule: {setTimeout: () => 1, clearTimeout: () => undefined},
    request: async (body, signal) => {
      calls.push({body, signal});
      if (calls.length === 1) return initial();
      if (calls.length === 2) throw Object.assign(new Error('temporary'), {status: 503});
      return new Promise((_, reject) => {rejectPending = reject;});
    },
  });
  await client.refresh();
  await client.refresh();
  assert.deepEqual(updates, ['loading', 'ready', 'recovering']);
  const pending = client.refresh();
  assert.equal(client.refresh(), pending, 'manual refresh shares the pending request');
  assert.deepEqual((calls[2].body as {params: {base: object}}).params.base, {logEpoch: 'e', seq: 2});
  client.stop();
  assert.equal(calls[2].signal.aborted, true);
  rejectPending?.(new Error('aborted'));
  await pending;
  assert.equal(updates.at(-1), 'recovering', 'late response cannot update a switched conversation');
});

test('wire reasoning, outcomes and real tool output map once with guarded message actions', () => {
  const snapshot = applyRuntimeConversationFrame(undefined, initial(), 'id');
  snapshot.rows.window = [snapshot.rows.window[0],
    {rowId: 8, kind: 'reasoning', turnId: 'turn-1', text: 'thought', assistantResponseId: 'answer', createdAtSeq: 2},
    {rowId: 7, kind: 'toolCall', turnId: 'turn-1', toolCallId: 'call', toolName: 'read', subject: 'report.md',
      status: 'success', input: {path: 'report.md'}, result: {ok: true, output: 'recorded'}, createdAtSeq: 3},
    {...snapshot.rows.window[1], assistantResponseId: 'answer', messageIndex: 4, state: 'complete', createdAtSeq: 4}];
  snapshot.meta.outcomes = [{afterRowId: 4, verified: true, summary: 'partial', status: 'verified'}];
  const rows = runtimeConversationRows(snapshot);
  assert.deepEqual(rows.map(row => row.kind), ['user', 'tool', 'assistant', 'completion']);
  assert.deepEqual(rows.map(row => row.seq), [1, 3, 4, 4.5]);
  const answer = rows[2];
  assert.equal(answer.kind === 'assistant' && answer.reasoning, 'thought');
  assert.equal(answer.kind === 'assistant' && answer.messageRevision, revision);
  assert.deepEqual(rows[1].kind === 'tool' && rows[1].output, {ok: true, output: 'recorded'});
});
