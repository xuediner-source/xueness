import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { PaneSplitControls, SessionPaneLayout } from './SessionPaneLayout';
import { SessionPaneSplit } from './SessionPaneSplit';
import { SecondaryConversationPane } from './secondaryConversationPane';
import { bindSecondaryPane, initialPaneLayout, splitPaneLayout } from './paneLayout';

const sessionA = 'a'.repeat(32);

test('split controls and the second pane stay absent until the layout is wide and open', () => {
  const controls = renderToStaticMarkup(<PaneSplitControls split="column" onSplitRight={() => undefined} onSplitDown={() => undefined} />);
  assert.match(controls, /data-testid="xn-pane-split-right"/u);
  assert.match(controls, /data-testid="xn-pane-split-down"[^>]*aria-pressed="true"/u);
  const closed = renderToStaticMarkup(<SessionPaneLayout wide layout={initialPaneLayout()} onFocus={() => undefined} onClose={() => undefined}
    onDropSession={() => undefined} secondary={null} secondaryTitle="" secondaryWorkspace=""><p data-testid="primary-only">primary</p></SessionPaneLayout>);
  assert.match(closed, /data-testid="primary-only"/u);
  assert.doesNotMatch(closed, /xn-pane-secondary|xn-pane-divider/u);
  const narrow = splitPaneLayout(initialPaneLayout(), 'row');
  const collapsed = renderToStaticMarkup(<SessionPaneLayout wide={false} layout={narrow} onFocus={() => undefined} onClose={() => undefined}
    onDropSession={() => undefined} secondary={<p>hidden</p>} secondaryTitle="other" secondaryWorkspace="/work"><p>primary</p></SessionPaneLayout>);
  assert.doesNotMatch(collapsed, /xn-pane-secondary|xn-pane-divider|hidden/u);
  const disabled = renderToStaticMarkup(<SessionPaneLayout enabled={false} wide layout={narrow} onFocus={() => undefined} onClose={() => undefined}
    onDropSession={() => undefined} secondary={<p>hidden</p>} secondaryTitle="other" secondaryWorkspace="/work"><p>primary</p></SessionPaneLayout>);
  assert.doesNotMatch(disabled, /data-testid="xn-pane-layout"|xn-pane-divider/u);
});

test('an open split shows focus, workspace binding, drop target and close without a second composer', () => {
  const empty = renderToStaticMarkup(<SessionPaneSplit wide layout={splitPaneLayout(initialPaneLayout(), 'column')} onFocus={() => undefined}
    onClose={() => undefined} onDropSession={() => undefined} secondary={null} secondaryTitle="" secondaryWorkspace="">
    <p data-testid="primary-body">primary</p>
  </SessionPaneSplit>);
  assert.match(empty, /data-testid="xn-pane-layout"[^>]*data-orientation="column"/u);
  assert.match(empty, /data-testid="xn-pane-primary"[^>]*data-focused="true"/u);
  assert.match(empty, /data-testid="xn-pane-drop"/u);
  assert.match(empty, /把侧栏会话拖到这里/u);
  assert.match(empty, /data-testid="xn-pane-close"/u);
  assert.match(empty, /data-testid="xn-pane-divider"[^>]*role="separator"[^>]*aria-orientation="horizontal"/u);
  assert.doesNotMatch(empty, /xn-composer|textarea/u);
  const bound = bindSecondaryPane(splitPaneLayout(initialPaneLayout(), 'row'), { sessionId: sessionA, workspaceRoot: '/work/alpha' });
  const html = renderToStaticMarkup(<SessionPaneSplit wide layout={bound} onFocus={() => undefined} onClose={() => undefined}
    onDropSession={() => undefined} secondary={<p data-testid="secondary-body">transcript</p>} secondaryTitle="Alpha task" secondaryWorkspace="/work/alpha">
    <p>primary</p>
  </SessionPaneSplit>);
  assert.match(html, /data-orientation="row"/u);
  assert.match(html, /data-pane="secondary"[^>]*data-focused="true"/u);
  assert.match(html, /data-testid="secondary-body"/u);
  assert.match(html, /Alpha task/u);
  assert.match(html, /title="\/work\/alpha"/u);
  assert.match(html, />alpha</u);
  assert.doesNotMatch(html, /data-testid="xn-pane-drop"/u);
  assert.match(html, /data-testid="xn-pane-divider"[^>]*role="separator"[^>]*aria-orientation="vertical"[^>]*aria-valuemin="25"[^>]*aria-valuemax="75"[^>]*aria-valuenow="50"[^>]*tabindex="0"/u);
  assert.match(html, /style="--xn-pane-ratio:0.5"/u);
});

test('the secondary conversation keeps its subscriber and mounts its own composer', () => {
  const html = renderToStaticMarkup(<SecondaryConversationPane sessionId={sessionA} subscriberId={`sessions.pane:secondary:${sessionA}`}
    enabled filesEffective={false} workspaceRoot="/work/alpha" />);
  assert.match(html, new RegExp(`data-subscriber="sessions\\.pane:secondary:${sessionA}"`));
  assert.match(html, /data-connected="false"/u);
  assert.match(html, /data-testid="xn-pane-secondary-connection"/u);
  assert.match(html, /data-testid="xn-pane-secondary-composer"/u);
  assert.match(html, new RegExp(`data-draft-key="pane-secondary:${sessionA}"`));
  assert.match(html, /data-rich-composer="true"/u);
  assert.match(html, /<textarea/u);
  assert.doesNotMatch(html, new RegExp(`data-draft-key="session:${sessionA}"`));
  const disabled = renderToStaticMarkup(<SecondaryConversationPane sessionId={sessionA} subscriberId={`sessions.pane:secondary:${sessionA}`}
    enabled={false} filesEffective={false} workspaceRoot="/work/alpha" />);
  assert.doesNotMatch(disabled, /data-testid="xn-pane-secondary-connection"/u);
  assert.doesNotMatch(disabled, /xn-pane-secondary-composer|xn-composer|<textarea/u);
});
