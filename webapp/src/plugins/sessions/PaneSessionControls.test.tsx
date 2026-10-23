import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PaneSessionControls, pendingApprovalMatches } from './PaneSessionControls';
import { getRunChoices } from '../../xuenessBridge';
import type { WorkbenchSession, PendingApproval } from '../../xuenessWorkbench';
import { paneBindingGuard } from './paneRunOptions';
import type { PaneIdentity } from './paneIdentity';
import { RemoteSessionAdapter } from '../remote/remoteSessionAdapter';
import { remoteConnections } from '../remote/remoteConnectionStore';
const id = 'a'.repeat(32);
const identity: PaneIdentity = { groupId: 'group', paneId: 'second', bindingRevision: 1, sessionId: id, scope: { workspaceRoot: '/work' } };
const pending: PendingApproval = { tool_call_id: 'call', kind: 'exec', name: 'exec', subject: '["pwd"]', preview: 'pwd' };
const session = { id, status: 'paused', root: '/work', pending: [pending], pending_question: 'Choose?', queued_messages: [], queue_revision: 1 } as unknown as WorkbenchSession;
const props = { identity, session, enabled: true, choices: getRunChoices(), onChoicesChange: () => undefined, onRefresh: async () => undefined };

test('two pane controls keep approvals scoped to exact pending call and subject', () => {
  const html = renderToStaticMarkup(<><PaneSessionControls {...props} /><PaneSessionControls {...props}
    identity={{ ...identity, paneId: 'third', sessionId: 'b'.repeat(32) }} session={{ ...session, id: 'b'.repeat(32), pending: [{ ...pending, subject: '["date"]' }] }} /></>);
  assert.match(html, /data-pane-id="second"/); assert.match(html, /data-pane-id="third"/);
  assert.equal(pendingApprovalMatches(pending, [{ ...pending, subject: '["date"]' }]), false);
  assert.equal(pendingApprovalMatches(pending, [{ ...pending, tool_call_id: 'other' }]), false);
  assert.equal(pendingApprovalMatches(pending, [pending]), true);
});
test('pane generation and plugin disable invalidate an admitted binding without session-id reliance', () => {
  let live: PaneIdentity | null = identity; let enabled = true;
  const current = paneBindingGuard(identity, () => live, () => enabled);
  assert.equal(current(), true); live = { ...identity, bindingRevision: 2 }; assert.equal(current(), false);
  live = identity; enabled = false; assert.equal(current(), false);
  assert.equal(renderToStaticMarkup(<PaneSessionControls {...props} enabled={false} />), '');
});
test('remote same-id controls never render local question endpoint UI without injected remote transport', () => {
  const owner = { connectionId: 'pane-controls', digest: 'd', generation: 'g', workspaceIdentity: 'remote-work', state: 'connected', capabilities: {durableCommands: true} };
  remoteConnections.publish(owner, []);
  const remote = { ...identity, scope: { workspaceRoot: '/remote', remoteConnectionId: owner.connectionId, workspaceIdentity: 'remote-work' } };
  const html = renderToStaticMarkup(<PaneSessionControls {...props} identity={remote} remoteAdapter={new RemoteSessionAdapter(owner)} />);
  assert.doesNotMatch(html, /data-testid="pending-question"/);
  assert.match(html, /Remote question responses are unavailable|远程答复通道尚不可用/);
  remoteConnections.disconnect(owner.connectionId);
  assert.equal(renderToStaticMarkup(<PaneSessionControls {...props} identity={remote} remoteAdapter={new RemoteSessionAdapter(owner)} />), '');
});
