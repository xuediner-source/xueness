import test from 'node:test';
import assert from 'node:assert/strict';
import { createConversationWatch, conversationWatchTopic, type ConversationWatchDelivery,
  type ConversationWatchResponse } from './conversationWatch';
import { startConversationTransport } from './conversationTransport';
import type { ConversationCursor } from './conversationProjectionStore';

const A = 'a'.repeat(32), B = 'b'.repeat(32), EPOCH = 'e'.repeat(32), CURSOR = '0123456789abcdef';

function scheduler() {
  let id = 0;
  const tasks = new Map<number, { callback: () => void; delay: number }>();
  return { setTimeout(callback: () => void, delay: number) { tasks.set(++id, { callback, delay }); return id; },
    clearTimeout(handle: unknown) { tasks.delete(handle as number); },
    get delays() { return [...tasks.values()].map(task => task.delay); },
    run(delay?: number) { const entry = [...tasks].find(([, task]) => delay === undefined || task.delay === delay);
      assert.ok(entry, `No scheduled task for ${delay}`);
      const [key, task] = entry; tasks.delete(key); task.callback(); } };
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

type Call = { path: string; query: URLSearchParams; signal: AbortSignal;
  reply: (value: ConversationWatchResponse) => void; fail: (error: unknown) => void };
function server() {
  const calls: Call[] = [];
  const request = (path: string, signal: AbortSignal) => {
    const pending = deferred<ConversationWatchResponse>();
    const url = new URL(path, 'http://127.0.0.1');
    calls.push({ path, query: url.searchParams, signal, reply: pending.resolve, fail: pending.reject });
    return pending.promise;
  };
  return { calls, request, last: () => calls[calls.length - 1] };
}
const body = (updates: unknown[] = [], errors: unknown[] = [], cursor = `${CURSOR}.5`) =>
  ({ status: 200, body: { schema: 'xueness.conversation-watch.v1', cursor, superseded: false, updates, errors } });
function subscriber(sessionId: string, base: ConversationCursor | null = null) {
  const deliveries: ConversationWatchDelivery[] = [];
  let fallbacks = 0;
  const value = { sessionId, base: () => base, deliver: (delivery: ConversationWatchDelivery) => { deliveries.push(delivery); },
    fallback: () => { fallbacks++; } };
  return { value, deliveries, get fallbacks() { return fallbacks; }, setBase(next: ConversationCursor | null) { base = next; } };
}
function hub(options: Partial<Parameters<typeof createConversationWatch>[0]> = {}) {
  const clock = scheduler();
  const host = server();
  const watch = createConversationWatch({ request: host.request, schedule: clock, clientId: 'window-test',
    subscribeVisibility: () => () => undefined, isOnline: () => true, isVisible: () => true, ...options });
  return { clock, host, watch };
}

test('one long poll carries every topic and routes envelopes and errors by index', async () => {
  // No time advances in this routing test, including between microtasks.
  const { host, watch } = hub({ now: () => 1000 });
  const a = subscriber(A), b = subscriber(B, { logEpoch: EPOCH, seq: 3 });
  watch.subscribe(a.value);
  watch.subscribe(b.value);
  await flush();
  assert.equal(host.calls.length, 1, 'both subscriptions share one request');
  const first = host.last();
  assert.equal(first.query.get('client'), 'window-test');
  assert.equal(first.query.get('wait'), '20000');
  assert.equal(first.query.get('pace'), '33');
  assert.equal(first.query.has('since'), false);
  assert.deepEqual(first.query.getAll('topic'), [A, `${B}.${EPOCH}.3`]);
  const envelope = { schema: 'xueness.conversation-transport.v1', topic: `conversation/${B}` };
  first.reply(body([{ index: 1, envelope }], [{ index: 0, topic: `conversation/${A}`, status: 404, error: 'session not found' }]));
  await flush();
  assert.deepEqual(b.deliveries, [{ kind: 'envelope', envelope }]);
  assert.deepEqual(a.deliveries, [{ kind: 'error', status: 404, message: 'session not found' }]);
  assert.equal(host.calls.length, 2);
  assert.equal(host.last().query.get('since'), `${CURSOR}.5`);
  assert.deepEqual(host.last().query.getAll('topic'), [`${B}.${EPOCH}.3`], 'the failed topic cools down');
  assert.equal(host.last().query.get('wait'), '500', 'the server returns when the topic may rejoin');
});

test('subscription changes restart the shared request and the last unsubscribe ends it', async () => {
  const { clock, host, watch } = hub();
  const a = subscriber(A), b = subscriber(B);
  const stopA = watch.subscribe(a.value)!;
  await flush();
  const first = host.last();
  const stopB = watch.subscribe(b.value)!;
  await flush();
  assert.equal(first.signal.aborted, true);
  assert.deepEqual(host.last().query.getAll('topic'), [A, B]);
  first.reply(body([{ index: 0, envelope: { late: true } }]));
  await flush();
  assert.deepEqual(a.deliveries, [], 'a reply that raced a restart is dropped');
  const second = host.last();
  stopB();
  await flush();
  assert.equal(second.signal.aborted, true);
  assert.deepEqual(host.last().query.getAll('topic'), [A]);
  const third = host.last();
  stopA();
  await flush();
  assert.equal(third.signal.aborted, true);
  assert.equal(host.calls.length, 3);
  assert.deepEqual(clock.delays, []);
  assert.equal(watch.requests(), 3);
});

test('a lost reply backs off and resumes from the unchanged bases and cursor', async () => {
  const { clock, host, watch } = hub();
  const a = subscriber(A, { logEpoch: EPOCH, seq: 7 });
  watch.subscribe(a.value);
  await flush();
  host.last().reply(body([], [], `${CURSOR}.9`));
  await flush();
  host.last().fail(new Error('network down'));
  await flush();
  assert.equal(a.deliveries.length, 1);
  assert.equal(a.deliveries[0].kind, 'failure');
  assert.deepEqual(clock.delays, [250]);
  clock.run(250); await flush();
  assert.deepEqual(host.last().query.getAll('topic'), [`${A}.${EPOCH}.7`]);
  assert.equal(host.last().query.get('since'), `${CURSOR}.9`);
  host.last().reply({ status: 502, body: null });
  await flush();
  assert.deepEqual(clock.delays, [500], 'consecutive failures back off further');
  clock.run(500); await flush();
  host.last().reply(body());
  await flush();
  assert.equal(host.calls.length, 5, 'success resets the backoff and polls again at once');
});

test('read deadlines cover a stalled reply and hidden windows ask for a slower pace', async () => {
  let visible = true, listener = () => undefined as void;
  const { clock, host, watch } = hub({ isVisible: () => visible, readMarginMs: 100,
    subscribeVisibility: next => { listener = next; return () => undefined; } });
  const a = subscriber(A);
  watch.subscribe(a.value);
  await flush();
  assert.deepEqual(clock.delays, [20100]);
  visible = false;
  listener();
  await flush();
  assert.equal(host.calls[0].signal.aborted, true);
  assert.equal(host.last().query.get('pace'), '1000');
  assert.equal(a.deliveries.length, 0, 'a deliberate restart is not a failure');
  clock.run(20100); await flush();
  assert.equal(host.last().signal.aborted, true);
  assert.equal(a.deliveries[0].kind, 'failure');
  assert.match((a.deliveries[0] as { error: Error }).error.message, /timed out/u);
});

test('an older host without the route moves every subscriber to polling once', async () => {
  for (const status of [400, 404, 405]) {
    const { clock, host, watch } = hub();
    const a = subscriber(A), b = subscriber(B);
    watch.subscribe(a.value);
    watch.subscribe(b.value);
    await flush();
    host.last().reply({ status, body: { error: 'not found' } });
    await flush();
    assert.deepEqual([a.fallbacks, b.fallbacks], [1, 1]);
    assert.equal(watch.isSupported(), false);
    assert.equal(watch.subscribe(subscriber(A).value), null);
    assert.equal(host.calls.length, 1);
    assert.deepEqual(clock.delays, []);
  }
});

test('403 reaches every subscriber and a busy host backs off before polling', async () => {
  const forbidden = hub();
  const a = subscriber(A);
  forbidden.watch.subscribe(a.value);
  await flush();
  forbidden.host.last().reply({ status: 403, body: { error: 'plugin disabled' } });
  await flush();
  assert.deepEqual(a.deliveries, [{ kind: 'error', status: 403, message: 'sessions disabled' }]);

  const { clock, host, watch } = hub();
  const b = subscriber(B);
  watch.subscribe(b.value);
  await flush();
  host.last().reply({ status: 503, body: { error: 'too many conversation watchers' } });
  await flush();
  assert.deepEqual(clock.delays, [250]);
  clock.run(); await flush();
  host.last().reply({ status: 503, body: {} });
  await flush();
  assert.deepEqual(clock.delays, [500]);
  clock.run(); await flush();
  host.last().reply({ status: 503, body: {} });
  await flush();
  assert.equal(b.fallbacks, 1);
  assert.equal(watch.isSupported(), false);
});

test('non-local ids poll, equal topics share a slot and topics beyond the server limit poll', async () => {
  const { host, watch } = hub();
  assert.equal(watch.subscribe(subscriber('session-a').value), null);
  const one = subscriber(A), two = subscriber(A);
  watch.subscribe(one.value);
  watch.subscribe(two.value);
  const extra = Array.from({ length: 16 }, (_, index) => subscriber(index.toString(16).padStart(32, 'c')));
  for (const item of extra) watch.subscribe(item.value);
  await flush();
  assert.equal(host.last().query.getAll('topic').length, 16);
  assert.equal(extra[15].fallbacks, 1);
  const envelope = { schema: 'xueness.conversation-transport.v1', frames: [{ value: 1 }] };
  host.last().reply(body([{ index: 0, envelope }]));
  await flush();
  const [first, second] = [one.deliveries[0], two.deliveries[0]] as { envelope: unknown }[];
  assert.deepEqual(first.envelope, envelope);
  assert.deepEqual(second.envelope, envelope);
  assert.notEqual(first.envelope, second.envelope, 'each projection store owns its copy');
  assert.equal(conversationWatchTopic(A, { logEpoch: 'not-hex', seq: 1 }), A);
});

test('malformed watch bodies are transient failures, never deliveries', async () => {
  const { clock, host, watch } = hub();
  const a = subscriber(A);
  watch.subscribe(a.value);
  await flush();
  host.last().reply({ status: 200, body: { schema: 'xueness.conversation-watch.v1', cursor: 'bad', superseded: false, updates: [], errors: [] } });
  await flush();
  assert.equal(a.deliveries.length, 1);
  assert.equal(a.deliveries[0].kind, 'failure');
  assert.deepEqual(clock.delays, [250]);
});

function snapshotFor(sessionId: string, content: string) {
  const status = 'running';
  return { session: { id: sessionId, status },
    journal: { id: sessionId, status, message_revision: `sha256:${'0'.repeat(64)}`, messages: [{ role: 'assistant', content }] },
    timeline: { schema: 'xueness.events.v1', protocolVersion: 1, sessionId, status,
      steps: 0, mode: 'agent', events: [], cursor: 0, nextCursor: 0, head: 0, hasMore: false } };
}
const envelopeSnapshot = (sessionId: string, seq: number, content: string) => ({
  schema: 'xueness.conversation-transport.v1', topic: `conversation/${sessionId}`, mode: 'snapshot', logEpoch: EPOCH, seq,
  frames: [{ kind: 'snapshot', logEpoch: EPOCH, fromSeq: 0, toSeq: seq, snapshot: snapshotFor(sessionId, content) }] });
const envelopeResume = (sessionId: string, fromSeq: number, value: string) => ({
  schema: 'xueness.conversation-transport.v1', topic: `conversation/${sessionId}`, mode: 'resume', logEpoch: EPOCH, seq: fromSeq + 1,
  frames: [{ kind: 'delta', logEpoch: EPOCH, fromSeq, toSeq: fromSeq + 1,
    operations: [{ op: 'append', path: ['journal', 'messages', 0, 'content'], value }] }] });

test('a watched transport reads its first snapshot directly, then applies pushed frames without polling', async () => {
  const { clock: hubClock, host, watch } = hub();
  const clock = scheduler();
  const paths: string[] = [];
  const accepted: string[] = [];
  const transport = startConversationTransport({ sessionId: A, schedule: clock, subscribeVisibility: () => () => undefined,
    watch, request: async path => { paths.push(path); return envelopeSnapshot(A, 2, 'hello'); },
    accept: value => accepted.push((value as ReturnType<typeof snapshotFor>).journal.messages[0].content) });
  await flush();
  assert.deepEqual(paths, [`/api/sessions/${A}/conversation-transport`]);
  assert.deepEqual(clock.delays, [], 'no per-session poll timer while watched');
  assert.deepEqual(host.last().query.getAll('topic'), [`${A}.${EPOCH}.2`]);
  host.last().reply(body([{ index: 0, envelope: envelopeResume(A, 2, ' world') }]));
  await flush();
  assert.deepEqual(accepted, ['hello', 'hello world']);
  assert.equal(transport.isConnected(), true);
  assert.deepEqual(host.last().query.getAll('topic'), [`${A}.${EPOCH}.3`], 'the next request resumes from the applied seq');
  // A gap discards the base: the next watch topic asks for a snapshot.
  host.last().reply(body([{ index: 0, envelope: envelopeResume(A, 5, ' corrupt') }]));
  await flush();
  assert.deepEqual(accepted, ['hello', 'hello world']);
  assert.equal(transport.isConnected(), true, 'the confirmed owner survives one resync');
  assert.deepEqual(host.last().query.getAll('topic'), [A]);
  host.last().reply(body([{ index: 0, envelope: envelopeSnapshot(A, 9, 'recovered') }]));
  await flush();
  assert.deepEqual(accepted, ['hello', 'hello world', 'recovered']);
  assert.equal(paths.length, 1, 'pushes never fall back to direct reads');
  host.last().reply(body([], [{ index: 0, topic: `conversation/${A}`, status: 404, error: 'session not found' }]));
  await flush();
  assert.equal(transport.isConnected(), false, '404 releases the transport');
  assert.deepEqual(hubClock.delays, []);
  assert.equal(host.calls.length, 4, 'the released topic is not watched again');
  transport.stop();
});

test('a watched transport polls when the host has no watch route', async () => {
  const { host, watch } = hub();
  const clock = scheduler();
  const paths: string[] = [];
  const transport = startConversationTransport({ sessionId: A, schedule: clock, subscribeVisibility: () => () => undefined,
    watch, request: async path => { paths.push(path); return envelopeSnapshot(A, 2, 'hello'); }, accept: () => undefined });
  await flush();
  host.last().reply({ status: 404, body: { error: 'session not found' } });
  await flush();
  assert.equal(paths.length, 2, 'fallback reads once at once');
  assert.deepEqual(clock.delays, [250], 'then polls at the visible cadence');
  clock.run(); await flush();
  assert.equal(paths.length, 3);
  assert.match(paths[2], /logEpoch=e{32}&seq=2$/u);
  transport.stop();
  assert.deepEqual(clock.delays, []);
});

test('stopping a watched transport before its first read ends never subscribes', async () => {
  const { host, watch } = hub();
  const pending = deferred<unknown>();
  const transport = startConversationTransport({ sessionId: A, schedule: scheduler(), subscribeVisibility: () => () => undefined,
    watch, request: () => pending.promise, accept: () => assert.fail('stopped transport published') });
  transport.stop();
  pending.resolve(envelopeSnapshot(A, 2, 'late'));
  await flush();
  assert.equal(host.calls.length, 0);
});
