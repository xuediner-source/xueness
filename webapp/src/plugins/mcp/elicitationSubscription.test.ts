import test from 'node:test';
import assert from 'node:assert/strict';
import { subscribeElicitation } from './elicitationSubscription';

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function fixture() {
  let shown = true;
  let listener: (() => void) | undefined;
  let released = false;
  const jobs = new Map<object, { fn: () => void; delay: number }>();
  const requests: { path: string; signal: AbortSignal; resolve: (body: unknown) => void; reject: (error: Error) => void }[] = [];
  const deliveries: unknown[] = [];
  const stop = subscribeElicitation({ sessionId: 'task', accept: value => deliveries.push(value),
    visible: () => shown,
    subscribeVisibility: fn => { listener = fn; return () => { listener = undefined; released = true; }; },
    schedule: {
      setTimeout: (fn, delay) => { const key = {}; jobs.set(key, { fn, delay }); return key; },
      clearTimeout: key => { jobs.delete(key as object); },
    },
    request: (path, signal) => new Promise((resolve, reject) => requests.push({ path, signal, resolve, reject })),
  });
  return { requests, deliveries, jobs, stop, refresh: stop.refresh, released: () => released,
    visibility(value: boolean) { shown = value; listener?.(); },
    run(delay: number) {
      const next = [...jobs].find(([, job]) => job.delay === delay);
      assert.ok(next, `expected timer ${delay}`);
      jobs.delete(next[0]); next[1].fn();
    },
  };
}

test('one idle long poll replaces repeated reads, with bounded fallback for older hosts', async () => {
  const f = fixture();
  assert.match(f.requests[0].path, /elicitation\?wait=20000$/);
  f.visibility(true);
  assert.equal(f.requests.length, 1);
  assert.deepEqual([...f.jobs.values()].map(job => job.delay), [30000]);
  f.requests[0].resolve({ pending: null });
  await flush();
  assert.deepEqual(f.deliveries, [{ pending: null }]);
  f.run(1200);
  assert.equal(f.requests.length, 2);
  f.stop();
});

test('hiding aborts the active read and leaves no background timer; showing reads immediately', async () => {
  const f = fixture();
  f.visibility(false);
  await flush();
  assert.equal(f.requests[0].signal.aborted, true);
  assert.equal(f.jobs.size, 0);
  f.requests[0].resolve({ pending: 'stale hidden response' });
  f.visibility(true);
  await flush();
  assert.equal(f.requests.length, 2);
  assert.deepEqual(f.deliveries, []);
  f.requests[1].resolve({ pending: 'current' });
  await flush();
  assert.deepEqual(f.deliveries, [{ pending: 'current' }]);
  f.stop();
});

test('unmount releases the request, listener and timers even when fetch ignores abort', async () => {
  const f = fixture();
  f.stop();
  f.requests[0].resolve({ pending: 'old session' });
  await flush();
  assert.equal(f.requests[0].signal.aborted, true);
  assert.equal(f.released(), true);
  assert.equal(f.jobs.size, 0);
  assert.deepEqual(f.deliveries, []);
});

test('refresh aborts an older read and ignores its late snapshot before reading current state', async () => {
  const f = fixture();
  f.refresh();
  await flush();
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[0].signal.aborted, true);
  f.requests[0].resolve({ pending: { id: 'stale' } });
  f.requests[1].resolve({ pending: { id: 'current' } });
  await flush();
  assert.deepEqual(f.deliveries, [{ pending: { id: 'current' } }]);
  f.stop();
});

test('transient read failures preserve the pending form and back off until a confirmed clear', async () => {
  const f = fixture();
  f.requests[0].resolve({ pending: { id: 7 } });
  await flush(); f.run(1200);
  f.requests[1].reject(new Error('network outage'));
  await flush();
  assert.deepEqual(f.deliveries, [{ pending: { id: 7 } }]);
  f.run(2400);
  f.requests[2].resolve({ pending: null });
  await flush();
  assert.deepEqual(f.deliveries, [{ pending: { id: 7 } }, { pending: null }]);
  f.run(1200);
  assert.equal(f.requests.length, 4);
  f.stop();
});

test('a stalled response body is bounded and late completion cannot replace the retry', async () => {
  const f = fixture();
  f.run(30000);
  await flush();
  assert.equal(f.requests[0].signal.aborted, true);
  f.run(2400);
  f.requests[0].resolve({ pending: 'late' });
  f.requests[1].resolve({ pending: 'fresh' });
  await flush();
  assert.deepEqual(f.deliveries, [{ pending: 'fresh' }]);
  f.stop();
});
