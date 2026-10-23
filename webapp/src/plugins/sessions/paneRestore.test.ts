import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyPaneRestore, probePaneSession, paneRestoreAllowsWrites } from './paneRestore';
const binding = { scope: { workspaceRoot: '/a' }, sessionId: 'a' };
test('only exact successful identity and definitive absent HTTP statuses classify conclusively', () => {
  assert.deepEqual(classifyPaneRestore('a', 200, { id: 'a' }), { kind: 'present', status: 200 });
  for (const status of [404, 410]) assert.equal(classifyPaneRestore('a', status).kind, 'absent');
  for (const status of [201, 204, 301, 401, 403, 408, 429, 500, 503]) assert.equal(classifyPaneRestore('a', status).kind, 'unknown');
  for (const payload of [undefined, [], null, {}, { id: 'b' }, { sessions: [] }]) assert.equal(classifyPaneRestore('a', 200, payload).kind, 'unknown');
});
test('probe keeps 403/5xx/malformed/offline status and never infers deletion', async () => {
  const signal = new AbortController().signal;
  for (const status of [200, 403, 404, 410, 500]) {
    const calls: string[] = [];
    const result = await probePaneSession(binding, signal, (async (path: string) => {
      calls.push(path); return new Response('not json', { status });
    }) as typeof fetch);
    assert.deepEqual(calls, ['/api/sessions/a']);
    assert.equal(result.kind, status === 404 || status === 410 ? 'absent' : 'unknown');
    assert.equal(result.status, status);
  }
  assert.equal((await probePaneSession(binding, signal, (async () => { throw new Error('offline'); }) as typeof fetch)).kind, 'unknown');
});
test('remote and aborted probes make no local request', async () => {
  const abort = new AbortController(); abort.abort();
  let calls = 0;
  const fetcher = (async () => { calls++; return new Response('{}'); }) as typeof fetch;
  await probePaneSession(binding, abort.signal, fetcher);
  await probePaneSession({ ...binding, scope: { ...binding.scope, remoteConnectionId: 'ssh' } }, new AbortController().signal, fetcher);
  assert.equal(calls, 0);
});
test('explicit root mismatches cannot confirm a restored binding; legacy omitted roots remain valid', async () => {
  for (const [payload, kind] of [[{ id: 'a', root: '/a' }, 'present'], [{ id: 'a' }, 'present'],
    [{ id: 'a', root: null }, 'present'], [{ id: 'a', root: '/other' }, 'unknown'], [{ id: 'a', root: 2 }, 'unknown']] as const) {
    const result = await probePaneSession(binding, new AbortController().signal,
      (async () => new Response(JSON.stringify(payload))) as typeof fetch);
    assert.equal(result.kind, kind);
    if (kind === 'unknown') assert.deepEqual(result, { kind: 'unknown', status: 200, reason: 'scope-mismatch' });
  }
});
for (const phase of ['headers', 'body'] as const) {
  for (const cancellation of ['timeout', 'aborted'] as const) test(`${cancellation} settles noncooperative ${phase} and cleans up`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const owner = new AbortController();
    let requestSignal: AbortSignal | undefined;
    let finish!: (value: unknown) => void;
    const pending = new Promise(resolve => { finish = resolve; });
    const remove = t.mock.method(owner.signal, 'removeEventListener');
    const fetcher = (async (_url, init) => {
      requestSignal = init?.signal as AbortSignal;
      return phase === 'headers' ? pending : { status: 200, json: () => pending };
    }) as typeof fetch;
    const result = probePaneSession(binding, owner.signal, fetcher);
    await Promise.resolve();
    if (cancellation === 'timeout') t.mock.timers.tick(15000); else owner.abort();
    assert.deepEqual(await result, { kind: 'unknown', reason: cancellation });
    assert.equal(requestSignal?.aborted, true);
    assert.equal(remove.mock.callCount(), 1);
    finish(phase === 'headers' ? new Response('{"id":"a","root":"/a"}') : { id: 'a', root: '/a' });
    await Promise.resolve();
    assert.deepEqual(await result, { kind: 'unknown', reason: cancellation });
  });
}
test('successful probe removes abort listener and clears its deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const owner = new AbortController();
  const remove = t.mock.method(owner.signal, 'removeEventListener');
  let requestSignal: AbortSignal | undefined;
  assert.equal((await probePaneSession(binding, owner.signal, (async (_url, init) => {
    requestSignal = init?.signal as AbortSignal;
    return new Response('{"id":"a","root":"/a"}');
  }) as typeof fetch)).kind, 'present');
  t.mock.timers.tick(15000); owner.abort();
  assert.equal(requestSignal?.aborted, false);
  assert.equal(remove.mock.callCount(), 1);
});

test('restored writes wait for confirmed scoped presence, while drafts remain usable', () => {
  assert.equal(paneRestoreAllowsWrites(null, null), true);
  assert.equal(paneRestoreAllowsWrites('a', { kind: 'present', status: 200 }), true);
  for (const result of [null, { kind: 'unknown', reason: 'scope-mismatch' }, { kind: 'unknown', reason: 'timeout' }, { kind: 'absent', status: 404 }] as const)
    assert.equal(paneRestoreAllowsWrites('a', result), false);
});
