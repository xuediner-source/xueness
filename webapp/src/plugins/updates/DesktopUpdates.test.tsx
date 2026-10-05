import React from 'react';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { setLocale, t } from '../../i18n';
import { DesktopUpdates, DesktopUpdateIndicator, UpdateDownloadProgress } from './DesktopUpdates';
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


test('download metrics show observed bytes, rate and an explicitly estimated remaining time', () => {
  const html = renderToStaticMarkup(<UpdateDownloadProgress state={{ phase: 'downloading', percent: 25, transferredBytes: 1024 * 1024, totalBytes: 4 * 1024 * 1024, bytesPerSecond: 512 * 1024, etaSeconds: 6 }} />);
  assert.match(html, /1.0 MB \/ 4.0 MB/);
  assert.match(html, /512.0 KB\/s/);
  assert.match(html, /预计剩余 6 秒/);
  assert.match(html, /25.0%/);
});

test('unknown or invalid metrics never invent zero speed or remaining time', () => {
  const html = renderToStaticMarkup(<UpdateDownloadProgress state={{ phase: 'downloading', percent: Number.NaN, transferredBytes: -1, totalBytes: Infinity, bytesPerSecond: null, etaSeconds: 0 }} />);
  assert.match(html, /正在测量下载速度/);
  assert.match(html, /剩余时间待估算/);
  assert.doesNotMatch(html, /value=|NaN|Infinity|0 B\/s|预计剩余/);
  assert.equal(renderToStaticMarkup(<UpdateDownloadProgress state={{ phase: 'cancelled', bytesPerSecond: 1, etaSeconds: 0 }} />), '');
});


test('a reported zero download rate is displayed without claiming any remaining time', () => {
  const html = renderToStaticMarkup(<UpdateDownloadProgress state={{ phase: 'downloading', transferredBytes: 0, totalBytes: 1024, bytesPerSecond: 0, etaSeconds: 0 }} />);
  assert.match(html, /0 B\/s/);
  assert.match(html, /剩余时间待估算/);
  assert.doesNotMatch(html, /预计剩余|正在测量下载速度/);
});


test('English update controls and known backend status messages are translated', () => {
  setLocale('en');
  try {
    const html = renderToStaticMarkup(<DesktopUpdates enabled />);
    assert.match(html, /Application updates|Automatically download stable updates/);
    assert.doesNotMatch(html, /[\u3400-\u9fff]/);
    assert.equal(t('正在下载更新。'), 'Downloading update.');
    assert.equal(t('当前已是最新稳定版。'), 'You are on the latest stable version.');
  } finally { setLocale('zh'); }
});
