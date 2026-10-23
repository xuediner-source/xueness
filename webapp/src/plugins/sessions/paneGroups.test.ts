import test from 'node:test';
import assert from 'node:assert/strict';
import { addPaneGroup, initialPaneGroups, openGroupSession, removePaneGroup, resolveSessionPlacement } from './paneGroups';
import type { TreeBinding } from './paneTree';
const binding = (sessionId: string | null, root = '/a'): TreeBinding => ({ scope: { workspaceRoot: root }, sessionId });
test('existing session activates its original group even when destination is full', () => {
  let state = addPaneGroup(initialPaneGroups(), 'g1', binding('a'), 1);
  state = addPaneGroup(state, 'g2', binding('b'), 2);
  for (let i = 0; i < 3; i++) state = openGroupSession(state, 'g2', 'primary', 'right', binding(`c${i}`), `p${i}`, `s${i}`, 3 + i);
  const full = state;
  assert.equal(openGroupSession(full, 'g2', 'primary', 'right', binding('overflow'), 'overflow', 'split', 8), full);
  state = openGroupSession(state, 'g2', 'primary', 'right', binding('a'), 'unused', 'unused-split', 9);
  assert.equal(state.activeGroupId, 'g1'); assert.equal(state.groups[1], full.groups[1]);
  assert.deepEqual(resolveSessionPlacement(state, binding('c1')), { groupId: 'g2', paneId: 'p1' });
  assert.equal(addPaneGroup(state, 'g3', binding('a'), 10).groups.length, 2);
  assert.equal(addPaneGroup(state, 'g3', binding('a', '/different'), 10).groups.length, 3);
});
test('groups bound IDs, timestamps, drafts and removal fallback without remapping owners', () => {
  let state = addPaneGroup(initialPaneGroups(), 'g1', binding(null), 1);
  state = addPaneGroup(state, 'g2', binding(null), 2);
  assert.equal(state.groups.length, 2);
  assert.equal(addPaneGroup(state, 'g2', binding('a'), 3), state);
  assert.equal(addPaneGroup(state, 'g3', binding('a'), NaN), state);
  assert.equal(removePaneGroup(state, 'missing'), state);
  state = removePaneGroup(state, 'g2'); assert.equal(state.activeGroupId, 'g1');
  assert.deepEqual(removePaneGroup(state, 'g1'), initialPaneGroups());
});
