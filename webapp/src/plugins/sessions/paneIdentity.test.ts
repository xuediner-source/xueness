import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paneBindingKey, paneComposerKey, paneSubscriberId, paneDraftAddress, readPaneDraft, paneDraftAliasAdopted, markPaneDraftAliasAdopted, type PaneIdentity } from './paneIdentity';
import { transportSubscriberId } from './conversationTransport';
const base: PaneIdentity = { groupId: 'group', paneId: 'one', bindingRevision: 0, scope: { workspaceRoot: '/work' }, sessionId: 'a'.repeat(32) };
test('four leaves have bounded independent validated subscribers', () => {
  const ids = ['one', 'two', 'three', 'four'].map(paneId => paneSubscriberId({ ...base, paneId }));
  assert.equal(new Set(ids).size, 4);
  for (const id of ids) { assert.ok(id.length < 256); assert.equal(transportSubscriberId(id, base.sessionId!), id); }
  assert.notEqual(paneSubscriberId(base), paneSubscriberId({ ...base, scope: { workspaceRoot: '/elsewhere' } }));
  assert.notEqual(paneSubscriberId(base), paneSubscriberId({ ...base, bindingRevision: 1 }));
  assert.equal(transportSubscriberId(ids[0], 'b'.repeat(32)), `session:${'b'.repeat(32)}`);
  assert.equal(transportSubscriberId(`sessions.pane:primary:${base.sessionId}`, base.sessionId!), `sessions.pane:primary:${base.sessionId}`);
});
test('promotion keeps draft identity but retires permission and transport ownership', () => {
  const draft = { ...base, sessionId: null };
  const promoted = { ...base, bindingRevision: 1 };
  assert.equal(paneComposerKey(draft), paneComposerKey(promoted));
  assert.deepEqual(paneDraftAddress(draft), paneDraftAddress(promoted));
  assert.notEqual(paneBindingKey(draft), paneBindingKey(promoted));
  assert.notEqual(paneBindingKey(base), paneBindingKey({ ...base, scope: { ...base.scope, remoteConnectionId: 'remote' } }));
});
test('legacy draft alias readthrough does not write or hide a canonical draft', () => {
  const calls: string[] = [];
  const alias = { workspaceKey: '/old', draftKey: 'pane-secondary:old' };
  assert.equal(readPaneDraft(base, (workspace, draft) => { calls.push(`${workspace}:${draft}`); return workspace === '/old' ? 'old text' : null; }, alias), 'old text');
  assert.equal(calls.length, 2);
  assert.equal(readPaneDraft(base, () => 'canonical', alias), 'canonical');
});

test('stable workspace identity survives routing handle and root alias changes only for drafts', () => {
  const before = { ...base, scope: { workspaceRoot: '/a', workspaceIdentity: 'stable', remoteConnectionId: 'old' } };
  const after = { ...before, scope: { workspaceRoot: '/b', workspaceIdentity: 'stable', remoteConnectionId: 'new' } };
  assert.deepEqual(paneDraftAddress(before), paneDraftAddress(after));
  assert.equal(paneComposerKey(before), paneComposerKey(after));
  assert.notEqual(paneBindingKey(before), paneBindingKey(after));
});

test('canonical adoption tombstone prevents legacy revival after clear without deleting old raw', () => {
  const data = new Map<string, string>();
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
  const alias = { workspaceKey: 'old', draftKey: 'old' };
  const read = (workspace: string) => workspace === 'old' ? 'sent old message' : null;
  assert.equal(readPaneDraft(base, read, alias, paneDraftAliasAdopted(base, storage)), 'sent old message');
  assert.equal(markPaneDraftAliasAdopted(base, storage), true);
  assert.equal(readPaneDraft(base, read, alias, paneDraftAliasAdopted(base, storage)), null);
  assert.equal(read('old'), 'sent old message');
  assert.equal(markPaneDraftAliasAdopted(base, { getItem: () => null, setItem: () => { throw new Error('quota'); } }), false);
});
