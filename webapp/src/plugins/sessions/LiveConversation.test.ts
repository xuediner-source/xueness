import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyConversationPatch, startConversationUpdates } from './LiveConversation';

test('projection patches retain text ordering and reject a stale or unsafe patch', () => {
  const original = { revision: 2, snapshot: { journal: { messages: [{ content: 'hello' }] } } };
  const next = applyConversationPatch(original, { baseRevision: 2, revision: 3, operations: [
    { op: 'append', path: ['journal', 'messages', 0, 'content'], value: ' world' },
    { op: 'append', path: ['journal', 'messages'], value: [{ content: 'next' }] },
  ] });
  assert.deepEqual(next.snapshot, { journal: { messages: [{ content: 'hello world' }, { content: 'next' }] } });
  assert.equal(original.snapshot.journal.messages[0].content, 'hello');
  assert.throws(() => applyConversationPatch(next, { baseRevision: 2, revision: 4, operations: [] }));
  assert.throws(() => applyConversationPatch(next, { baseRevision: 3, revision: 4, operations: [
    { op: 'set', path: ['__proto__', 'polluted'], value: true },
  ] }));
});

test('reconnect snapshot replaces the projection; disposed streams never publish', () => {
  const listeners = new Map<string, (event: MessageEvent<string>) => void>();
  let closed = 0; const received: unknown[] = []; const connected: boolean[] = [];
  const source = { addEventListener: (name: string, listener: (event: MessageEvent<string>) => void) => { listeners.set(name, listener); },
    close: () => { closed++; }, onerror: null as ((this: EventSource, ev: Event) => unknown) | null };
  const stop = startConversationUpdates('abc', value => received.push(value), value => connected.push(value), () => source);
  const emit = (name: string, data: unknown) => listeners.get(name)!({ data: JSON.stringify(data) } as MessageEvent);
  emit('conversation.snapshot', { revision: 1, snapshot: { value: 'a' } });
  emit('conversation.patch', { baseRevision: 1, revision: 2, operations: [{ op: 'append', path: ['value'], value: 'b' }] });
  source.onerror?.call(source as unknown as EventSource, {} as Event);
  emit('conversation.snapshot', { revision: 4, snapshot: { value: 'fresh' } });
  assert.deepEqual(received, [{ value: 'a' }, { value: 'ab' }, { value: 'fresh' }]);
  stop(); emit('conversation.snapshot', { revision: 5, snapshot: { value: 'stale' } });
  assert.equal(received.length, 3); assert.equal(closed, 1);
  assert.deepEqual(connected, [true, true, false, true]);
});
