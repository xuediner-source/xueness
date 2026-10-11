import test from 'node:test';
import assert from 'node:assert/strict';
import { queueTurn, loadSession, sendTurn, createSession } from '../../xuenessWorkbench';

test('lost queue acknowledgement replays one identity and the same one-use context; a separate send has a new identity', async () => {
  const previous = globalThis.fetch;
  const bodies: Record<string, string>[] = [];
  globalThis.fetch = async (path, init) => {
    if (path === '/api/csrf') return Response.json({ csrfToken: 'fixture' });
    bodies.push(JSON.parse(String(init?.body)));
    if (bodies.length === 1) throw new TypeError('connection lost after acceptance');
    return Response.json({ id: 'queue-one', item: { id: 'queue-one', text: 'hello', status: 'queued', position: 1 } });
  };
  try {
    assert.equal((await queueTurn('session', 'hello', 'prepared')).ok, true);
    assert.equal(bodies.length, 2); assert.deepEqual(bodies[0], bodies[1]);
    assert.match(bodies[0].request_id, /^[a-f0-9]{32}$/u);
    await queueTurn('session', 'hello', 'prepared');
    assert.notEqual(bodies[1].request_id, bodies[2].request_id);
  } finally { globalThis.fetch = previous; }
});

test('ordinary turns and session creation keep ambiguous acceptance explicit and never auto-run or replay', async () => {
  const previous = globalThis.fetch;
  try {
    for (const action of [() => sendTurn('session', 'hello'), () => createSession('hello')]) {
      const mutations: string[] = [];
      globalThis.fetch = async path => {
        if (path === '/api/csrf') return Response.json({ csrfToken: 'fixture' });
        mutations.push(String(path)); throw new TypeError('connection lost after acceptance');
      };
      const result = await action();
      assert.equal(result.ok, false); assert.equal(result.outcomeUnknown, true);
      assert.equal(mutations.length, 1); assert.equal(mutations.some(path => path.endsWith('/run')), false);
    }
  } finally { globalThis.fetch = previous; }
});

test('refusing a queue replay cannot erase uncertainty about the original request', async () => {
  const previous = globalThis.fetch; let calls = 0;
  globalThis.fetch = async path => {
    if (path === '/api/csrf') return Response.json({ csrfToken: 'fixture' });
    if (++calls === 1) throw new TypeError('original response lost');
    return Response.json({ error: 'plugin disabled during retry' }, { status: 403 });
  };
  try { const result = await queueTurn('session', 'hello'); assert.equal(result.outcomeUnknown, true); assert.equal(calls, 2); }
  finally { globalThis.fetch = previous; }
});

test('a failed CSRF read is known unsent and does not trigger automatic queue replays', async () => {
  const previous = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; throw new TypeError('preflight unavailable'); };
  try { const result = await queueTurn('session', 'hello'); assert.equal(result.outcomeUnknown, undefined); assert.equal(calls, 1); }
  finally { globalThis.fetch = previous; }
});

test('queue permission/conflict errors are not replayed, and repeated transport failure is explicitly unconfirmed', async () => {
  const previous = globalThis.fetch;
  try {
    for (const status of [400, 403, 409, 503]) {
      let calls = 0;
      globalThis.fetch = async path => {
        if (path === '/api/csrf') return Response.json({ csrfToken: 'fixture' });
        calls++; return Response.json({ error: 'fixture refusal' }, { status });
      };
      const result = await queueTurn('session', 'hello');
      assert.equal(result.ok, false);
      assert.equal(calls, status === 503 ? 2 : 1);
      if (!result.ok && status === 503) assert.match(result.error, /无法确认|could not be confirmed/u);
    }
  } finally { globalThis.fetch = previous; }
});

test('switching sessions aborts the actual in-flight fetch even with a read deadline', async () => {
  const previous = globalThis.fetch;
  const controller = new AbortController();
  let attached = false;
  globalThis.fetch = async (_path, init) => new Promise((_resolve, reject) => {
    attached = true; init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
  });
  try {
    const result = loadSession('old', controller.signal);
    assert.equal(attached, true); controller.abort(new DOMException('switch', 'AbortError'));
    assert.deepEqual(await result, { ok: false, error: 'switch' });
  } finally { globalThis.fetch = previous; }
});
