import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SessionPaneWorkbench, paneLeafReactKey, sidebarPaneBinding, pendingPrimarySelection, type SessionPaneWorkbenchProps } from './SessionPaneWorkbench';
import { initialPaneTree, splitTreePane, closeTreePane } from './paneTree';
import { addPaneGroup, initialPaneGroups } from './paneGroups';
import { paneTreeGeometry } from './paneGeometry';
const binding = {sessionId:'a',scope:{workspaceRoot:'/work'}};
const props: SessionPaneWorkbenchProps = {
  enabled:true, primaryBinding:binding, children:<div data-testid="primary-authority">Primary writable authority</div>,
  initialRunOptions:{provider:'real',mode:'build',permission_mode:'build',browser:false}, filesEffective:false,settingsEffective:false,
  effectivePluginIds:new Set(['sessions']),sendShortcut:'enter',shortcutBindings:{},sessions:[{id:'a',title:'Alpha'}],
  onSelectPrimary:()=>undefined,registerSelection:()=>undefined,registerCreation:()=>undefined,consumeSelectionIntent:()=>false,
};
test('disabled workbench returns primary untouched without render-time side effects', () => {
  const html = renderToStaticMarkup(<SessionPaneWorkbench {...props} enabled={false}/>);
  assert.equal(html, '<div data-testid="primary-authority">Primary writable authority</div>');
});
test('initial workbench renders primary authority exactly once, four directions, no primary close', () => {
  const html = renderToStaticMarkup(<SessionPaneWorkbench {...props}/>);
  assert.equal((html.match(/data-testid="primary-authority"/g)??[]).length,1);
  assert.match(html,/data-pane-id="primary"/);
  for (const title of ['向左分屏','向右分屏','向上分屏','向下分屏']) assert.ok(html.includes(title));
  assert.doesNotMatch(html,/aria-label="关闭分屏"/);
  assert.doesNotMatch(html,/xn-pane-secondary-composer/);
});
test('flat leaf ownership keys survive ancestor split and collapse, while groups isolate secondary keys', () => {
  let tree=initialPaneTree(binding);
  tree=splitTreePane(tree,'primary','right',{...binding,sessionId:'b'},'b','split1');
  const original=paneTreeGeometry(tree.root).leaves.map(leaf=>paneLeafReactKey('g',leaf.paneId));
  tree=splitTreePane(tree,'primary','up',{...binding,sessionId:'c'},'c','split2');
  tree=closeTreePane(tree,'c');
  assert.deepEqual(paneTreeGeometry(tree.root).leaves.map(leaf=>paneLeafReactKey('g',leaf.paneId)),original);
  assert.equal(paneLeafReactKey('g','primary'),paneLeafReactKey('other','primary'));
  assert.notEqual(paneLeafReactKey('g','b'),paneLeafReactKey('other','b'));
  assert.notEqual(paneLeafReactKey('a:b','c'),paneLeafReactKey('a','b:c'));
});
test('container keeps lazy plugin boundary, scoped scroll capture and explicit create ownership bridge',()=>{
  const source=readFileSync(resolve(process.cwd(),'src/XuenessWorkbenchContainer.tsx'),'utf8');
  assert.match(source,/const SessionPaneWorkbench = lazy/);
  assert.doesNotMatch(source,/<SessionPaneLayout|useSessionPaneLayout\(/);
  assert.match(source,/focusedPane\?\.querySelector/);
  assert.match(source,/const promoteCreatedPane = paneCreationRef.current/);
  assert.match(source,/promoteCreatedPane\?\.\(id\)/);
});
test('narrow initial rendering disables all split toolbar actions', () => {
  const html = renderToStaticMarkup(<SessionPaneWorkbench {...props}/>);
  assert.equal((html.match(/disabled=""/g) ?? []).length, 4);
});
test('sidebar interception requires an unambiguous explicit local root', () => {
  const state = addPaneGroup(initialPaneGroups(), 'g', binding, 1);
  assert.deepEqual(sidebarPaneBinding(state, [{ id: 'a', root: '/work' }], 'a'), binding);
  for (const sessions of [[], [{ id: 'a' }], [{ id: 'a', root: '/other' }], [{ id: 'a', root: '/work' }, { id: 'a', root: '/other' }]])
    assert.equal(sidebarPaneBinding(state, sessions, 'a'), null);
  const remote = addPaneGroup(initialPaneGroups(), 'remote', { ...binding, scope: { ...binding.scope, remoteConnectionId: 'ssh' } }, 1);
  assert.equal(sidebarPaneBinding(remote, [{ id: 'a', root: '/work' }], 'a'), null);
});
test('explicit user selection supersedes a failed pending primary request', () => {
  assert.equal(pendingPrimarySelection('missing', 'old', false), true);
  assert.equal(pendingPrimarySelection('missing', 'new-selection', true), false);
  assert.equal(pendingPrimarySelection('loaded', 'loaded', false), false);
  assert.equal(pendingPrimarySelection(undefined, 'old', false), false);
  assert.equal(pendingPrimarySelection(null, 'old', false), true);
  assert.equal(pendingPrimarySelection(null, null, false), false);
});

test('remote primary never renders a local authority before restoration or while disabled', () => {
  const primaryBinding = { ...binding, scope: { workspaceRoot: '/work', remoteConnectionId: 'ssh', workspaceIdentity: 'remote-workspace' } };
  for (const enabled of [true, false]) {
    const html = renderToStaticMarkup(<SessionPaneWorkbench {...props} primaryBinding={primaryBinding} enabled={enabled} />);
    assert.doesNotMatch(html, /primary-authority/);
    assert.match(html, /role="status"/);
    assert.doesNotMatch(html, /xn-pane-secondary-composer/);
  }
});
