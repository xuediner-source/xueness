import test from 'node:test';
import assert from 'node:assert/strict';
import { bindCreatedPaneSession, clampPaneRatio, closeTreePane, findTreeSession, focusTreePane, initialPaneTree, paneLeafIds, paneSessionKey, replaceTreeBinding, setTreeSplitRatio, splitTreePane, type TreeBinding } from './paneTree';
const binding = (id: string | null, root = '/a'): TreeBinding => ({ scope: { workspaceRoot: root }, sessionId: id });
test('four directions place new leaves before/after and preserve scope', () => {
  for (const side of ['left', 'right', 'up', 'down'] as const) {
    const tree = splitTreePane(initialPaneTree(binding('a')), 'primary', side, binding('b', '/b'), 'b', 's');
    assert.deepEqual(paneLeafIds(tree.root), side === 'left' || side === 'up' ? ['b', 'primary'] : ['primary', 'b']);
    assert.equal(tree.root.type === 'split' && tree.root.direction, side === 'left' || side === 'right' ? 'row' : 'column');
    assert.equal(tree.bindings.b.scope.workspaceRoot, '/b');
  }
});
test('four-leaf capacity, stable ratios/IDs and immediate-parent collapse', () => {
  let tree = splitTreePane(initialPaneTree(binding('a')), 'primary', 'right', binding('b'), 'b', 's1');
  tree = setTreeSplitRatio(tree, 's1', .7);
  tree = splitTreePane(tree, 'b', 'down', binding('c'), 'c', 's2');
  tree = setTreeSplitRatio(tree, 's2', .3);
  tree = splitTreePane(tree, 'c', 'left', binding('d'), 'd', 's3');
  assert.equal(splitTreePane(tree, 'd', 'down', binding('e'), 'e', 's4'), tree);
  assert.equal(closeTreePane(tree, 'primary'), tree);
  assert.equal(closeTreePane(tree, 'missing'), tree);
  const closed = closeTreePane(tree, 'c');
  assert.deepEqual(paneLeafIds(closed.root), ['primary', 'b', 'd']);
  assert.ok(closed.root.type === 'split' && closed.root.splitId === 's1' && closed.root.ratio === .7);
  assert.ok(closed.root.type === 'split' && closed.root.second.type === 'split' && closed.root.second.splitId === 's2' && closed.root.second.ratio === .3);
  assert.equal(closed.focus, 'd');
  assert.equal(closeTreePane(closed, 'd').focus, 'primary');
  const focused = splitTreePane(tree, 'd', 'down', binding('a'), 'e', 's4');
  assert.equal(focused.focus, 'primary'); assert.equal(focused.root, tree.root);
});
test('IDs and stale creation completions are guarded; drafts retain aliases without moves', () => {
  let tree = initialPaneTree(binding('a'));
  assert.equal(splitTreePane(tree, 'primary', 'right', binding('b'), 'primary', 's'), tree);
  assert.equal(splitTreePane(tree, 'primary', 'right', binding('b'), 'b', 'b'), tree);
  const draft: TreeBinding = { ...binding(null), draftAlias: { workspaceKey: '/exact ', draftKey: 'old-draft' } };
  tree = splitTreePane(tree, 'primary', 'right', draft, 'draft', 's');
  const bound = bindCreatedPaneSession(tree, 'draft', draft, 'created');
  assert.equal(bound.bindings.draft.draftAlias, draft.draftAlias);
  assert.equal(bound.root, tree.root); assert.equal(bound.focus, tree.focus);
  assert.equal(bindCreatedPaneSession(bound, 'draft', draft, 'late'), bound);
  const replacement = replaceTreeBinding(tree, 'draft', binding('replacement'));
  assert.equal(bindCreatedPaneSession(replacement, 'draft', draft, 'late'), replacement);
  assert.equal(replacement.bindings.draft.draftAlias, undefined);
  assert.equal(focusTreePane(tree, 'missing'), tree);
});
test('session identity is tuple encoded, stable across reconnects, isolated across workspaces', () => {
  const scope = { workspaceRoot: '/a', workspaceIdentity: ' stable ', remoteConnectionId: 'r1' };
  const tree = initialPaneTree({ scope, sessionId: 'id' });
  assert.equal(findTreeSession(tree, { scope: { ...scope, workspaceRoot: '/new', remoteConnectionId: 'r2' }, sessionId: 'id' }), 'primary');
  assert.equal(findTreeSession(tree, binding('id', '/b')), null);
  assert.notEqual(paneSessionKey({ workspaceRoot: 'a::b' }, 'c'), paneSessionKey({ workspaceRoot: 'a' }, 'b::c'));
  assert.equal(clampPaneRatio(NaN), .5); assert.equal(clampPaneRatio(Infinity), .5);
  assert.equal(clampPaneRatio(-1), .25); assert.equal(clampPaneRatio(2), .75);
});
test('repeated edits retain bounded binary-tree invariants and never mutate snapshots', () => {
  let tree = initialPaneTree(binding('a'));
  for (let i = 1; i <= 80; i++) {
    const previous = tree, before = JSON.stringify(previous), leaves = paneLeafIds(tree.root);
    tree = splitTreePane(tree, leaves[i % leaves.length], ['left', 'up', 'right', 'down'][i % 4] as 'left', binding(`session${i}`), `pane${i}`, `split${i}`);
    assert.equal(JSON.stringify(previous), before);
    if (i % 3 === 0) tree = closeTreePane(tree, paneLeafIds(tree.root).find(id => id !== 'primary')!);
    const current = paneLeafIds(tree.root);
    assert.ok(current.length <= 4); assert.ok(current.includes('primary')); assert.ok(current.includes(tree.focus));
    assert.deepEqual(Object.keys(tree.bindings).sort(), [...current].sort());
    const depth = (node: typeof tree.root): number => node.type === 'leaf' ? 0 : 1 + Math.max(depth(node.first), depth(node.second));
    assert.ok(depth(tree.root) <= 3);
  }
});
