import React from 'react';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { DesktopUpdates, DesktopUpdateIndicator } from './DesktopUpdates';
import { startUpdateStatusPolling, updateActionAvailability } from './updateLifecycle';
test('disabled updates mount no controls and do not claim an installation', () => {
  assert.equal(renderToStaticMarkup(<DesktopUpdates enabled={false} />), '');
  assert.equal(renderToStaticMarkup(<DesktopUpdates enabled={false} compact />), '');
});

test('compact updates expose a small accessible entry instead of a banner', () => {
  const html = renderToStaticMarkup(<DesktopUpdates enabled compact onManage={() => {}} />);
  assert.match(html, /data-testid="desktop-update-indicator"/);
  assert.match(html, /aria-label="应用更新"/);
  assert.match(html, /data-sidebar-navigate="true"/);
  assert.doesNotMatch(html, /<aside|xn-update-notice|查看更新/);
});

test('update indicator marks ready, download and failure states without dumping server errors', () => {
  const ready = renderToStaticMarkup(<DesktopUpdateIndicator state={{ phase: 'ready', version: '0.2.0' }} />);
  assert.match(ready, /data-pending="true"/);
  assert.match(ready, /重启并更新/);
  assert.match(ready, /Xueness 0.2.0/);
  const downloading = renderToStaticMarkup(<DesktopUpdateIndicator state={{ phase: 'downloading', percent: 35 }} />);
  assert.match(downloading, /xn-update-indicator__spinner/);
  assert.match(downloading, /更新下载进度/);
  const failed = renderToStaticMarkup(<DesktopUpdateIndicator state={{ phase: 'error', reason: 'Cannot find latest.yml: Headers: long raw trace' }} />);
  assert.match(failed, /data-error="true"/);
  assert.match(failed, /检查失败/);
  assert.doesNotMatch(failed, /latest.yml|Headers|raw trace/);
  assert.match(renderToStaticMarkup(<DesktopUpdateIndicator state={null} failed />), /data-error="true"/);
  for (const phase of ['disabled', 'unsupported']) assert.equal(renderToStaticMarkup(<DesktopUpdateIndicator state={{ phase }} />), '');
});
test('updater UI explains signed Mac limitation and keeps actions unavailable before status', () => {
  const html = renderToStaticMarkup(<DesktopUpdates enabled />);
  assert.match(html, /自动下载稳定版更新/); assert.match(html, /重启并更新/);
  assert.match(html, /Finder/); assert.match(html, /disabled/); assert.doesNotMatch(html, /安装成功/);
});

test('disabling the update panel ignores an in-flight result and starts no follow-up poll', async () => {
  let resolveStatus!: (state: { phase: string }) => void;
  let reads = 0;
  let applied: Array<{ phase: string }> = [];
  const timers: Array<{ id: number; callback: () => void }> = [];
  const stop = startUpdateStatusPolling({
    readStatus: () => { reads += 1; return new Promise<{ phase: string }>(resolve => { resolveStatus = resolve; }); },
    onStatus: state => applied.push(state), onError: error => { throw error; }, compact: false,
    schedule: callback => { timers.push({ id: timers.length + 1, callback }); return timers.length; },
    cancel: () => {},
  });
  stop();
  resolveStatus({ phase: 'available' });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(reads, 1);
  assert.deepEqual(applied, []);
  assert.deepEqual(timers, []);
});

test('unmount clears a scheduled timer and a queued callback cannot start another request', async () => {
  let reads = 0;
  const timers: Array<{ id: number; delay: number; callback: () => void }> = [];
  const cancelled: unknown[] = [];
  const stop = startUpdateStatusPolling({
    readStatus: async () => { reads += 1; return { phase: 'downloading' }; },
    onStatus: () => {}, onError: error => { throw error; }, compact: true,
    schedule: (callback, delay) => { const id = timers.length + 1; timers.push({ id, delay, callback }); return id; },
    cancel: id => { cancelled.push(id); },
  });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(timers[0]?.delay, 1000);
  stop();
  assert.deepEqual(cancelled, [timers[0]?.id]);
  timers[0]?.callback();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(reads, 1);
});

test('update action affordances distinguish unsupported, downloading, install-ready, and busy states', () => {
  assert.equal(updateActionAvailability(null, false).checkDisabled, true);
  assert.equal(updateActionAvailability({ phase: 'downloading', canDownload: false }, false).checkDisabled, true);
  assert.equal(updateActionAvailability({ phase: 'downloading' }, true).cancelDisabled, true);
  assert.equal(updateActionAvailability({ phase: 'ready', installMode: 'open-dmg' }, false).installDisabled, false);
  assert.equal(updateActionAvailability({ phase: 'available', canDownload: true }, true).downloadDisabled, true);
});
