import test from 'node:test';
import assert from 'node:assert/strict';
import { createRemoteBrowserTransport } from './remoteBrowserTransport';
import { BrowserSessionRegistry } from './browserSessionRegistry';
import { RemoteSessionAdapter } from '../remote/remoteSessionAdapter';
import { remoteConnections, type RemoteOwner } from '../remote/remoteConnectionStore';

const owner = (id: string, ready = true): RemoteOwner => ({connectionId: id, digest: 'digest', generation: 'g1', state: 'connected', workspaceIdentity: 'workspace', capabilities: {browserTabs: ready}});
const descriptor = {pageId: 'b'.repeat(32), sessionId: 'a'.repeat(32), workspaceId: 'workspace', title: 'Browser', url: ''};

test('real adapter uses negotiated remote browser authority and never local routes', async () => {
  const original = globalThis.fetch, calls: Record<string, unknown>[] = [];
  const binding = owner('browser-ready'); remoteConnections.publish(binding, []);
  globalThis.fetch = (async (path: string, init?: RequestInit) => {
    if (path === '/api/csrf') return new Response(JSON.stringify({csrfToken:'test'}));
    assert.equal(path, '/api/remote/browser-ready/request');
    const body = JSON.parse(String(init?.body)); calls.push(body);
    return new Response(JSON.stringify(body.method === 'browser/open' ? descriptor : {approvalRequired:true, approvalId:'nonce', subject:'exact'}));
  }) as typeof fetch;
  try {
    const api = createRemoteBrowserTransport(new RemoteSessionAdapter(binding), 'remote-work');
    const tab = await api.open(descriptor.sessionId);
    assert.equal(tab.workspaceId, 'remote-work');
    await api.action(tab.pageId, {action:'inspect', approvalId:'original-nonce'});
    assert.equal(calls[1].expectedGeneration, 'g1');
    assert.deepEqual(calls[1].params, {workspaceIdentity:'workspace',sessionId:descriptor.sessionId,pageId:descriptor.pageId,payload:{action:'inspect',approvalId:'original-nonce'}});
    remoteConnections.publish({...binding,generation:'g2'}, []);
    await assert.rejects(api.action(tab.pageId, {action:'inspect'}), /unavailable/);
    const unavailable = owner('browser-missing',false); remoteConnections.publish(unavailable, []);
    await assert.rejects(createRemoteBrowserTransport(new RemoteSessionAdapter(unavailable), 'x').open(descriptor.sessionId), /capability/);
    assert.equal(calls.length, 2);
  } finally {globalThis.fetch = original;}
});

test('close during asynchronous dispatch preflight blocks browser action and creation', async () => {
  const binding = owner('browser-cancel'), adapter = new RemoteSessionAdapter(binding);
  let release!: () => void, deferred = false, actions = 0;
  adapter.request = async (method, _params, _signal, enabled = () => true) => {
    if (deferred && method !== 'browser/close') await new Promise<void>(resolve => {release = resolve;});
    if (!enabled()) throw Object.assign(new Error('not sent'), {requestNotSent:true});
    if (method === 'browser/open') return descriptor;
    if (method === 'browser/action') actions++;
    return {ok:true};
  };
  const registry = new BrowserSessionRegistry(createRemoteBrowserTransport(adapter,'workspace'));
  registry.setEnabled(true);
  const tab = (await registry.create('workspace', descriptor.sessionId, true))!;
  deferred = true;
  const acting = registry.act(tab, {action:'inspect'});
  const releaseAction = release;
  registry.close(tab); releaseAction();
  await acting; assert.equal(actions, 0);
  deferred = false;
  const second = new BrowserSessionRegistry(createRemoteBrowserTransport(adapter,'workspace'));
  second.setEnabled(true); deferred = true;
  const opening = second.create('workspace', descriptor.sessionId, true);
  second.removeWorkspace('workspace'); release();
  await assert.rejects(opening, /not sent/);
});

test('lost open plus lost cancellation fences fresh opens without retry or empty-list assumptions', async () => {
  const binding = owner('browser-unknown'), adapter = new RemoteSessionAdapter(binding);
  const calls: string[] = [];
  adapter.request = async method => {calls.push(method); throw new Error('lost response');};
  const api = createRemoteBrowserTransport(adapter, 'workspace');
  await assert.rejects(api.open(descriptor.sessionId), /lost response/);
  await assert.rejects(api.open(descriptor.sessionId), /previous browser opening/);
  assert.deepEqual(calls, ['browser/open','browser/cancel-open']);
});

test('confirmed exact cancellation permits a fresh explicit descriptor opening', async () => {
  const binding = owner('browser-cancelled-open'), adapter = new RemoteSessionAdapter(binding);
  const openings: string[] = [];
  adapter.request = async (method, params) => {
    if (method === 'browser/cancel-open') return {cancelled:true, openId:params.openId};
    openings.push(String(params.openId));
    if (openings.length === 1) throw new Error('lost response');
    return descriptor;
  };
  const api = createRemoteBrowserTransport(adapter, 'workspace');
  await assert.rejects(api.open(descriptor.sessionId), /lost response/);
  assert.equal((await api.open(descriptor.sessionId)).pageId, descriptor.pageId);
  assert.equal(openings.length, 2); assert.notEqual(openings[0], openings[1]);
});
