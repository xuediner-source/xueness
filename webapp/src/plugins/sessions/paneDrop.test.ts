import test from 'node:test';
import assert from 'node:assert/strict';
import { decodePaneDrop, paneDropSide, readTreePaneDrop } from './paneDrop';
test('bounded structured drops preserve scope and strip untrusted extras', () => {
  assert.deepEqual(decodePaneDrop(JSON.stringify({v:1,sessionId:'a',workspaceRoot:'/work'})), {sessionId:'a',scope:{workspaceRoot:'/work'}});
  assert.deepEqual(decodePaneDrop(JSON.stringify({v:2,sessionId:'a',scope:{workspaceRoot:'/work',workspaceIdentity:'stable',remoteConnectionId:'r',extra:'ignored'}})), {sessionId:'a',scope:{workspaceRoot:'/work',workspaceIdentity:'stable',remoteConnectionId:'r'}});
  for (const raw of ['a', '[]', '{}', 'x'.repeat(4097), '{"v":2,"sessionId":"../bad","scope":{"workspaceRoot":"/"}}', '{"v":2,"sessionId":null,"scope":{"workspaceRoot":"/"}}']) assert.equal(decodePaneDrop(raw), null);
  assert.equal(readTreePaneDrop({getData:()=>{throw new Error('blocked');}}),null);
});
test('drop edges support all four directions', () => {
  assert.equal(paneDropSide(.01,.5),'left'); assert.equal(paneDropSide(.99,.5),'right');
  assert.equal(paneDropSide(.5,.01),'up'); assert.equal(paneDropSide(.5,.99),'down');
});
