import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { DesktopBrowserImport, browserImportError, browserRuntimeLabel, importChromeProfile, readBrowserRuntime, readChromeProfiles, type BrowserRuntime } from './DesktopBrowserImport';

const desktop: BrowserRuntime = { available: true, browser: 'Chrome', reason: null, desktop: true, importEnabled: true };
const render = (runtime: BrowserRuntime | null, enabled = true) => renderToStaticMarkup(<DesktopBrowserImport enabled={enabled} disabled={false} runtime={runtime} onImported={() => {}} onPendingChange={() => {}} />);

test('profile import distinguishes desktop, web, disabled plugins and an unavailable runtime', () => {
  assert.doesNotMatch(render(desktop), /disabled=""|网页版/);
  assert.match(render({ ...desktop, desktop: false, importEnabled: false }), /网页版无法导入本机 Chrome 资料/);
  assert.match(render({ ...desktop, importEnabled: false }), /请启用桌面集成/);
  assert.match(render(desktop, false), /disabled=""/);
  assert.match(render(null), /正在检查桌面浏览器能力/);
  assert.match(render({ ...desktop, available: false, browser: null, reason: 'driver_missing' }), /浏览器运行环境不可用/);
  assert.equal(browserRuntimeLabel(desktop, true), 'Chrome · 浏览器环境可用');
  assert.match(browserRuntimeLabel({ ...desktop, available: false, browser: null, reason: 'browser_missing' }, true), /未检测到 Chrome/);
});

test('import clients send only the selected ID and explicit confirmation; invalid IDs never issue requests', async () => {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; body: unknown; method: string }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const value = url === '/api/csrf' ? { csrfToken: 'fixture' }
      : url.endsWith('/runtime') ? desktop
      : init?.method === 'POST' ? { ok: true, cleanupPending: true }
      : { profiles: [{ id: 'Default', name: 'Personal fixture' }] };
    return Response.json(value);
  }) as typeof fetch;
  try {
    assert.deepEqual(await readBrowserRuntime(), desktop);
    assert.deepEqual(await readChromeProfiles(), [{ id: 'Default', name: 'Personal fixture' }]);
    assert.equal(await importChromeProfile('Default'), true);
    assert.deepEqual(calls.find(row => row.method === 'POST')?.body, { profileId: 'Default', confirmed: true });
    const before = calls.length;
    await assert.rejects(importChromeProfile('../outside'));
    assert.equal(calls.length, before);
  } finally { globalThis.fetch = original; }
});

test('malformed runtime/profile responses fail closed and errors never expose server paths', async () => {
  const original = globalThis.fetch;
  let payload: unknown = { ...desktop, browser: null };
  globalThis.fetch = (async () => Response.json(payload)) as typeof fetch;
  try {
    await assert.rejects(readBrowserRuntime(), /状态无效/);
    payload = { profiles: [{ id: ['Default'], name: 'fixture' }] };
    await assert.rejects(readChromeProfiles(), /列表无效/);
    payload = null;
    await assert.rejects(readChromeProfiles(), /列表无效/);
    assert.match(browserImportError(new Error('close_chrome')), /完全退出 Chrome/);
    assert.match(browserImportError(new Error('tasks_running')), /结束运行中的任务/);
    assert.doesNotMatch(browserImportError(new Error('C:\\private\\fixture token')), /private|token/);
  } finally { globalThis.fetch = original; }
});
