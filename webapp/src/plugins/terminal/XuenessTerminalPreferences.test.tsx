import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { preferredTerminalShell, terminalFontStack, XuenessTerminalShellSelect } from './XuenessTerminalPreferences';

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

test('terminal font stacks include both macOS and Windows monospace fonts and fall back to the system stack', () => {
  const system = terminalFontStack('system');
  for (const font of ['Menlo', 'Consolas', '"Cascadia Mono"', '"Microsoft YaHei UI"', '"PingFang SC"']) assert.ok(system.includes(font), font);
  assert.ok(system.trim().endsWith('monospace'));
  // 在 Windows 上选 Menlo 时，缺字体应回到系统等宽栈，而不是直接落到 Courier New
  assert.ok(terminalFontStack('Menlo').startsWith('Menlo, '));
  assert.ok(terminalFontStack('Menlo').includes('Consolas'));
  assert.ok(terminalFontStack('SFMono-Regular').includes('Consolas'));
  assert.equal(terminalFontStack('monospace'), 'monospace');
  assert.equal(terminalFontStack(undefined), system);
});
