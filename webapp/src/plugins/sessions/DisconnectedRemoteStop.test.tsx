import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { DisconnectedRemoteStop, disconnectedStopTurn, submitDisconnectedStop, type DisconnectedStopTarget } from './DisconnectedRemoteStop';
import { RemoteSessionAdapter } from '../remote/remoteSessionAdapter';
import { remoteConnections, type RemoteOwner } from '../remote/remoteConnectionStore';
import type { WorkbenchSession } from '../../xuenessWorkbench';

function target(id: string): DisconnectedStopTarget {
  const owner: RemoteOwner = { connectionId: id, generation: 'g', digest: 'd', workspaceIdentity: '/remote', state: 'connected', capabilities: { durableCommands: true } };
  remoteConnections.publish(owner, []);
  const adapter = new RemoteSessionAdapter(owner, () => true);
  remoteConnections.disconnect(id);
  return { enabled: true, adapter, identity: { groupId: 'g', paneId: 'p', bindingRevision: 1,
    scope: { workspaceRoot: '/remote', workspaceIdentity: '/remote', remoteConnectionId: id }, sessionId: 's' },
    session: { id: 's', status: 'running', active_turn_id: 'turn' } as WorkbenchSession };
}

test('disconnected retained snapshot offers explicit fenced Stop without render requests', () => {
  const value = target('stop-ui');
  assert.equal(disconnectedStopTurn(value), 'turn');
  assert.match(renderToStaticMarkup(<DisconnectedRemoteStop {...value} />), /<button/);
  for (const stale of [{ ...value, enabled: false }, { ...value, session: { ...value.session, active_turn_id: null } },
    { ...value, identity: { ...value.identity, sessionId: 'other' } },
    { ...value, identity: { ...value.identity, scope: { ...value.identity.scope, workspaceIdentity: '/other' } } }]) {
    assert.equal(disconnectedStopTurn(stale), null);
    assert.equal(renderToStaticMarkup(<DisconnectedRemoteStop {...stale} />), '');
  }
  remoteConnections.publish({ ...value.adapter.owner, generation: 'replacement', state: 'disconnected' }, []);
  assert.equal(disconnectedStopTurn(value), null);
});

test('disconnected Stop dispatches only a turn-fenced command and never reads or falls back', async () => {
  const value = target('stop-dispatch');
  const original = globalThis.fetch;
  const calls: Record<string, unknown>[] = [];
  globalThis.fetch = (async (path: string, init?: RequestInit) => {
    if (path === '/api/csrf') return new Response(JSON.stringify({ csrfToken: 'test' }));
    assert.equal(path, '/api/remote/stop-dispatch/request');
    const body = JSON.parse(String(init?.body)); calls.push(body);
    const params = body.params;
    assert.equal(body.expectedGeneration, 'g'); assert.equal(body.expectedDigest, 'd');
    assert.equal(body.method, 'command/execute'); assert.equal(params.type, 'stop');
    assert.deepEqual(params.payload, { expected_turn_id: 'turn' });
    return new Response(JSON.stringify({ commandId: params.commandId, status: 'accepted', result: { stopping: true } }));
  }) as typeof fetch;
  try {
    await submitDisconnectedStop(value, () => true);
    assert.equal(calls.length, 1);
    await assert.rejects(submitDisconnectedStop(value, () => false), /unavailable/);
    await assert.rejects(value.adapter.request('session/read', { sessionId: 's' }), /unavailable/);
    await assert.rejects(value.adapter.createCommands(() => false).submit('s', 'send', {}, async () => { throw new Error('local fallback'); }), /unavailable/);
    assert.equal(calls.length, 1);
  } finally { globalThis.fetch = original; }
});

test('HTTP 503 retires normal UI authority but keeps original receipt and explicit Stop', async () => {
  const value = target('stop-after-503');
  remoteConnections.publish(value.adapter.owner, []);
  const original = globalThis.fetch;
  const methods: string[] = [];
  globalThis.fetch = (async (path: string, init?: RequestInit) => {
    if (path === '/api/csrf') return Response.json({ csrfToken: 'test' });
    const { method, params } = JSON.parse(String(init?.body)); methods.push(`${method}:${params.type}`);
    if (params.type !== 'stop') return Response.json({ error: 'lost response' }, { status: 503 });
    return Response.json({ commandId: params.commandId, status: 'accepted', result: { stopping: true } });
  }) as typeof fetch;
  const normal = value.adapter.createCommands(() => true);
  try {
    await assert.rejects(normal.submit('s', 'send', {}, async () => { throw new Error('fallback'); }));
    assert.equal(value.adapter.isCurrent(), false);
    const pending = value.adapter.pendingCommands().map(row => row.commandId);
    assert.equal(pending.length, 1);
    assert.match(renderToStaticMarkup(<DisconnectedRemoteStop {...value} />), /<button/);
    await submitDisconnectedStop(value, () => true);
    assert.deepEqual(value.adapter.pendingCommands().map(row => row.commandId), pending);
    assert.deepEqual(methods, ['command/execute:send', 'command/execute:stop']);
  } finally { normal.dispose(); globalThis.fetch = original; }
});

test('binding, turn and plugin changes while CSRF loads prevent Stop dispatch', async () => {
  const original = globalThis.fetch;
  try {
    for (const change of ['binding', 'turn', 'plugin', 'owner']) {
      const value = target(`csrf-${change}`);
      let current = true;
      globalThis.fetch = (async (path: string) => {
        assert.equal(path, '/api/csrf', 'no mutating POST after retirement');
        if (change === 'binding') current = false;
        if (change === 'turn') value.session = { ...value.session, active_turn_id: 'successor' };
        if (change === 'plugin') value.enabled = false;
        if (change === 'owner') remoteConnections.publish({ ...value.adapter.owner, generation: 'new' }, []);
        return Response.json({ csrfToken: 'test' });
      }) as typeof fetch;
      await assert.rejects(submitDisconnectedStop(value, () => current), /changed before dispatch|unavailable/);
      assert.equal(value.adapter.pendingCommands().length, 0);
    }
  } finally { globalThis.fetch = original; }
});

test('server stale-turn refusal is not presented as an accepted Stop or followed by another action', async () => {
  const value = target('stop-stale-server');
  const original = globalThis.fetch;
  let posts = 0;
  globalThis.fetch = (async (path: string) => {
    if (path === '/api/csrf') return Response.json({ csrfToken: 'test' });
    posts++;
    return Response.json({ error: 'active turn changed; refresh before stopping', reasonCode: 'stale_turn' }, { status: 409 });
  }) as typeof fetch;
  try {
    await assert.rejects(submitDisconnectedStop(value, () => true), /active turn changed/);
    assert.equal(posts, 1);
    assert.equal(value.adapter.pendingCommands().length, 0);
  } finally { globalThis.fetch = original; }
});
