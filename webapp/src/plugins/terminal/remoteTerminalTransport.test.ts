import test from 'node:test';
import assert from 'node:assert/strict';
import { createRemoteTerminalTransport } from './remoteTerminalTransport';
const id = 'a'.repeat(32);

test('remote terminal operations remain scoped to their opened session', async () => {
  const calls: [string, Record<string, unknown>][] = [];
  const api = createRemoteTerminalTransport({ request: async (method, params) => {
    calls.push([method, params]);
    if (method === 'terminal/open') return { id, session_id: 'session' };
    return {ok: true};
  } });
  assert.equal(calls.length, 0);
  await assert.rejects(async () => api.input('foreign', 'pwd'));
  await api.open('session'); await api.input(id, 'pwd'); await api.close(id);
  assert.deepEqual(calls.map(c => c[0]), ['terminal/open', 'terminal/input', 'terminal/close']);
  assert.equal(calls[0][1].open, true);
  assert.equal(calls[1][1].sessionId, 'session');
});

test('lost open response recovers its exact receipt without retrying a spawn', async () => {
  let openId: unknown; const calls: string[] = [];
  const api = createRemoteTerminalTransport({ request: async (method, params) => {
    calls.push(method);
    if (method === 'terminal/open') { openId = params.openId; throw new Error('lost response'); }
    assert.equal(params.cleanupOpenId, openId);
    return { terminals: [{ id, session_id: 'session', openId }] };
  } });
  assert.deepEqual(await api.open('session'), { id, session_id: 'session', openId });
  assert.deepEqual(calls, ['terminal/open', 'terminal/list']);
});

test('lost open cannot adopt another opening and never falls back locally', async () => {
  let opens = 0;
  const api = createRemoteTerminalTransport({ request: async method => {
    if (method === 'terminal/open') { opens++; throw new Error('lost response'); }
    return { terminals: [{ id, session_id: 'session', openId: 'other' }] };
  } });
  await assert.rejects(api.open('session'), /lost response/);
  assert.equal(opens, 1);
});

test('bad server IDs cannot become terminal targets', async () => {
  const api = createRemoteTerminalTransport({ request: async () => ({ id: '../escape', session_id: 'session' }) });
  await assert.rejects(api.open('session'), /Invalid remote terminal owner/);
  await assert.rejects(async () => api.close('../escape'), /owner is unavailable/);
});

import { RemoteSessionAdapter } from '../remote/remoteSessionAdapter';
import { remoteConnections, type RemoteOwner } from '../remote/remoteConnectionStore';
import { TerminalSessionRegistry } from './terminalSessionRegistry';
function remoteFixture() {
  const owner: RemoteOwner = { connectionId: crypto.randomUUID(), generation: 'original-generation', digest: 'config', workspaceIdentity: 'workspace', state: 'connected', capabilities: { interactiveTerminals: true } };
  remoteConnections.publish(owner, []);
  return { owner, adapter: new RemoteSessionAdapter(owner) };
}
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

test('real adapter blocks deferred input and resize after tab close intent', async () => {
  const { adapter } = remoteFixture(), previous = globalThis.fetch;
  const gates: (() => void)[] = [], mutations: string[] = [];
  let deferred = false;
  globalThis.fetch = (async (path: string, init?: RequestInit) => {
    if (path === '/api/csrf') {
      if (deferred && gates.length < 2) await new Promise<void>(resolve => gates.push(resolve));
      return response({csrfToken: 'test'});
    }
    const body = JSON.parse(String(init?.body)); mutations.push(body.method);
    return response(body.method === 'terminal/open' ? { id, session_id: 'session' } : {ok: true});
  }) as typeof fetch;
  try {
    const api = createRemoteTerminalTransport(adapter);
    await api.open('session'); deferred = true;
    const input = assert.rejects(api.input(id, 'pwd'), /owner changed/);
    const resize = assert.rejects(api.resize(id, 80, 24), /owner changed/);
    await api.close(id);
    for (const release of gates) release();
    await Promise.all([input, resize]);
    assert.deepEqual(mutations, ['terminal/open', 'terminal/close']);
  } finally { globalThis.fetch = previous; }
});

test('closing connecting tab during deferred CSRF never spawns or runs recovery lookup', async () => {
  const { adapter } = remoteFixture(), previous = globalThis.fetch;
  let release!: () => void, started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const calls: string[] = [];
  globalThis.fetch = (async (path: string) => {
    calls.push(path);
    assert.equal(path, '/api/csrf');
    started(); await new Promise<void>(resolve => { release = resolve; });
    return response({ csrfToken: 'test' });
  }) as typeof fetch;
  try {
    const registry = new TerminalSessionRegistry(createRemoteTerminalTransport(adapter), async () => { throw new Error('No surface should be created'); });
    const opening = registry.create('remote-workspace', 'session');
    await entered; registry.close(registry.tabs('remote-workspace')[0]); release();
    assert.equal(await opening, undefined);
    assert.deepEqual(calls, ['/api/csrf']);
    assert.deepEqual(registry.tabs('remote-workspace'), []);
  } finally { globalThis.fetch = previous; }
});

test('real adapter 503 recovers exact opening then closes it after owner retirement', async () => {
  const { owner, adapter } = remoteFixture(), previous = globalThis.fetch;
  const calls: {method: string; params: Record<string, unknown>; expectedGeneration: string}[] = [];
  let openId: string | undefined, closed!: () => void;
  const closedRequest = new Promise<void>(resolve => { closed = resolve; });
  globalThis.fetch = (async (path: string, init?: RequestInit) => {
    if (path === '/api/csrf') return response({csrfToken: 'test'});
    const body = JSON.parse(String(init?.body)); calls.push(body);
    assert.equal(body.expectedGeneration, owner.generation);
    if (body.method === 'terminal/open') {
      openId = body.params.openId;
      return response({error: 'response unavailable after opening'}, 503);
    }
    if (body.method === 'terminal/list') {
      assert.equal(body.params.cleanupOpenId, openId);
      return response({terminals: [{id, session_id: 'session', openId}]});
    }
    assert.equal(body.method, 'terminal/close');
    assert.equal(body.params.terminalId, id); closed(); return response({ok: true});
  }) as typeof fetch;
  const registry = new TerminalSessionRegistry(createRemoteTerminalTransport(adapter), async () => { throw new Error('No surface should be created'); });
  const unsubscribe = adapter.subscribe(() => { if (!adapter.isCurrent()) registry.setEnabled(false); });
  try {
    assert.equal(await registry.create('workspace', 'session'), undefined);
    await closedRequest;
    assert.equal(remoteConnections.owner(owner.connectionId)?.state, 'disconnected');
    assert.deepEqual(calls.map(call => call.method), ['terminal/open', 'terminal/list', 'terminal/close']);
    assert.deepEqual(registry.tabs('workspace'), []);
  } finally { unsubscribe(); globalThis.fetch = previous; }
});

test('double-lost opening retains persisted exact cleanup intent until confirmed cancellation', async () => {
  let saved = '[]', openId: unknown, loseCleanup = true;
  const calls: string[] = [];
  const storage = { getItem: () => saved, setItem: (_key: string, value: string) => { saved = value; } };
  const adapter = { request: async (method: string, params: Record<string, unknown>) => {
    calls.push(method);
    if (method === 'terminal/open') { openId = params.openId; throw new Error('opening response lost'); }
    if (method === 'terminal/list') throw new Error('lookup lost');
    assert.equal(method, 'terminal/cancel-open'); assert.equal(params.openId, openId); assert.equal(params.sessionId, 'session');
    if (loseCleanup) throw new Error('cancellation response lost');
    return {ok: true, cancelled: true, openId, sessionId: 'session'};
  } };
  const original = createRemoteTerminalTransport(adapter, () => true, storage);
  await assert.rejects(original.open('session'), /opening response lost/);
  assert.equal(original.hasPendingCleanup?.(), true);
  const restored = createRemoteTerminalTransport(adapter, () => true, storage);
  assert.equal(restored.hasPendingCleanup?.(), true);
  await assert.rejects(restored.reconcilePending!(), /cancellation response lost/);
  assert.equal(restored.hasPendingCleanup?.(), true);
  loseCleanup = false; await restored.reconcilePending!();
  assert.equal(restored.hasPendingCleanup?.(), false); assert.equal(saved, '[]');
  assert.deepEqual(calls, ['terminal/open', 'terminal/list', 'terminal/cancel-open', 'terminal/cancel-open']);
});

test('empty opening lookup retains intent because cancellation can overtake admission', async () => {
  let openId: unknown;
  const api = createRemoteTerminalTransport({ request: async (method, params) => {
    if (method === 'terminal/open') { openId = params.openId; throw new Error('lost'); }
    if (method === 'terminal/list') return {terminals: []};
    return {ok: true, cancelled: true, openId, sessionId: params.sessionId};
  } });
  await assert.rejects(api.open('session'), /lost/);
  assert.equal(api.hasPendingCleanup?.(), true);
  await api.reconcilePending!();
  assert.equal(api.hasPendingCleanup?.(), false);
});

test('lost close response retains original opening cancellation without reopening', async () => {
  let originalId: unknown; const calls: string[] = [];
  const api = createRemoteTerminalTransport({ request: async (method, params) => {
    calls.push(method);
    if (method === 'terminal/open') { originalId = params.openId; return {id, session_id: 'session'}; }
    if (method === 'terminal/close') throw new Error('close response lost');
    assert.equal(method, 'terminal/cancel-open'); assert.equal(params.openId, originalId);
    return {ok: true, cancelled: true, openId: originalId, sessionId: 'session'};
  } });
  await api.open('session'); await assert.rejects(api.close(id), /close response lost/);
  assert.equal(api.hasPendingCleanup?.(), true);
  await api.reconcilePending!(); assert.equal(api.hasPendingCleanup?.(), false);
  assert.deepEqual(calls, ['terminal/open', 'terminal/close', 'terminal/cancel-open']);
});
