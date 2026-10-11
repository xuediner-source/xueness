import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { collectSessionNotifications } from './DesktopNotificationsBridge';
import { DesktopNotificationSettings } from './DesktopNotificationSettings';

const id = (n: number) => n.toString(16).padStart(32, '0');

test('session transitions map to approval, question, failed and completed notifications', () => {
  const previous = new Map([[id(1), 'running'], [id(2), 'running'], [id(3), 'running'], [id(4), 'paused'], [id(5), 'running']]);
  const requests = collectSessionNotifications(previous, [
    { id: id(1), title: '导入数据', status: 'needs_review' },
    { id: id(2), task: '整理报告', status: 'awaiting_user' },
    { id: id(3), status: 'failed' },
    { id: id(4), status: 'provider_error' },
    { id: id(5), status: 'completed' },
  ]);
  assert.deepEqual(requests.map(request => request.kind), ['approval', 'question', 'failed', 'failed', 'completed']);
  assert.equal(requests[0].sessionTitle, '导入数据');
  assert.equal(requests[1].sessionTitle, '整理报告', 'the task text backs the title up');
  assert.equal(requests[2].sessionId, id(3));
});

test('transitions never replay on the first snapshot, repeats or unknown statuses', () => {
  const sessions = [{ id: id(1), status: 'needs_review' }, { id: id(2), status: 'weird_status' }];
  assert.deepEqual(collectSessionNotifications(new Map(), sessions), [], 'the first snapshot is silent');
  const previous = new Map([[id(1), 'needs_review'], [id(2), 'running']]);
  assert.deepEqual(collectSessionNotifications(previous, sessions), []);
  // A session missing from the previous map (archived, or new) stays silent.
  assert.deepEqual(collectSessionNotifications(new Map([[id(2), 'running']]), sessions), []);
  const long = { id: id(1), task: '长'.repeat(300), status: 'needs_review' };
  const request = collectSessionNotifications(new Map([[id(1), 'running']]), [long]);
  assert.equal(request[0].sessionTitle.length, 140, 'titles stay inside the preload attribute budget');
  for (const broken of [null, {}, { id: 42, status: 'failed' }, { id: id(1) }]) {
    assert.deepEqual(collectSessionNotifications(new Map([[id(1), 'running']]), [broken as never]), []);
  }
  const duplicated = collectSessionNotifications(new Map([[id(1), 'running']]),
    [{ id: id(1), status: 'failed' }, { id: id(1), title: '第二次', status: 'completed' }]);
  assert.equal(duplicated.length, 1, 'one status per session per refresh');
  assert.equal(duplicated[0].kind, 'failed');
});

test('the settings switch defaults on and respects persisted values', () => {
  const html = renderToStaticMarkup(<DesktopNotificationSettings values={{}} onUpdate={() => undefined} />);
  assert.match(html, /桌面通知/);
  assert.match(html, /系统通知/);
  assert.match(html, /checked=""/, 'the switch is on by default');
  const off = renderToStaticMarkup(<DesktopNotificationSettings values={{ desktopNotificationsEnabled: false }} onUpdate={() => undefined} />);
  assert.doesNotMatch(off, /checked=""/);
  const disabled = renderToStaticMarkup(<DesktopNotificationSettings values={{}} disabled />);
  assert.match(disabled, /disabled=""/);
});
