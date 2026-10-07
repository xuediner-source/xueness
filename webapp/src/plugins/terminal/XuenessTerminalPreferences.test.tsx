import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { preferredTerminalShell, XuenessTerminalShellSelect } from './XuenessTerminalPreferences';

test('an unset terminal preference follows the actual host shell list on either platform', () => {
  assert.equal(preferredTerminalShell(undefined, [{ id: 'powershell' }, { id: 'cmd' }]), 'powershell');
  assert.equal(preferredTerminalShell('', [{ id: 'pwsh' }]), 'pwsh');
  assert.equal(preferredTerminalShell(undefined, [{ id: '/bin/zsh' }, { id: '/bin/sh' }]), '/bin/zsh');
  assert.equal(preferredTerminalShell(undefined, []), '');
  assert.equal(preferredTerminalShell('cmd', [{ id: 'powershell' }]), 'cmd');
});

test('loading terminal preferences cannot advertise a POSIX shell on Windows', () => {
  const html = renderToStaticMarkup(<XuenessTerminalShellSelect onChange={() => {}} />);
  assert.match(html, /正在加载/);
  assert.match(html, /disabled/);
  assert.doesNotMatch(html, /\/bin\/sh/);
});
