import test from 'node:test';
import assert from 'node:assert/strict';
import { ConversationProjectionStore, CONVERSATION_TRANSPORT_SCHEMA } from './conversationProjectionStore';

function snapshot(content = 'hello', status = 'running') {
  return {
    session: { id: 'session-a', status },
    journal: { id: 'session-a', status, message_revision: `sha256:${'0'.repeat(64)}`, messages: [{ role: 'assistant', content }] },
    timeline: { schema: 'xueness.events.v1', protocolVersion: 1, sessionId: 'session-a', status,
      steps: 0, mode: 'agent', events: [], cursor: 0, nextCursor: 0, head: 0, hasMore: false },
  };
}
function response(mode: 'snapshot' | 'resume', logEpoch: string, seq: number, frames: unknown[]) {
  return { schema: CONVERSATION_TRANSPORT_SCHEMA, topic: 'conversation/session-a', mode, logEpoch, seq, frames };
}
function full(logEpoch = 'epoch-a', seq = 2, content = 'hello') {
  return {
    schema: CONVERSATION_TRANSPORT_SCHEMA,
    topic: 'conversation/session-a',
    mode: 'snapshot' as const,
    logEpoch,
    seq,
    frames: [{ kind: 'snapshot' as const, logEpoch, fromSeq: 0, toSeq: seq, snapshot: snapshot(content) }],
  };
}
function delta(fromSeq: number, toSeq: number, operations: unknown[] = [
  { op: 'append', path: ['journal', 'messages', 0, 'content'], value: ' world' },
], logEpoch = 'epoch-a') {
  return { kind: 'delta', logEpoch, fromSeq, toSeq, operations };
}

test('conversation topic applies complete snapshots and body/status deltas with one publish', () => {
  const store = new ConversationProjectionStore('session-a');
  assert.equal(store.getBase(), null);
  assert.equal(store.apply(full()).kind, 'applied');
  const published: unknown[] = [];
  const frames = [delta(2, 3), delta(3, 4, [
    { op: 'set', path: ['session', 'status'], value: 'completed' },
    { op: 'set', path: ['journal', 'status'], value: 'completed' },
    { op: 'set', path: ['timeline', 'status'], value: 'completed' },
  ])];
  assert.equal(store.apply(response('resume', 'epoch-a', 4, frames), value => published.push(value.snapshot)).kind, 'applied');
  assert.deepEqual(store.getProjection()?.snapshot, snapshot('hello world', 'completed'));
  assert.deepEqual(store.getBase(), { logEpoch: 'epoch-a', seq: 4 });
  assert.deepEqual(published, [snapshot('hello world', 'completed')]);
});

test('resume requires an applied base and an empty aligned response is a heartbeat', () => {
  const store = new ConversationProjectionStore('session-a');
  assert.equal(store.apply(response('resume', 'epoch-a', 0, [])).kind, 'resync');
  assert.equal(store.getProjection(), null);
  store.apply(full('epoch-a', 0));
  assert.equal(store.apply(response('resume', 'epoch-a', 0, [])).kind, 'unchanged');
  assert.deepEqual(store.getBase(), { logEpoch: 'epoch-a', seq: 0 });
  assert.equal(store.apply(response('resume', 'epoch-a', 1, [])).kind, 'resync', 'ACK alone cannot advance a watermark');
  assert.equal(store.getBase(), null);
});

test('future gaps and out-of-order frames discard the entire response and request a snapshot', () => {
  for (const frames of [[delta(3, 4)], [delta(2, 3), delta(4, 5)], [delta(3, 4), delta(2, 3)]]) {
    const store = new ConversationProjectionStore('session-a');
    store.apply(full());
    const previous = store.getProjection();
    let publishes = 0;
    assert.equal(store.apply(response('resume', 'epoch-a', frames.at(-1)!.toSeq, frames), () => { publishes++; }).kind, 'resync');
    assert.equal(store.getProjection(), previous, 'a valid prefix is never partially applied');
    assert.equal(store.getBase(), null);
    assert.equal(publishes, 0);
    assert.equal(store.apply(full('epoch-a', 5, 'rebased')).kind, 'applied');
    assert.deepEqual(store.getBase(), { logEpoch: 'epoch-a', seq: 5 });
  }
});

test('duplicate and late frames do not append text twice or roll back a newer snapshot', () => {
  const store = new ConversationProjectionStore('session-a');
  store.apply(full());
  store.apply(response('resume', 'epoch-a', 3, [delta(2, 3)]));
  const previous = store.getProjection();
  assert.equal(store.apply(response('resume', 'epoch-a', 3, [delta(2, 3)])).kind, 'unchanged');
  assert.equal(store.apply(full('epoch-a', 2, 'stale')).kind, 'unchanged');
  assert.equal(store.getProjection(), previous);
  assert.deepEqual(store.getProjection()?.snapshot, snapshot('hello world'));
  assert.equal(store.apply(response('resume', 'epoch-a', 4, [delta(2, 3), delta(3, 4)])).kind, 'applied');
  assert.deepEqual(store.getProjection()?.snapshot, snapshot('hello world world'));
});

test('an epoch-changing delta cannot contaminate state; a lower-sequence snapshot can replace generations', () => {
  const store = new ConversationProjectionStore('session-a');
  store.apply(full('epoch-a', 20));
  const previous = store.getProjection();
  assert.equal(store.apply(response('resume', 'epoch-b', 21, [delta(20, 21, [], 'epoch-b')])).kind, 'resync');
  assert.equal(store.getProjection(), previous);
  assert.equal(store.getBase(), null);
  assert.equal(store.apply(full('epoch-b', 1, 'new generation')).kind, 'applied');
  assert.deepEqual(store.getBase(), { logEpoch: 'epoch-b', seq: 1 });
  assert.deepEqual(store.getProjection()?.snapshot, snapshot('new generation'));
});

test('malformed operations, frame envelopes and projection invariants never leak a patched prefix', () => {
  const invalidOperations = [
    { op: 'append', path: ['missing', 'content'], value: 'bad' },
    { op: 'set', path: ['__proto__', 'polluted'], value: true },
    { op: 'set', path: ['journal', 'messages', 0.5], value: 'bad' },
    { op: 'set', path: ['session', 'status'], value: 'completed' },
    { op: 'set', path: ['session', 'id'], value: 'another-session' },
    { op: 'set', path: [], value: null },
    { op: 'append', path: ['journal', 'messages', 0, 'content'] },
  ];
  for (const operation of invalidOperations) {
    const store = new ConversationProjectionStore('session-a');
    store.apply(full());
    const previous = store.getProjection();
    assert.equal(store.apply(response('resume', 'epoch-a', 4, [delta(2, 3), delta(3, 4, [operation])])).kind, 'resync');
    assert.equal(store.getProjection(), previous);
    assert.deepEqual(store.getProjection()?.snapshot, snapshot());
  }
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test('invalid snapshot and consumer rejection keep the prior projection and deny resume', () => {
  const store = new ConversationProjectionStore('session-a');
  store.apply(full());
  const previous = store.getProjection();
  const invalid = full('epoch-b', 0);
  invalid.frames[0].snapshot.session.id = 'wrong-session';
  assert.equal(store.apply(invalid).kind, 'resync');
  assert.equal(store.getProjection(), previous);
  assert.equal(store.getBase(), null);
  assert.equal(store.apply(full('epoch-b', 0), () => { throw new Error('consumer rejected'); }).kind, 'resync');
  assert.equal(store.getProjection(), previous);
  assert.equal(store.getBase(), null);
});

test('mismatched topic/schema, envelope head and frame epoch force resync', () => {
  for (const mutate of [
    (value: ReturnType<typeof full>) => { value.topic = 'conversation/another-session'; },
    (value: ReturnType<typeof full>) => { (value as { schema: string }).schema = 'xueness.events.v1'; },
    (value: ReturnType<typeof full>) => { value.seq = 3; },
    (value: ReturnType<typeof full>) => { value.frames[0].logEpoch = 'other'; },
    (value: ReturnType<typeof full>) => { value.frames[0].fromSeq = 1; },
  ]) {
    const store = new ConversationProjectionStore('session-a');
    const value = full(); mutate(value);
    assert.equal(store.apply(value).kind, 'resync');
    assert.equal(store.getProjection(), null);
    assert.equal(store.getBase(), null);
  }
});
