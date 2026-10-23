import test from 'node:test';
import assert from 'node:assert/strict';
import { addPaneGroup, initialPaneGroups, openGroupSession } from './paneGroups';
import { decodePaneGroups, encodePaneGroups, MAX_PANE_PAYLOAD } from './panePersistence';
import type { TreeBinding } from './paneTree';
const binding = (sessionId: string | null): TreeBinding => ({ scope: { workspaceRoot: '/exact /root ', workspaceIdentity: 'stable', remoteConnectionId: 'connection' }, sessionId });
const context = { primaryBinding: binding('a'), groupId: 'g', updatedAt: 12 };
const legacy = JSON.stringify({ v: 1, split: 'column', focus: 'secondary', ratio: .7, secondary: { workspaceRoot: '/secondary ', sessionId: 'b' } });
test('v2 round trips nested trees, groups, routing metadata and draft aliases, strips runtime status', () => {
  let state = addPaneGroup(initialPaneGroups(), 'g', binding('a'), 1);
  state = openGroupSession(state, 'g', 'primary', 'down', { ...binding(null), draftAlias: { workspaceKey: '/exact ', draftKey: 'legacy' } }, 'p', 's', 2);
  state = openGroupSession(state, 'g', 'p', 'right', binding('b'), 'p2', 's2', 3);
  state = addPaneGroup(state, 'g2', binding('c'), 4);
  const raw = encodePaneGroups(state), result = decodePaneGroups(raw);
  assert.equal(result.kind, 'ok');
  if (result.kind === 'ok') assert.deepEqual(result.state, state);
  const runtime = JSON.parse(raw); runtime.groups[0].tree.bindings.primary.restoredUnvalidated = true; runtime.groups[0].tree.bindings.primary.status = 'streaming';
  const decoded = decodePaneGroups(JSON.stringify(runtime));
  assert.equal(decoded.kind, 'ok');
  if (decoded.kind === 'ok') assert.equal(encodePaneGroups(decoded.state), raw);
});
test('v1 migration is deferred until primary binding is verified, preserves raw and exact draft ownership', () => {
  const pending = decodePaneGroups(legacy); assert.equal(pending.kind, 'pendingLegacy');
  if (pending.kind === 'pendingLegacy') { assert.equal(pending.raw, legacy); assert.equal(pending.legacy.secondary?.workspaceRoot, '/secondary '); }
  assert.equal(decodePaneGroups(legacy, { ...context, primaryBinding: binding(null) }).kind, 'pendingLegacy');
  const result = decodePaneGroups(legacy, context); assert.equal(result.kind, 'ok');
  if (result.kind !== 'ok') return;
  const tree = result.state.groups[0].tree;
  assert.equal(result.migrated, true); assert.equal(tree.focus, 'secondary');
  assert.deepEqual(tree.bindings.primary.draftAlias, { workspaceKey: '/exact /root ', draftKey: 'session:a' });
  assert.deepEqual(tree.bindings.secondary.draftAlias, { workspaceKey: '/secondary ', draftKey: 'pane-secondary:b' });
  assert.ok(tree.root.type === 'split' && tree.root.ratio === .7 && tree.root.direction === 'column');
  assert.equal(decodePaneGroups(encodePaneGroups(result.state)).kind, 'ok');
  const unknownScope = JSON.stringify({ v: 1, split: 'row', focus: 'secondary', secondary: null, ratio: .5 });
  assert.equal(decodePaneGroups(unknownScope, context).kind, 'pendingLegacy');
});
test('invalid payloads retain original raw, never silently become empty', () => {
  const good = encodePaneGroups(addPaneGroup(initialPaneGroups(), 'g', binding('a'), 1));
  const mutate = (change: (state: any) => void) => { const state = JSON.parse(good); change(state); return JSON.stringify(state); };
  const invalid = ['{', '', 'null', JSON.stringify({ v: 3 }), 'x'.repeat(MAX_PANE_PAYLOAD + 1),
    mutate(s => { s.activeGroupId = 'unknown'; }), mutate(s => { s.groups.push(s.groups[0]); }),
    mutate(s => { s.groups[0].tree.focus = 'ghost'; }), mutate(s => { s.groups[0].tree.bindings.extra = binding('extra'); }),
    mutate(s => { s.groups[0].tree.bindings.primary.draftAlias = null; }),
    mutate(s => { s.groups[0].tree.bindings.primary.scope.workspaceRoot = 'a\u0000b'; }),
    mutate(s => { s.groups[0].tree.bindings.primary.scope.workspaceRoot = 'a'.repeat(513); }),
    mutate(s => { s.groups[0].tree.root.paneId = '__proto__'; }),
    mutate(s => { s.groups[0].tree.root = { type: 'split', splitId: 's', direction: 'row', ratio: .5, first: s.groups[0].tree.root, second: s.groups[0].tree.root }; }),
  ];
  for (const raw of invalid) { const result = decodePaneGroups(raw); assert.equal(result.kind, 'invalid', raw.slice(0, 100)); if (result.kind === 'invalid') assert.equal(result.raw, raw); }
  assert.deepEqual(decodePaneGroups(null), { kind: 'empty' });
  assert.throws(() => encodePaneGroups({ v: 2, groups: [], activeGroupId: 'missing' }), TypeError);
});
test('decoder rejects excessive depth, node collisions and nonfinite ratios; clamps finite ratios', () => {
  let state = addPaneGroup(initialPaneGroups(), 'g', binding('a'), 1);
  for (let i = 0; i < 3; i++) state = openGroupSession(state, 'g', i ? `p${i - 1}` : 'primary', 'right', binding(`b${i}`), `p${i}`, `s${i}`, i + 2);
  assert.equal(decodePaneGroups(encodePaneGroups(state)).kind, 'ok');
  const raw = JSON.parse(encodePaneGroups(state)); raw.groups[0].tree.root.ratio = 100;
  const clamped = decodePaneGroups(JSON.stringify(raw)); assert.equal(clamped.kind, 'ok');
  if (clamped.kind === 'ok') assert.equal(clamped.state.groups[0].tree.root.type === 'split' && clamped.state.groups[0].tree.root.ratio, .75);
  raw.groups[0].tree.root.ratio = null; assert.equal(decodePaneGroups(JSON.stringify(raw)).kind, 'invalid');
  raw.groups[0].tree.root.ratio = .5; raw.groups[0].tree.root.splitId = 'primary'; assert.equal(decodePaneGroups(JSON.stringify(raw)).kind, 'invalid');
});
test('decoder rejects a fifth leaf and preserves duplicate legacy draft views for later migration', () => {
  let state = addPaneGroup(initialPaneGroups(), 'g', binding('a'), 1);
  for (let i = 0; i < 3; i++) state = openGroupSession(state, 'g', i ? `p${i - 1}` : 'primary', 'right', binding(`b${i}`), `p${i}`, `s${i}`, i + 2);
  const excessive = JSON.parse(encodePaneGroups(state));
  excessive.groups[0].tree.root.second.second.second = { type: 'split', splitId: 's4', ratio: .5, direction: 'column', first: { type: 'leaf', paneId: 'p2' }, second: { type: 'leaf', paneId: 'p4' } };
  excessive.groups[0].tree.bindings.p4 = binding('b4');
  assert.equal(decodePaneGroups(JSON.stringify(excessive)).kind, 'invalid');
  const duplicateLegacy = JSON.stringify({ v: 1, split: 'row', ratio: .5, focus: 'secondary', secondary: { workspaceRoot: 'stable', sessionId: 'a' } });
  const result = decodePaneGroups(duplicateLegacy, context);
  assert.equal(result.kind, 'pendingLegacy');
  if (result.kind === 'pendingLegacy') assert.equal(result.raw, duplicateLegacy);
});
