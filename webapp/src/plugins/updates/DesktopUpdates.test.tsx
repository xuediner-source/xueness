import React from 'react';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { DesktopUpdates } from './DesktopUpdates';
import { startUpdateStatusPolling, updateActionAvailability } from './updateLifecycle';
test('disabled updates mount no controls and do not claim an installation', () => {
  assert.equal(renderToStaticMarkup(<DesktopUpdates enabled={false} />), '');
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
