import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePaneSidePanelBinding } from './paneSidePanelBinding';
import type { PaneIdentity } from './paneIdentity';
import type { RemoteSessionAdapter } from '../remote/remoteSessionAdapter';
const local = { sessionId: 'same-id', root: '/local', remote: false };
const remote = { owner: { connectionId: 'r', workspaceIdentity: '/remote' }, isCurrent: () => true } as unknown as RemoteSessionAdapter;
const identity: PaneIdentity = { groupId: 'g', paneId: 'p', bindingRevision: 1, sessionId: 'remote-session',
  scope: { workspaceRoot: '/remote', remoteConnectionId: 'r', workspaceIdentity: JSON.stringify(['remote', 'r', '/remote']) } };
test('focused remote identity supplies remote session instead of primary local ID', () => {
  const value = resolvePaneSidePanelBinding(identity, local, remote, true);
  assert.equal(value.sessionId, 'remote-session'); assert.equal(value.remoteAdapter, remote); assert.equal(value.remote, true);
});
test('stale or missing remote owner never falls back to local terminal/browser scope', () => {
  const value = resolvePaneSidePanelBinding(identity, local, undefined, true);
  assert.equal(value.remote, true); assert.equal(value.remoteAdapter, undefined); assert.equal(value.sessionId, 'remote-session');
  const wrong = { ...remote, owner: { connectionId: 'r', workspaceIdentity: '/other' } } as unknown as RemoteSessionAdapter;
  assert.equal(resolvePaneSidePanelBinding(identity, local, wrong, true).remoteAdapter, undefined);
  assert.equal(resolvePaneSidePanelBinding(null, { ...local, remote: true }, remote, true).sessionId, null);
});
test('focused local panes preserve their own root and disabled sessions expose no target', () => {
  const value = resolvePaneSidePanelBinding({ ...identity, sessionId: 'other', scope: { workspaceRoot: '/second' } }, local, remote, true);
  assert.equal(value.sessionId, 'other'); assert.equal(value.workspaceId, '/second'); assert.equal(value.remote, false);
  assert.equal(resolvePaneSidePanelBinding(identity, local, remote, false).sessionId, null);
});
