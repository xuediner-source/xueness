import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationTransportPath, startConversationTransport, transportSubscriberId } from './conversationTransport';
import { paneSubscriptionIdentity } from './paneLayout';

function full(epoch = 'epoch-a', seq = 2, content = 'hello') {
  const status = 'running';
  const snapshot = { session: { id: 'session-a', status },
    journal: { id: 'session-a', status, message_revision: `sha256:${'0'.repeat(64)}`, messages: [{ role: 'assistant', content }] },
    timeline: { schema: 'xueness.events.v1', protocolVersion: 1, sessionId: 'session-a', status,
      steps: 0, mode: 'agent', events: [], cursor: 0, nextCursor: 0, head: 0, hasMore: false } };
  return { schema: 'xueness.conversation-transport.v1', topic: 'conversation/session-a', mode: 'snapshot',
    logEpoch: epoch, seq, frames: [{ kind: 'snapshot', logEpoch: epoch, fromSeq: 0, toSeq: seq, snapshot }] };
}
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
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const noVisibility = () => () => undefined;

test('HTTP subscription begins with a snapshot, resumes only its applied epoch/seq and slows hidden tabs', async () => {
  const clock = scheduler();
  const paths: string[] = [];
  const accepted: unknown[] = [];
  const transport = startConversationTransport({ sessionId: 'session-a', schedule: clock, subscribeVisibility: noVisibility,
    isVisible: () => false, request: async path => { paths.push(path); return full(); }, accept: value => accepted.push(value) });
  await flush();
  assert.deepEqual(paths, ['/api/sessions/session-a/conversation-transport']);
  assert.deepEqual(clock.delays, [5000]);
  assert.equal(transport.isConnected(), true);
  clock.run(); await flush();
  assert.deepEqual(paths, ['/api/sessions/session-a/conversation-transport', '/api/sessions/session-a/conversation-transport?logEpoch=epoch-a&seq=2']);
  assert.equal(accepted.length, 1, 'identical snapshots are not published again');
  transport.stop();
  assert.deepEqual(clock.delays, []);
});

test('gap or epoch-changing resume immediately requests an unbased snapshot without publishing bad text', async () => {
  for (const epoch of ['epoch-a', 'epoch-b']) {
    const clock = scheduler();
    const paths: string[] = [];
    const accepted: unknown[] = [];
    const transport = startConversationTransport({ sessionId: 'session-a', schedule: clock, subscribeVisibility: noVisibility,
      request: async path => {
        paths.push(path);
        if (paths.length === 1) return full();
        if (paths.length === 2) return { schema: 'xueness.conversation-transport.v1', topic: 'conversation/session-a', mode: 'resume',
          logEpoch: epoch, seq: 4, frames: [{ kind: 'delta', logEpoch: epoch, fromSeq: 3, toSeq: 4,
            operations: [{ op: 'append', path: ['journal', 'messages', 0, 'content'], value: 'corrupt' }] }] };
        return full(epoch, 1, 'recovered');
      }, accept: value => accepted.push(value) });
    await flush(); await transport.refresh();
    assert.deepEqual(paths, ['/api/sessions/session-a/conversation-transport',
      '/api/sessions/session-a/conversation-transport?logEpoch=epoch-a&seq=2', '/api/sessions/session-a/conversation-transport']);
    assert.equal(accepted.length, 2);
    assert.deepEqual(accepted[1], full(epoch, 1, 'recovered').frames[0].snapshot);
    assert.equal(transport.isConnected(), true);
    transport.stop();
  }
});

test('manual refreshes and scheduled reads never overlap and use the newest applied base', async () => {
  const clock = scheduler();
  const first = deferred<unknown>();
  const paths: string[] = [];
  let active = 0, maximum = 0;
  const transport = startConversationTransport({ sessionId: 'session-a', schedule: clock, subscribeVisibility: noVisibility,
    request: async path => {
      paths.push(path); active++; maximum = Math.max(maximum, active);
      try { return paths.length === 1 ? await first.promise : full(); }
      finally { active--; }
    }, accept: () => undefined });
  const a = transport.refresh(); const b = transport.refresh();
  clock.run();
  assert.equal(paths.length, 1);
  first.resolve(full());
  await Promise.all([a, b]); await flush();
  assert.equal(maximum, 1);
  assert.equal(paths.length, 2);
  assert.match(paths[1], /logEpoch=epoch-a&seq=2$/u);
  assert.deepEqual(clock.delays, [250]);
  transport.stop();
});

test('plugin disable prevents subscriptions and aborts/ignores a pending reply', async () => {
  const disabledClock = scheduler();
  let calls = 0, subscriptions = 0;
  const disabled = startConversationTransport({ sessionId: 'session-a', enabled: false, schedule: disabledClock,
    subscribeVisibility: () => { subscriptions++; return () => undefined; },
    request: async () => { calls++; return full(); }, accept: () => assert.fail('disabled publish') });
  await disabled.refresh();
  assert.equal(calls, 0); assert.equal(subscriptions, 0); assert.deepEqual(disabledClock.delays, []);
  disabled.stop();
  const clock = scheduler();
  const pending = deferred<unknown>();
  let signal: AbortSignal | undefined;
  const accepted: unknown[] = [];
  const transport = startConversationTransport({ sessionId: 'session-a', schedule: clock, subscribeVisibility: noVisibility,
    request: async (_, current) => { signal = current; calls++; return pending.promise; }, accept: value => accepted.push(value) });
  transport.stop();
  assert.equal(signal?.aborted, true);
  pending.resolve(full()); await flush(); await transport.refresh();
  assert.equal(calls, 1); assert.deepEqual(accepted, []); assert.deepEqual(clock.delays, []);
  assert.equal(transport.isConnected(), false);
});

test('effective state changing while a reply is pending cannot publish or schedule follow-ups', async () => {
  const clock = scheduler();
  const pending = deferred<unknown>();
  let enabled = true, calls = 0, signal: AbortSignal | undefined;
  const transport = startConversationTransport({ sessionId: 'session-a', schedule: clock, subscribeVisibility: noVisibility,
    isEnabled: () => enabled, request: async (_, current) => { calls++; signal = current; return pending.promise; },
    accept: () => assert.fail('a disabled session accepted stale response') });
  enabled = false;
  pending.resolve(full()); await flush();
  assert.equal(signal?.aborted, true);
  assert.deepEqual(clock.delays, []);
  await transport.refresh(); assert.equal(calls, 1);
});

test('HTTP errors release ownership and stop unsupported/forbidden endpoints from retrying', async () => {
  for (const error of ['HTTP 404', 'HTTP 403', 'network unavailable']) {
    const clock = scheduler();
    let calls = 0;
    const states: boolean[] = [];
    const transport = startConversationTransport({ sessionId: 'session-a', schedule: clock, subscribeVisibility: noVisibility,
      request: async () => { calls++; throw new Error(error); }, accept: () => assert.fail('failure publish'),
      connected: value => states.push(value) });
    await flush(); await transport.refresh();
    assert.equal(calls, 1); assert.equal(transport.isConnected(), false); assert.deepEqual(clock.delays, []);
    assert.equal(states.at(-1), false);
  }
});

test('two malformed snapshots terminate recovery and never advertise an applied watermark', async () => {
  const clock = scheduler();
  const paths: string[] = [];
  const states: boolean[] = [];
  const transport = startConversationTransport({ sessionId: 'session-a', schedule: clock, subscribeVisibility: noVisibility,
    request: async path => { paths.push(path); const result = full(); result.frames[0].snapshot.session.id = 'other'; return result; },
    accept: () => assert.fail('invalid snapshot publish'), connected: value => states.push(value) });
  await flush();
  assert.deepEqual(paths, ['/api/sessions/session-a/conversation-transport', '/api/sessions/session-a/conversation-transport']);
  assert.equal(states.includes(true), false);
  assert.equal(transport.isConnected(), false);
  assert.deepEqual(clock.delays, []);
});

test('ownership and epoch are available synchronously before the consumer receives text', async () => {
  const clock = scheduler();
  let owned = false, epoch: string | null = null;
  const transport = startConversationTransport({ sessionId: 'session-a', schedule: clock, subscribeVisibility: noVisibility,
    request: async () => full('epoch-b', 0), connected: (value, nextEpoch) => { owned = value; epoch = nextEpoch; },
    accept: () => { assert.equal(owned, true); assert.equal(epoch, 'epoch-b'); } });
  await flush();
  transport.stop();
  assert.equal(owned, false); assert.equal(epoch, null);
});

test('session IDs and epoch resume parameters are encoded without changing the watermarks', () => {
  assert.equal(conversationTransportPath('a/b', { logEpoch: 'epoch +&', seq: 7 }),
    '/api/sessions/a%2Fb/conversation-transport?logEpoch=epoch+%2B%26&seq=7');
});

test('a confirmed primary resumes a lost response from its applied cursor and publishes the complete replay once', async () => {
  const clock = scheduler();
  const paths: string[] = [];
  const accepted: unknown[] = [];
  const states: boolean[] = [];
  const firstDelta = { kind: 'delta', logEpoch: 'epoch-a', fromSeq: 2, toSeq: 3,
    operations: [{ op: 'append', path: ['journal', 'messages', 0, 'content'], value: ' missed' }] };
  const replay = { schema: 'xueness.conversation-transport.v1', topic: 'conversation/session-a', mode: 'resume',
    logEpoch: 'epoch-a', seq: 4, frames: [firstDelta, {
      kind: 'delta', logEpoch: 'epoch-a', fromSeq: 3, toSeq: 4, operations: [
        { op: 'append', path: ['journal', 'messages', 0, 'content'], value: ' recovered' },
        ...['session', 'journal', 'timeline'].map(key => ({ op: 'set', path: [key, 'status'], value: 'completed' })),
      ],
    }] };
  const transport = startConversationTransport({ sessionId: 'session-a', schedule: clock, subscribeVisibility: noVisibility,
    request: async path => {
      paths.push(path);
      if (paths.length === 1) return full();
      if (paths.length === 2) throw new TypeError('Failed to fetch: response lost');
      return replay;
    }, connected: value => states.push(value), accept: value => accepted.push(value) });
  await flush();
  clock.run(); await flush();
  assert.equal(transport.isConnected(), true, 'a confirmed owner excludes legacy updates during recovery');
  assert.equal(states.slice(1).every(Boolean), true);
  assert.equal(accepted.length, 1, 'an undelivered response cannot advance the applied projection');
  clock.run(); await flush();
  assert.deepEqual(paths.slice(1), Array(2).fill('/api/sessions/session-a/conversation-transport?logEpoch=epoch-a&seq=2'));
  assert.equal(accepted.length, 2, 'all missed frames publish atomically');
  const expected = full('epoch-a', 4, 'hello missed recovered').frames[0].snapshot;
  expected.session.status = expected.journal.status = expected.timeline.status = 'completed';
  assert.deepEqual(accepted[1], expected);
  clock.run(); await flush();
  assert.match(paths.at(-1)!, /logEpoch=epoch-a&seq=4$/u);
  assert.equal(accepted.length, 2, 'replayed duplicate frames do not append the answer again');
  transport.stop();
});

test('reconnect lets the server replace a retired epoch with a lower-sequence snapshot', async () => {
  const clock = scheduler();
  const paths: string[] = [];
  const accepted: unknown[] = [];
  const transport = startConversationTransport({ sessionId: 'session-a', schedule: clock, subscribeVisibility: noVisibility,
    request: async path => {
      paths.push(path);
      if (paths.length === 1) return full('epoch-a', 20, 'old turn');
      if (paths.length === 2) throw new Error('connection reset');
      return full('epoch-b', 1, 'new turn');
    }, accept: value => accepted.push(value) });
  await flush();
  clock.run(); await flush();
  clock.run(); await flush();
  assert.deepEqual(paths.slice(1), Array(2).fill('/api/sessions/session-a/conversation-transport?logEpoch=epoch-a&seq=20'));
  assert.deepEqual(accepted, [full('epoch-a', 20, 'old turn').frames[0].snapshot, full('epoch-b', 1, 'new turn').frames[0].snapshot]);
  clock.run(); await flush();
  assert.match(paths.at(-1)!, /logEpoch=epoch-b&seq=1$/u);
  transport.stop();
});

test('queued refreshes during a disconnect wait for the next poll instead of retrying in a tight loop', async () => {
  const clock = scheduler();
  let reject!: (error: Error) => void;
  const pending = new Promise<unknown>((_, fail) => { reject = fail; });
  const paths: string[] = [];
  const transport = startConversationTransport({ sessionId: 'session-a', schedule: clock, subscribeVisibility: noVisibility,
    request: async path => { paths.push(path); return paths.length === 2 ? pending : full(); }, accept: () => undefined });
  await flush();
  clock.run(); await flush();
  const first = transport.refresh();
  const second = transport.refresh();
  reject(new Error('response lost'));
  await Promise.all([first, second]); await flush();
  assert.equal(paths.length, 2, 'failed reads cannot drain queued refreshes into immediate network retries');
  assert.equal(transport.isConnected(), true);
  assert.deepEqual(clock.delays, [250]);
  clock.run(); await flush();
  assert.equal(paths.length, 3);
  assert.equal(paths[2], paths[1], 'the scheduled retry retains the last applied cursor');
  transport.stop();
});

test('a confirmed subscription with repeated malformed recovery snapshots releases ownership without retrying its old cursor', async () => {
  const clock = scheduler();
  const paths: string[] = [];
  const accepted: unknown[] = [];
  const transport = startConversationTransport({ sessionId: 'session-a', schedule: clock, subscribeVisibility: noVisibility,
    request: async path => {
      paths.push(path);
      const payload = full('epoch-a', paths.length === 1 ? 2 : 3);
      if (paths.length > 1) payload.frames[0].snapshot.session.id = 'wrong-session';
      return payload;
    }, accept: value => accepted.push(value) });
  await flush();
  clock.run(); await flush();
  assert.deepEqual(paths, ['/api/sessions/session-a/conversation-transport',
    '/api/sessions/session-a/conversation-transport?logEpoch=epoch-a&seq=2', '/api/sessions/session-a/conversation-transport']);
  assert.deepEqual(accepted, [full().frames[0].snapshot]);
  assert.equal(transport.isConnected(), false);
  assert.deepEqual(clock.delays, []);
});

test('consecutive reconnect failures are bounded and a successful heartbeat resets the failure count', async () => {
  const clock = scheduler();
  let fail = false, calls = 0;
  const transport = startConversationTransport({ sessionId: 'session-a', schedule: clock, subscribeVisibility: noVisibility,
    request: async () => { calls++; if (fail) throw new Error('network unavailable'); return full(); }, accept: () => undefined });
  await flush();
  fail = true;
  for (let count = 0; count < 7; count++) { clock.run(); await flush(); assert.equal(transport.isConnected(), true); }
  fail = false; clock.run(); await flush();
  fail = true;
  for (let count = 0; count < 7; count++) { clock.run(); await flush(); assert.equal(transport.isConnected(), true); }
  clock.run(); await flush();
  assert.equal(transport.isConnected(), false, 'the eighth consecutive failure releases legacy fallback ownership');
  assert.deepEqual(clock.delays, []);
  const stoppedCalls = calls;
  await transport.refresh();
  assert.equal(calls, stoppedCalls);
});

test('disabling sessions during a reconnect aborts and ignores its late replay', async () => {
  const clock = scheduler();
  const pending = deferred<unknown>();
  let enabled = true, calls = 0, signal: AbortSignal | undefined;
  const accepted: unknown[] = [];
  const transport = startConversationTransport({ sessionId: 'session-a', schedule: clock, subscribeVisibility: noVisibility,
    isEnabled: () => enabled, request: async (_, current) => {
      calls++;
      if (calls === 1) return full();
      if (calls === 2) throw new Error('connection reset');
      signal = current; return pending.promise;
    }, accept: value => accepted.push(value) });
  await flush();
  clock.run(); await flush();
  clock.run(); await flush();
  enabled = false;
  await transport.refresh();
  assert.equal(signal?.aborted, true);
  assert.deepEqual(clock.delays, []);
  pending.resolve(full('epoch-a', 10, 'late replay')); await flush();
  assert.deepEqual(accepted, [full().frames[0].snapshot]);
  assert.equal(transport.isConnected(), false);
  await transport.refresh(); assert.equal(calls, 3);
});

test('real HTTP 403/404 with detailed JSON errors stop a confirmed subscription immediately', async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const status of [403, 404]) {
      const clock = scheduler();
      let calls = 0;
      globalThis.fetch = async () => {
        calls++;
        return new Response(JSON.stringify(calls === 1 ? full() : { error: status === 403
          ? 'plugin disabled or dependency unavailable: sessions' : 'session not found' }), {
          status: calls === 1 ? 200 : status, headers: { 'Content-Type': 'application/json' },
        });
      };
      const transport = startConversationTransport({ sessionId: 'session-a', schedule: clock, subscribeVisibility: noVisibility,
        accept: () => undefined });
      await flush();
      assert.equal(transport.isConnected(), true);
      clock.run(); await flush();
      assert.equal(transport.isConnected(), false);
      assert.deepEqual(clock.delays, []);
      await transport.refresh(); assert.equal(calls, 2);
    }
  } finally { globalThis.fetch = originalFetch; }
});

test('pane subscribers keep separate identities and one failure does not stop the other', async () => {
  const primaryId = paneSubscriptionIdentity('primary', 'session-a');
  const secondaryId = paneSubscriptionIdentity('secondary', 'session-b');
  assert.equal(primaryId, 'sessions.pane:primary:session-a');
  assert.equal(secondaryId, 'sessions.pane:secondary:session-b');
  assert.equal(transportSubscriberId(primaryId, 'session-a'), primaryId);
  assert.equal(transportSubscriberId(secondaryId, 'session-a'), 'session:session-a');
  const primaryClock = scheduler();
  const secondaryClock = scheduler();
  const paths: string[] = [];
  let primaryCalls = 0;
  let secondaryCalls = 0;
  const primary = startConversationTransport({ sessionId: 'session-a', subscriberId: primaryId, schedule: primaryClock,
    subscribeVisibility: noVisibility, request: async path => { primaryCalls++; paths.push(path); return full(); }, accept: () => undefined });
  const secondary = startConversationTransport({ sessionId: 'session-b', subscriberId: secondaryId, retryOnError: true,
    schedule: secondaryClock, subscribeVisibility: noVisibility,
    request: async path => { secondaryCalls++; paths.push(path); throw new Error('network unavailable'); }, accept: () => assert.fail('failed pane published') });
  await flush();
  assert.equal(primary.subscriberId, primaryId);
  assert.equal(secondary.subscriberId, secondaryId);
  assert.equal(primary.isConnected(), true);
  assert.equal(secondary.isConnected(), false);
  assert.deepEqual(paths.filter(path => path.startsWith('/api/sessions/session-a')), ['/api/sessions/session-a/conversation-transport']);
  assert.equal(paths.some(path => path.includes('subscriber')), false);
  assert.ok(secondaryClock.delays.length > 0);
  secondary.stop();
  assert.deepEqual(secondaryClock.delays, []);
  assert.equal(primary.isConnected(), true);
  primaryClock.run();
  await flush();
  assert.equal(primaryCalls, 2);
  assert.equal(secondaryCalls, 1);
  primary.stop();
});

test('a pane that receives 404 releases only its own subscriber', async () => {
  const clock = scheduler();
  const other = scheduler();
  const kept = startConversationTransport({ sessionId: 'session-a', subscriberId: paneSubscriptionIdentity('primary', 'session-a'),
    schedule: other, subscribeVisibility: noVisibility, request: async () => full(), accept: () => undefined });
  const dropped = startConversationTransport({ sessionId: 'session-b', subscriberId: paneSubscriptionIdentity('secondary', 'session-b'),
    retryOnError: true, schedule: clock, subscribeVisibility: noVisibility,
    request: async () => { throw new Error('HTTP 404'); }, accept: () => assert.fail('missing session published') });
  await flush();
  assert.equal(dropped.isConnected(), false);
  assert.deepEqual(clock.delays, []);
  assert.equal(kept.isConnected(), true);
  assert.ok(other.delays.length > 0);
  dropped.stop();
  kept.stop();
});


test('header and body deadlines abort hung reads, preserve the applied cursor and ignore late success', async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const stage of ['headers', 'body']) {
      const clock = scheduler();
      const pending = deferred<unknown>();
      const paths: string[] = [];
      const signals: AbortSignal[] = [];
      const accepted: unknown[] = [];
      globalThis.fetch = async (path, options) => {
        paths.push(String(path)); signals.push(options!.signal as AbortSignal);
        if (paths.length === 2) return stage === 'headers' ? pending.promise as Promise<Response>
          : { status: 200, ok: true, json: () => pending.promise } as Response;
        return new Response(JSON.stringify(full('epoch-a', paths.length === 1 ? 2 : 3, paths.length === 1 ? 'hello' : 'recovered')));
      };
      const transport = startConversationTransport({ sessionId: 'session-a', schedule: clock,
        subscribeVisibility: noVisibility, readTimeoutMs: 1000, accept: value => accepted.push(value) });
      await flush(); await flush();
      assert.equal(transport.isConnected(), true);
      assert.deepEqual(clock.delays, [250], 'successful bodies clear their deadlines');
      clock.run(250); await flush();
      const refresh = transport.refresh();
      clock.run(1000); await refresh; await flush();
      assert.equal(signals[1].aborted, true, stage);
      assert.equal(transport.isConnected(), true);
      assert.equal(paths.length, 2, 'a timeout cannot drain queued refreshes into a tight retry');
      assert.deepEqual(clock.delays, [250]);
      clock.run(250); await flush(); await flush();
      assert.equal(paths[2], paths[1], 'only the last applied cursor is resumed');
      assert.match(paths[2], /seq=2$/u);
      assert.equal(accepted.length, 2);
      pending.resolve(stage === 'headers' ? new Response(JSON.stringify(full('epoch-a', 99, 'stale')))
        : full('epoch-a', 99, 'stale'));
      await flush(); await flush();
      assert.equal(accepted.length, 2, 'a timed-out response never advances or republishes its fetched watermark');
      clock.run(250); await flush(); await flush();
      assert.match(paths[3], /seq=3$/u);
      transport.stop();
      assert.deepEqual(clock.delays, []);
    }
  } finally { globalThis.fetch = originalFetch; }
});

test('read deadlines follow initial retry policy and eight consecutive timeouts release established ownership', async () => {
  for (const mode of ['initial', 'retry-initial', 'established']) {
    const clock = scheduler();
    let calls = 0;
    const signals: AbortSignal[] = [];
    const transport = startConversationTransport({ sessionId: 'session-a', schedule: clock,
      subscribeVisibility: noVisibility, readTimeoutMs: 1000, retryOnError: mode === 'retry-initial',
      request: async (_, signal) => {
        signals.push(signal); calls++;
        if (mode === 'established' && calls === 1) return full();
        return new Promise(() => undefined);
      }, accept: () => undefined });
    await flush();
    if (mode === 'established') { clock.run(250); await flush(); }
    const failures = mode === 'initial' ? 1 : 8;
    for (let i = 0; i < failures; i++) {
      clock.run(1000); await flush();
      assert.equal(signals.at(-1)!.aborted, true);
      if (i < failures - 1) {
        assert.equal(transport.isConnected(), mode === 'established');
        clock.run(250); await flush();
      }
    }
    assert.equal(transport.isConnected(), false);
    assert.deepEqual(clock.delays, []);
    await transport.refresh();
    assert.equal(calls, failures + (mode === 'established' ? 1 : 0));
  }
});

test('disposing a non-cooperative read settles refreshes and removes its deadline and abort listener', async () => {
  const clock = scheduler();
  const pending = deferred<unknown>();
  let added = 0, removed = 0, calls = 0;
  const add = AbortSignal.prototype.addEventListener;
  const remove = AbortSignal.prototype.removeEventListener;
  AbortSignal.prototype.addEventListener = function (...args: Parameters<typeof add>) {
    if (args[0] === 'abort') added++;
    return add.apply(this, args);
  };
  AbortSignal.prototype.removeEventListener = function (...args: Parameters<typeof remove>) {
    if (args[0] === 'abort') removed++;
    return remove.apply(this, args);
  };
  try {
    const states: boolean[] = [];
    const transport = startConversationTransport({ sessionId: 'session-a', schedule: clock,
      subscribeVisibility: noVisibility, request: async () => { calls++; return pending.promise; },
      connected: value => states.push(value), accept: () => assert.fail('disposed publish') });
    const refresh = transport.refresh();
    transport.stop(); transport.stop();
    await refresh; await flush();
    assert.deepEqual(clock.delays, []);
    assert.equal(added, 1); assert.equal(removed, added);
    assert.deepEqual(states, [false, false], 'stop publishes disconnection only once');
    await transport.refresh(); assert.equal(calls, 1);
    pending.resolve(full()); await flush();
    assert.deepEqual(states, [false, false]);
  } finally {
    AbortSignal.prototype.addEventListener = add;
    AbortSignal.prototype.removeEventListener = remove;
  }
});

test('a retired transport late reply cannot clear a replacement transport shared ownership', async () => {
  const pending = deferred<unknown>();
  const firstClock = scheduler(), secondClock = scheduler();
  let owned = false, epoch: string | null = null;
  const connected = (value: boolean, nextEpoch: string | null) => { owned = value; epoch = nextEpoch; };
  const old = startConversationTransport({ sessionId: 'session-a', schedule: firstClock,
    subscribeVisibility: noVisibility, request: async () => pending.promise, connected,
    accept: () => assert.fail('retired transport published') });
  old.stop();
  const replacement = startConversationTransport({ sessionId: 'session-a', schedule: secondClock,
    subscribeVisibility: noVisibility, request: async () => full('epoch-b'), connected, accept: () => undefined });
  await flush();
  assert.equal(owned, true); assert.equal(epoch, 'epoch-b');
  pending.resolve(full()); await flush();
  old.stop();
  assert.equal(owned, true); assert.equal(epoch, 'epoch-b');
  assert.equal(replacement.isConnected(), true);
  replacement.stop();
});

test('disabling during a hung read deadline cannot retry or retain ownership', async () => {
  const clock = scheduler();
  let enabled = true, calls = 0;
  const transport = startConversationTransport({ sessionId: 'session-a', schedule: clock,
    subscribeVisibility: noVisibility, isEnabled: () => enabled, retryOnError: true, readTimeoutMs: 1000,
    request: async () => { calls++; return new Promise(() => undefined); }, accept: () => assert.fail('disabled publish') });
  enabled = false;
  clock.run(1000); await flush();
  assert.deepEqual(clock.delays, []);
  assert.equal(transport.isConnected(), false);
  await transport.refresh(); assert.equal(calls, 1);
});

test('four generalized subscribers isolate stop, plugin disable and late scope replies', async () => {
  const { paneSubscriberId } = await import('./paneIdentity');
  const enabled = [true, true, true, true];
  const published = [0, 0, 0, 0];
  const replies = enabled.map(() => deferred<unknown>());
  const clocks = enabled.map(() => scheduler());
  const transports = enabled.map((_, i) => startConversationTransport({ sessionId: 'session-a',
    subscriberId: paneSubscriberId({ groupId: 'g', paneId: `pane-${i}`, bindingRevision: 0,
      scope: { workspaceRoot: `/workspace-${i}` }, sessionId: 'session-a' }),
    isEnabled: () => enabled[i], schedule: clocks[i], subscribeVisibility: noVisibility,
    request: () => replies[i].promise, accept: () => { published[i]++; },
  }));
  assert.equal(new Set(transports.map(item => item.subscriberId)).size, 4);
  transports[0].stop(); transports[0].stop(); enabled[1] = false;
  replies.forEach(reply => reply.resolve(full())); await flush();
  assert.deepEqual(published, [0, 0, 1, 1]);
  assert.deepEqual(transports.map(item => item.isConnected()), [false, false, true, true]);
  transports.forEach(item => item.stop());
  clocks.forEach(clock => assert.deepEqual(clock.delays, []));
});
