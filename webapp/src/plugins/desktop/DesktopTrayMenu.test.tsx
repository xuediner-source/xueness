import { readFileSync } from 'node:fs';

import { join } from 'node:path';

import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { DesktopTrayMenu, groupTraySessions, shouldDismissTrayMenuOnEscape, type TraySession, type TraySnapshot } from './DesktopTrayMenu';
import { applyDesktopTrayCommand } from './DesktopTrayBridge';

const id = (n: number) => n.toString(16).padStart(32, '0');
const sessions: TraySession[] = Array.from({ length: 12 }, (_, n) => ({ id: id(n), title: `会话 ${n}`, project: 'models',
  status: n > 6 ? 'running' : 'completed', pinned: n >= 3 && n <= 6, updatedAt: '' }));
const snapshot: TraySnapshot = { sessions, sessionsEnabled: true, busy: false, activeId: id(0), locale: 'zh', dark: false, loading: false, failed: false };

test('tray grouping keeps recent order and caps groups without losing overflow chats', () => {
  const groups = groupTraySessions(sessions);
  assert.deepEqual(groups.running.map(row => row.id), [id(7), id(8), id(9)]);
  assert.deepEqual(groups.pinned.map(row => row.id), [id(3), id(4), id(5)]);
  assert.deepEqual(groups.recent.map(row => row.id), [id(0), id(1), id(2)]);
  assert.deepEqual(groups.more.map(row => row.id), [id(6), id(10), id(11)]);
  const duplicate = groupTraySessions([{ ...sessions[0], pinned: true, status: 'running' }, ...sessions.slice(1)]);
  assert.equal(duplicate.more.some(row => row.id === id(0)), false);
});

test('tray renders the screenshot groups, project column, theme and safe titles', () => {
  const html = renderToStaticMarkup(<DesktopTrayMenu snapshot={{ ...snapshot, sessions: [{ ...sessions[0], title: '<script>secret</script>' }], dark: true }} />);
  for (const label of ['运行中', '已固定', '最近', '更多', '新建会话', '发送反馈', '退出 Xueness']) assert.ok(html.includes(label));
  assert.match(html, /xn-tray-menu__project[^>]*>models/);
  assert.match(html, /data-theme="dark"/); assert.doesNotMatch(html, /<script>/); assert.match(html, /&lt;script&gt;/);
  const english = renderToStaticMarkup(<DesktopTrayMenu snapshot={{ ...snapshot, locale: 'en' }} />);
  for (const label of ['Running', 'Pinned', 'Recent', 'More', 'New Chat', 'Send Feedback', 'Exit']) assert.ok(english.includes(label));
});

test('empty, failed, busy and disabled tray menus retain feedback and exit while guarding chat actions', () => {
  const html = renderToStaticMarkup(<DesktopTrayMenu snapshot={{ ...snapshot, sessions: [], sessionsEnabled: false, failed: true }} />);
  assert.match(html, /会话功能已关闭/); assert.match(html, /会话列表暂时不可用/); assert.match(html, /disabled=""[^>]*>新建会话/);
  assert.match(html, /<button[^>]*>发送反馈/); assert.match(html, /<button[^>]*>退出 Xueness/);
  const busy = renderToStaticMarkup(<DesktopTrayMenu snapshot={{ ...snapshot, busy: true }} />);
  assert.match(busy, /disabled=""[^>]*>新建会话/);
  assert.match(busy, /xn-tray-menu__session" title="会话 0"/);
  assert.match(busy, /xn-tray-menu__session" disabled="" title="会话 1"/);
});

test('main workbench bridge rejects disabled, busy and malformed commands and allows the current chat', () => {
  const called: string[] = [];
  const actions = { enabled: true, sessionsEnabled: true, busy: false, activeId: id(0), onNew: () => called.push('new'), onSession: (value: string) => called.push(value) };
  for (const command of [null, {}, { kind: 'feedback' }, { kind: 'session', id: '../secret' }, { kind: 'session', id: undefined }]) applyDesktopTrayCommand(command, actions);
  applyDesktopTrayCommand({ kind: 'new' }, { ...actions, enabled: false });
  applyDesktopTrayCommand({ kind: 'new' }, { ...actions, sessionsEnabled: false });
  applyDesktopTrayCommand({ kind: 'new' }, { ...actions, busy: true });
  applyDesktopTrayCommand({ kind: 'session', id: id(1) }, { ...actions, busy: true });
  assert.deepEqual(called, []);
  applyDesktopTrayCommand({ kind: 'session', id: id(0) }, { ...actions, busy: true });
  applyDesktopTrayCommand({ kind: 'session', id: id(1) }, actions); applyDesktopTrayCommand({ kind: 'new' }, actions);
  assert.deepEqual(called, [id(0), id(1), 'new']);
});

test('tray Escape dismissal guards against IME composition', () => {
  assert.equal(shouldDismissTrayMenuOnEscape({ key: 'Escape' }), true);
  assert.equal(shouldDismissTrayMenuOnEscape({ key: 'Enter' }), false);
  assert.equal(shouldDismissTrayMenuOnEscape({ key: 'Escape', isComposing: true }), false);
  assert.equal(shouldDismissTrayMenuOnEscape({ key: 'Escape', nativeEvent: { isComposing: true } }), false);
  assert.equal(shouldDismissTrayMenuOnEscape({ key: 'Escape', keyCode: 229 }), false);
  assert.equal(shouldDismissTrayMenuOnEscape({ key: 'Escape', nativeEvent: { keyCode: 229 } }), false);
  assert.equal(shouldDismissTrayMenuOnEscape({ key: 'Process' }), false);
  assert.equal(shouldDismissTrayMenuOnEscape({ key: 'Dead' }), false);
  assert.equal(shouldDismissTrayMenuOnEscape({ key: 'Escape', compositionActive: true }), false);
});



test("tray stylesheet uniformly uses 13px font-size without 11px or 12px", () => {

  const css = readFileSync(join(process.cwd(), 'src/plugins/desktop/desktop-tray-menu.css'), 'utf-8');

  const fontSizes = [...css.matchAll(/font-size:\s*([^;]+);/g)].map(m => m[1].trim());

  assert.ok(fontSizes.length > 0);

  for (const size of fontSizes) {

    assert.equal(size, '13px');

  }

  assert.doesNotMatch(css, /font-size:\s*1[124]px/);

});
