import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import {renderToStaticMarkup} from 'react-dom/server';
import {StartPageRemoteDialog, filterRemoteConnections} from './StartPageRemoteDialog';
test('remote catalog is configuration only until an owner handshake succeeds', () => {
  let selected = false;
  const html = renderToStaticMarkup(<StartPageRemoteDialog open connections={[{id:'saved',digest:'d',host:'host'}]}
    onClose={() => undefined} onSelectRemote={() => {selected=true;}} />);
  assert.match(html,/remote-connect-btn-saved/);
  assert.doesNotMatch(html,/data-connection-state="connected"/);
  assert.equal(selected,false);
});
test('disabled remote dialog neither mounts nor selects a connection', () => {
  assert.equal(renderToStaticMarkup(<StartPageRemoteDialog open allowRemote={false} onClose={() => undefined} onSelectRemote={() => {throw new Error('selected');}} />),'');
  assert.equal(filterRemoteConnections([{id:'a',host:'box'},{id:'b',host:'other'}],'box')[0].id,'a');
});
