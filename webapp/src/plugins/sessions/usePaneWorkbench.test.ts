import test from 'node:test';
import assert from 'node:assert/strict';
import { PaneWorkbenchController, type PaneWorkbenchOptions } from './usePaneWorkbench';
import { PANE_GROUP_STORAGE_KEY } from './panePersistence';
import { PANE_LAYOUT_STORAGE_KEY } from './paneLayout';
import type { TreeBinding } from './paneTree';
import type { PaneRestoreResult } from './paneRestore';
const binding = (sessionId: string | null, root = '/a'): TreeBinding => ({ scope: { workspaceRoot: root }, sessionId });
function harness(overrides: Partial<PaneWorkbenchOptions> = {}, values: Record<string, string> = {}) {
  const data = new Map(Object.entries(values)), reads: string[] = [], writes: string[] = [];
  const storage = { getItem(key: string) { reads.push(key); return data.get(key) ?? null; }, setItem(key: string, value: string) { writes.push(key); data.set(key, value); } };
  let sequence = 0;
  const options: PaneWorkbenchOptions = { enabled: true, primaryBinding: binding('a'), ...overrides };
  const controller = new PaneWorkbenchController(options, () => 123, kind => `${kind}-${++sequence}`);
  return { controller, options, storage, data, reads, writes };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
test('disabled lifecycle admits no reads, writes, requests or stale actions', async () => {
  let requests = 0;
  const h = harness({ enabled: false, probeSession: async () => { requests++; return { kind: 'present', status: 200 }; } });
  h.controller.start(h.storage); h.controller.ensureGroup(binding('a')); h.controller.split('right'); h.controller.restore();
  assert.equal(h.controller.getSnapshot().state.groups.length, 0);
  assert.deepEqual(h.reads, []); assert.deepEqual(h.writes, []); assert.equal(requests, 0);
  h.controller.configure({ ...h.options, enabled: true }); h.controller.start(h.storage);
  const before = h.controller.getSnapshot();
  h.controller.configure({ ...h.options, enabled: false });
  h.controller.restore(); h.controller.closeGroup(before.state.activeGroupId!); h.controller.stop();
  await tick(); assert.equal(h.controller.getSnapshot(), before); assert.equal(requests, 0);
});
test('v1 migration writes only v2 and retains exact original draft aliases', () => {
  const raw = JSON.stringify({ v: 1, split: 'row', focus: 'secondary', ratio: .6, secondary: { sessionId: 'b', workspaceRoot: '/b' } });
  const h = harness({}, { [PANE_LAYOUT_STORAGE_KEY]: raw }); h.controller.start(h.storage);
  assert.equal(h.data.get(PANE_LAYOUT_STORAGE_KEY), raw);
  assert.ok(h.data.has(PANE_GROUP_STORAGE_KEY));
  assert.ok(h.writes.every(key => key === PANE_GROUP_STORAGE_KEY));
  assert.equal(h.controller.activeGroup()?.tree.bindings.secondary.draftAlias?.draftKey, 'pane-secondary:b');
});
test('invalid v2 and deferred legacy bytes survive interactive in-memory edits', () => {
  for (const [key, raw] of [
    [PANE_GROUP_STORAGE_KEY, '{broken'],
    [PANE_LAYOUT_STORAGE_KEY, JSON.stringify({ v: 1, split: 'row', focus: 'secondary', ratio: .5, secondary: null })],
    [PANE_GROUP_STORAGE_KEY, JSON.stringify({ v: 1, split: null, focus: 'primary', ratio: .5, secondary: null })],
  ]) {
    const h = harness({}, { [key]: raw }); h.controller.start(h.storage); h.controller.split('right');
    assert.equal(h.data.get(key), raw); assert.deepEqual(h.writes, []);
    assert.equal(Object.keys(h.controller.activeGroup()!.tree.bindings).length, 2);
  }
});
test('group/leaf bounds and cross-group focus return primary shell selection without rebinding', () => {
  const h = harness(); h.controller.start(h.storage);
  const first = h.controller.activeGroup()!;
  h.controller.openSession(binding('b'));
  h.controller.ensureGroup(binding('c'));
  assert.equal(h.controller.activeGroup()?.tree.bindings.primary.sessionId, 'c');
  const required = h.controller.openSession(binding('b'));
  assert.equal(required?.sessionId, 'a'); assert.equal(h.controller.activeGroup()?.groupId, first.groupId);
  assert.equal(h.controller.activeGroup()?.tree.bindings[h.controller.activeGroup()!.tree.focus].sessionId, 'b');
  h.controller.split('down'); h.controller.split('left'); h.controller.split('up');
  assert.equal(Object.keys(h.controller.activeGroup()!.tree.bindings).length, 4);
  for (let i = 0; i < 40; i++) h.controller.ensureGroup(binding(`session-${i}`));
  assert.equal(h.controller.getSnapshot().state.groups.length, 32);
});
test('scoped options and stable draft promotion reject stale callbacks and preserve sibling choices', () => {
  const h = harness({ initialRunOptions: { provider: 'real', mode: 'plan', model: 'seed' } }); h.controller.start(h.storage);
  h.controller.split('right');
  const pane = h.controller.activeGroup()!.tree.focus;
  const callback = h.controller.promotionCallback(pane);
  assert.equal(h.controller.promotionCallback(pane), callback);
  h.controller.updateRunOptions(pane, { model: 'secondary' });
  assert.equal(h.controller.runOptions('primary').model, 'seed');
  const revision = h.controller.identity(pane)!.bindingRevision;
  callback('created');
  assert.equal(h.controller.activeGroup()?.tree.bindings[pane].sessionId, 'created');
  assert.ok(h.controller.identity(pane)!.bindingRevision > revision);
  assert.equal(h.controller.runOptions(pane).model, 'secondary');
  callback('late'); assert.equal(h.controller.activeGroup()?.tree.bindings[pane].sessionId, 'created');
  h.controller.replaceBinding(pane, binding(null, '/other'));
  callback('late-again'); assert.equal(h.controller.activeGroup()?.tree.bindings[pane].sessionId, null);
  assert.equal(h.controller.runOptions(pane).model, 'seed');
  const stale = h.controller.promotionCallback(pane); h.controller.stop(); stale('disabled');
  assert.equal(h.controller.activeGroup()?.tree.bindings[pane].sessionId, null);
});
test('restore retains absent/forbidden bindings and rejects late results after rebind or disable', async () => {
  const pending: ((result: PaneRestoreResult) => void)[] = [];
  const h = harness({ probeSession: () => new Promise(resolve => pending.push(resolve)) }); h.controller.start(h.storage);
  h.controller.restore(); await tick();
  assert.equal(pending.length, 1);
  h.controller.replaceBinding('primary', binding('other'));
  pending[0]({ kind: 'absent', status: 404 }); await tick();
  assert.equal(h.controller.restoreStatus('primary'), null);
  h.controller.restore(); await tick(); pending[1]({ kind: 'unknown', status: 403, reason: 'http' }); await tick();
  assert.equal(h.controller.restoreStatus('primary')?.kind, 'unknown');
  assert.equal(h.controller.activeGroup()?.tree.bindings.primary.sessionId, 'other');
  h.controller.openSession(binding('absent')); const pane = h.controller.activeGroup()!.tree.focus;
  h.controller.restore(); await tick(); pending[2]({ kind: 'absent', status: 410 }); await tick();
  assert.equal(h.controller.restoreStatus(pane)?.kind, 'absent');
  assert.equal(h.controller.activeGroup()?.tree.bindings[pane].sessionId, 'absent');
  h.controller.openSession(binding('stopping')); h.controller.restore(); await tick(); h.controller.stop();
  pending[3]({ kind: 'present', status: 200 }); await tick(); assert.equal(h.controller.restoreStatus(h.controller.activeGroup()!.tree.focus), null);
});
test('storage failure retains memory and reloading preserves unchanged runtime options', () => {
  const h = harness(); h.controller.start(h.storage); h.controller.updateRunOptions('primary', { model: 'mine' });
  h.controller.reload(); assert.equal(h.controller.runOptions('primary').model, 'mine');
  const failing = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
  const other = harness(); other.controller.start(failing); other.controller.split('right');
  assert.equal(other.controller.getSnapshot().storageStatus, 'unavailable');
  assert.equal(Object.keys(other.controller.activeGroup()!.tree.bindings).length, 2);
});

test('restored secondary focus survives automatic primary detail hydration while explicit selection still focuses its pane', () => {
  const initial = harness(); initial.controller.start(initial.storage);
  initial.controller.openSession(binding('b'));
  const secondary = initial.controller.activeGroup()!.tree.focus;
  const persisted = initial.data.get(PANE_GROUP_STORAGE_KEY)!;
  initial.controller.stop();
  const restored = harness({ primaryBinding: binding(null) });
  restored.data.set(PANE_GROUP_STORAGE_KEY, persisted);
  restored.controller.start(restored.storage);
  const writes = restored.writes.length;
  restored.controller.syncPrimary(binding('a'));
  assert.equal(restored.controller.activeGroup()!.tree.focus, secondary);
  assert.equal(restored.writes.length, writes, 'Hydration must not rewrite the persisted selection');
  restored.controller.syncPrimary(binding('a'), true);
  assert.equal(restored.controller.activeGroup()!.tree.focus, 'primary');
});

test('automatic primary synchronization still selects a changed workspace namespace', () => {
  const h = harness(); h.controller.start(h.storage);
  h.controller.openSession(binding('b'));
  const previous = h.controller.activeGroup()!.groupId;
  h.controller.syncPrimary(binding('a', '/other'));
  assert.notEqual(h.controller.activeGroup()!.groupId, previous);
  assert.equal(h.controller.activeGroup()!.tree.bindings.primary.scope.workspaceRoot, '/other');
  assert.equal(h.controller.getSnapshot().state.groups.find(group => group.groupId === previous)!.tree.bindings.primary.scope.workspaceRoot, '/a');
});
test('initial default-root hydration rebinds an empty primary draft instead of adding a startup group', () => {
  const h = harness({ primaryBinding: binding(null, '') }); h.controller.start(h.storage);
  const groupId = h.controller.activeGroup()!.groupId;
  const updated = h.controller.syncPrimary(binding(null, '/default-workspace'), false, true);
  assert.equal(updated?.scope.workspaceRoot, '/default-workspace');
  assert.equal(h.controller.getSnapshot().state.groups.length, 1);
  assert.equal(h.controller.activeGroup()?.groupId, groupId);
  assert.equal(h.controller.activeGroup()?.tree.bindings.primary.scope.workspaceRoot, '/default-workspace');
});
test('preserving an existing primary draft scope leaves its group binding and secondary focus intact', () => {
  const h = harness({ primaryBinding: binding(null, '') }); h.controller.start(h.storage);
  h.controller.openSession(binding('secondary', ''));
  const originalGroup = h.controller.activeGroup()!;
  const secondaryPane = originalGroup.tree.focus;
  assert.notEqual(secondaryPane, 'primary');

  // A persisted default/root draft makes the container pass false here. The
  // controller must create the resolved-root group without overwriting the
  // original group that still owns the draft and its focused secondary pane.
  h.controller.syncPrimary(binding(null, '/default-workspace'), false, false);
  const preserved = h.controller.getSnapshot().state.groups.find(group => group.groupId === originalGroup.groupId)!;
  assert.equal(h.controller.getSnapshot().state.groups.length, 2);
  assert.equal(preserved.tree.bindings.primary.scope.workspaceRoot, '');
  assert.equal(preserved.tree.bindings[secondaryPane].sessionId, 'secondary');
  assert.equal(preserved.tree.focus, secondaryPane);
});
test('startup root hydration does not rebind explicit selections or existing scoped groups', () => {
  const explicit = harness({ primaryBinding: binding(null, '') }); explicit.controller.start(explicit.storage);
  const first = explicit.controller.activeGroup()!.groupId;
  explicit.controller.syncPrimary(binding(null, '/default-workspace'), true, true);
  assert.equal(explicit.controller.getSnapshot().state.groups.length, 2);
  assert.notEqual(explicit.controller.activeGroup()?.groupId, first);
  assert.equal(explicit.controller.activeGroup()?.tree.bindings.primary.scope.workspaceRoot, '/default-workspace');
  assert.equal(explicit.controller.getSnapshot().state.groups.find(group => group.groupId === first)?.tree.bindings.primary.scope.workspaceRoot, '');

  const scoped = harness(); scoped.controller.start(scoped.storage);
  const existing = scoped.controller.activeGroup()!.groupId;
  scoped.controller.syncPrimary(binding(null, '/other'), false, true);
  assert.equal(scoped.controller.getSnapshot().state.groups.length, 2);
  assert.notEqual(scoped.controller.activeGroup()?.groupId, existing);
});
test('restoration limits concurrency and retries retained uncertainty only on request', async () => {
  const pending: ((result: PaneRestoreResult) => void)[] = [];
  const h = harness({ probeSession: () => new Promise(resolve => pending.push(resolve)) }); h.controller.start(h.storage);
  for (let i = 0; i < 8; i++) h.controller.ensureGroup(binding(`s-${i}`));
  h.controller.restore(); await tick(); assert.equal(pending.length, 4);
  pending[0]({ kind: 'unknown', status: 503, reason: 'http' }); await tick(); assert.equal(pending.length, 5);
  for (let i = 1; i < 9; i++) { pending[i]({ kind: 'present', status: 200 }); await tick(); }
  assert.equal(pending.length, 9);
  h.controller.restore(); await tick(); assert.equal(pending.length, 9);
  h.controller.retryRestore('primary'); await tick(); assert.equal(pending.length, 10);
  pending[9]({ kind: 'present', status: 200 }); await tick();
  assert.equal(h.controller.restoreStatus('primary')?.kind, 'present');
});
test('disable before queued probe microtask prevents request admission', async () => {
  let requests = 0;
  const h = harness({ probeSession: async () => { requests++; return { kind: 'present', status: 200 }; } });
  h.controller.start(h.storage); h.controller.restore(); h.controller.configure({ ...h.options, enabled: false });
  await tick(); assert.equal(requests, 0); h.controller.stop();
});
test('failed writes recover on a later explicit edit without losing the memory layout', () => {
  const h = harness(); let fail = true;
  const storage = { getItem: h.storage.getItem, setItem(key: string, value: string) { if (fail) throw new Error('full'); h.storage.setItem(key, value); } };
  h.controller.start(storage); assert.equal(h.controller.getSnapshot().storageStatus, 'unavailable');
  h.controller.split('right'); assert.equal(Object.keys(h.controller.activeGroup()!.tree.bindings).length, 2);
  fail = false; h.controller.focus('primary'); assert.equal(h.controller.getSnapshot().storageStatus, 'ready');
  assert.equal(JSON.parse(h.data.get(PANE_GROUP_STORAGE_KEY)!).groups[0].tree.focus, 'primary');
});
test('restoring or reloading never derives absent sessions from a capped index', () => {
  const h = harness(); h.controller.start(h.storage); h.controller.openSession(binding('not-in-index'));
  const state = h.controller.getSnapshot().state;
  h.controller.reload();
  assert.equal(h.controller.getSnapshot().state.groups[0].tree.bindings[state.groups[0].tree.focus].sessionId, 'not-in-index');
});
test('default probe timeouts release the four-slot restore queue without pruning bindings', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  t.mock.method(globalThis, 'fetch', () => { calls++; return new Promise(() => undefined); });
  const h = harness(); h.controller.start(h.storage);
  for (let i = 0; i < 5; i++) h.controller.ensureGroup(binding(`timeout-${i}`));
  h.controller.restore(); await tick();
  assert.equal(calls, 4);
  t.mock.timers.tick(15000); await tick();
  assert.equal(calls, 6);
  t.mock.timers.tick(15000); await tick();
  assert.equal(h.controller.getSnapshot().state.groups.length, 6);
  for (const group of h.controller.getSnapshot().state.groups)
    assert.deepEqual(h.controller.restoreStatus('primary', group.groupId), { kind: 'unknown', reason: 'timeout' });
  h.controller.stop();
});
