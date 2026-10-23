import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConversationSnapshot } from '../../xuenessWorkbench';
import { projectSnapshotTimelineRows } from './paneConversation';
import {
  PANE_LAYOUT_STORAGE_KEY,
  PANE_LAYOUT_WIDE_MIN_PX,
  PANE_SESSION_DRAG_MIME,
  acceptsPaneDrag,
  bindSecondaryPane,
  boundPaneRatio,
  closeSecondaryPane,
  decodePaneLayout,
  encodePaneLayout,
  focusPane,
  initialPaneLayout,
  paneDragPayload,
  paneLayoutForFeature,
  paneLayoutIsSplitVisible,
  paneLayoutViewportIsWide,
  paneSubscriptionIdentity,
  paneWorkspaceLabel,
  readPaneDrop,
  resizePaneLayout,
  splitPaneLayout,
} from './paneLayout';

const sessionA = 'a'.repeat(32);
const sessionB = 'b'.repeat(32);

test('stored pane layout is bounded and ignored when sessions is not effective', () => {
  assert.equal(PANE_LAYOUT_STORAGE_KEY, 'xueness.sessions.pane-layout.v1');
  const open = bindSecondaryPane(splitPaneLayout(initialPaneLayout(), 'row'), { sessionId: sessionA, workspaceRoot: '/work/alpha' });
  const encoded = encodePaneLayout({ ...open, focus: 'secondary' });
  assert.ok(encoded.length < 4096);
  assert.deepEqual(decodePaneLayout(encoded), { v: 1, split: 'row', focus: 'secondary', secondary: { sessionId: sessionA, workspaceRoot: '/work/alpha' }, ratio: 0.5 });
  assert.deepEqual(paneLayoutForFeature(false, encoded), initialPaneLayout());
  assert.deepEqual(decodePaneLayout('{"v":1,"split":"grid","focus":"secondary","secondary":{"sessionId":"../x","workspaceRoot":"/tmp"}}'), initialPaneLayout());
  assert.deepEqual(decodePaneLayout('{"v":2,"split":"row"}'), initialPaneLayout());
  assert.deepEqual(decodePaneLayout(`{"v":1,"split":"row","secondary":{"sessionId":"${sessionA}","workspaceRoot":"${'x'.repeat(513)}"}}`),
    { v: 1, split: 'row', focus: 'primary', secondary: null, ratio: 0.5 });
  assert.equal(decodePaneLayout('x'.repeat(4097)).split, null);
});

test('v1 ratio migration, untrusted storage and resize preserve binding and subscription identity', () => {
  const legacy = JSON.stringify({ v: 1, split: 'row', focus: 'secondary', secondary: { sessionId: sessionA, workspaceRoot: '/work/alpha' } });
  const layout = decodePaneLayout(legacy);
  assert.equal(layout.ratio, 0.5, 'existing v1 layouts retain equal panes');
  for (const invalid of [undefined, null, '0.6', {}, NaN, Infinity, -Infinity]) assert.equal(boundPaneRatio(invalid), 0.5);
  assert.equal(boundPaneRatio(-1), 0.25);
  assert.equal(boundPaneRatio(2), 0.75);
  assert.equal(decodePaneLayout('{"v":1,"split":"row","ratio":1e999}').ratio, 0.5);
  assert.equal(decodePaneLayout('{"v":1,"split":"column","ratio":-100}').ratio, 0.25);
  const resized = resizePaneLayout(layout, 0.65);
  assert.deepEqual(resized.secondary, layout.secondary);
  assert.equal(resized.focus, layout.focus);
  assert.equal(paneSubscriptionIdentity('secondary', resized.secondary!.sessionId), paneSubscriptionIdentity('secondary', layout.secondary!.sessionId));
  assert.deepEqual(decodePaneLayout(encodePaneLayout(resized)), resized);
  assert.equal(resizePaneLayout(resized, 0.65), resized);
  assert.equal(splitPaneLayout(resized, 'column').ratio, 0.65);
  assert.equal(resizePaneLayout(resized, 0.9).ratio, 0.75);
  assert.equal(resizePaneLayout(resized, 0).ratio, 0.25);
  assert.equal(paneLayoutIsSplitVisible(resized, false, true), false);
  assert.equal(resized.ratio, 0.65, 'narrow visibility leaves stored ratio intact');
  assert.deepEqual(paneLayoutForFeature(false, encodePaneLayout(resized)), initialPaneLayout());
  const closed = initialPaneLayout();
  assert.equal(resizePaneLayout(closed, 0.7), closed);
  assert.deepEqual(closeSecondaryPane(resized), closed);
});

test('split, focus, close and narrow visibility stay inside two conversation panes', () => {
  const right = splitPaneLayout(initialPaneLayout(), 'row');
  assert.equal(right.split, 'row');
  assert.equal(splitPaneLayout(right, 'row'), right);
  const down = splitPaneLayout(right, 'column');
  assert.equal(down.split, 'column');
  assert.equal(down.secondary, null);
  const focused = focusPane(down, 'secondary');
  assert.equal(focused.focus, 'secondary');
  const single = initialPaneLayout();
  assert.equal(focusPane(single, 'secondary'), single);
  const bound = bindSecondaryPane(focused, { sessionId: sessionB, workspaceRoot: 'D:\\work\\beta' });
  assert.deepEqual(bound.secondary, { sessionId: sessionB, workspaceRoot: 'D:\\work\\beta' });
  assert.equal(bound.focus, 'secondary');
  const closed = initialPaneLayout();
  assert.equal(bindSecondaryPane(closed, { sessionId: sessionB, workspaceRoot: '/work' }), closed);
  assert.deepEqual(closeSecondaryPane(bound), initialPaneLayout());
  assert.equal(paneLayoutIsSplitVisible(bound, true, true), true);
  assert.equal(paneLayoutIsSplitVisible(bound, false, true), false);
  assert.equal(paneLayoutIsSplitVisible(bound, true, false), false);
  assert.equal(paneLayoutViewportIsWide(PANE_LAYOUT_WIDE_MIN_PX), true);
  assert.equal(paneLayoutViewportIsWide(PANE_LAYOUT_WIDE_MIN_PX - 1), false);
  assert.equal(paneWorkspaceLabel('D:\\work\\beta'), 'beta');
});

test('sidebar drag binds a session and workspace without replacing the group payload', () => {
  const payload = paneDragPayload({ id: sessionA, root: '/work/alpha', workspacePath: '/work/alpha-path' });
  assert.equal(payload?.includes(sessionA), true);
  assert.equal(paneDragPayload({ id: '../escape', root: '/work' }), null);
  assert.equal(paneDragPayload({ id: sessionA, workspacePath: `bad\u0000path` }), null);
  const dropped = readPaneDrop({ getData: type => type === PANE_SESSION_DRAG_MIME ? payload ?? '' : '' });
  assert.deepEqual(dropped, { sessionId: sessionA, workspaceRoot: '/work/alpha-path' });
  const fallback = readPaneDrop({ getData: type => type === 'application/x-xueness-session' ? sessionB : '' });
  assert.deepEqual(fallback, { sessionId: sessionB, workspaceRoot: '' });
  assert.equal(acceptsPaneDrag(['application/x-xueness-session']), true);
  assert.equal(acceptsPaneDrag(['Files']), false);
  assert.notEqual(paneSubscriptionIdentity('primary', sessionA), paneSubscriptionIdentity('secondary', sessionA));
  assert.equal(paneSubscriptionIdentity('primary', '../nope'), null);
});

test('each pane projects its own snapshot and a files-off pane does not require the other', () => {
  const status = 'idle';
  const id = 'sessiona';
  const snapshot = parseConversationSnapshot(id, {
    session: { id, status, task: 'fallback task' },
    journal: { id, status, message_revision: `sha256:${'ab'.repeat(32)}`, messages: [{ role: 'user', content: 'hello pane' }] },
    timeline: { schema: 'xueness.events.v1', protocolVersion: 1, sessionId: id, status, steps: 0, mode: 'agent',
      events: [], cursor: 0, nextCursor: 0, head: 0, hasMore: false },
  });
  const rows = projectSnapshotTimelineRows(snapshot, false);
  assert.equal(rows.some(row => row.kind === 'user' && row.text === 'hello pane'), true);
  assert.equal(projectSnapshotTimelineRows(snapshot, false).some(row => row.kind === 'citation' || row.kind === 'preview'), false);
});
