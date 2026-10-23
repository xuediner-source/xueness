import test from 'node:test';
import assert from 'node:assert/strict';
import { paneTreeGeometry } from './paneGeometry';
import { closeTreePane, initialPaneTree, setTreeSplitRatio, splitTreePane } from './paneTree';
const binding = { scope: { workspaceRoot: '/a' }, sessionId: null };
test('flat geometry partitions nested four-leaf tree without changing leaf keys', () => {
  let tree = initialPaneTree(binding);
  tree = splitTreePane(tree, 'primary', 'right', binding, 'b', 'ab');
  tree = splitTreePane(tree, 'primary', 'down', binding, 'c', 'ac');
  tree = splitTreePane(tree, 'b', 'up', binding, 'd', 'bd');
  tree = setTreeSplitRatio(tree, 'ab', .6);
  const layout = paneTreeGeometry(tree.root);
  assert.deepEqual(layout.leaves.map(({ paneId }) => paneId), ['primary', 'c', 'd', 'b']);
  assert.deepEqual(layout.leaves[0], { paneId: 'primary', x: 0, y: 0, width: .6, height: .5 });
  assert.equal(layout.leaves.reduce((sum, rect) => sum + rect.width * rect.height, 0), 1);
  assert.equal(layout.splits.length, 3);
  const collapsed = paneTreeGeometry(closeTreePane(tree, 'c').root);
  assert.deepEqual(collapsed.leaves.map(({ paneId }) => paneId), ['primary', 'd', 'b']);
  assert.deepEqual(collapsed.leaves[0], { paneId: 'primary', x: 0, y: 0, width: .6, height: 1 });
});
test('geometry defensively bounds bad ratio values without mutating its source', () => {
  const tree = splitTreePane(initialPaneTree(binding), 'primary', 'down', binding, 'b', 'ab');
  assert.equal(tree.root.type, 'split'); if (tree.root.type !== 'split') return;
  const malformed = { ...tree.root, ratio: Infinity };
  assert.equal(paneTreeGeometry(malformed).leaves[0].height, .5);
  assert.equal(malformed.ratio, Infinity);
});
