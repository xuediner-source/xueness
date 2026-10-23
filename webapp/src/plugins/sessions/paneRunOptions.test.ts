import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyPaneRunOptions, updatePaneRunOptions, paneBindingGuard } from './paneRunOptions';
import type { PaneIdentity } from './paneIdentity';
import type { RunChoices } from '../../xuenessBridge';
test('per-leaf models and permissions are copied without shared mutations', () => {
  const first: RunChoices = { provider: 'real', mode: 'build', model: 'one', permission_mode: 'build' };
  const second = updatePaneRunOptions(first, { model: 'two', permission_mode: 'yolo' });
  assert.equal(first.model, 'one'); assert.equal(first.permission_mode, 'build');
  assert.equal(second.model, 'two'); assert.equal(second.acknowledge_yolo, false);
  const copied = copyPaneRunOptions(second); copied.model = 'three'; assert.equal(second.model, 'two');
});
test('guards fence same-session rebinds, remote routing changes and plugin disable', () => {
  let current: PaneIdentity = { groupId: 'g', paneId: 'p', bindingRevision: 0, scope: { workspaceRoot: '/a' }, sessionId: 'a' };
  let enabled = true;
  const guard = paneBindingGuard(current, () => current, () => enabled);
  assert.equal(guard(), true); enabled = false; assert.equal(guard(), false); enabled = true;
  current = { ...current, bindingRevision: 1 }; assert.equal(guard(), false);
});
