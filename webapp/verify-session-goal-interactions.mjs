#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const webappRoot = dirname(fileURLToPath(import.meta.url));
const browserChannel = process.env.PLAYWRIGHT_CHANNEL?.trim() || 'chrome';
const tempRoot = await mkdtemp(join(webappRoot, '.session-goal-test-'));
let server, browser;
let pauseBody;
try {
  const componentPath = resolve(webappRoot, 'src/plugins/planning/SessionGoal.tsx');
  const harnessPath = join(tempRoot, 'harness.tsx');
  const bundlePath = join(tempRoot, 'harness.js');
  const htmlPath = join(tempRoot, 'index.html');
  await writeFile(harnessPath, `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { SessionGoal } from ${JSON.stringify(componentPath)};
    import { PaneOptionToolbar } from ${JSON.stringify(resolve(webappRoot, 'src/plugins/sessions/PaneOptionToolbar.tsx'))};
    const state = { changed: 0 };
    window.__goalTest = state;
    const goal = { id: 'a'.repeat(32), summaryTitle: '目标摘要', text: '完整的目标文本', status: 'active',
      setAt: '2026-10-05T10:00:00Z', updatedAt: '2026-10-05T10:00:00Z', history: [], budget: {} };
    createRoot(document.getElementById('root')).render(
      <><SessionGoal sessionId={'b'.repeat(32)} goal={goal} running onChanged={() => { state.changed += 1; }} />
      <PaneOptionToolbar enabled effectivePluginIds={new Set(['sessions', 'planning'])} remote={false} remoteCommands={false}
        root="" sessionId={null} choices={{permission_mode:'build'}} onChange={choices => { state.mode = choices.permission_mode; }}
        isCurrent={() => true} ensurePermission={async choices => choices} /></>
    );
  `);
  await writeFile(htmlPath, '<!doctype html><html lang="zh-CN"><body><div id="root"></div><script src="/harness.js"></script></body></html>');
  await build({ entryPoints: [harnessPath], outfile: bundlePath, bundle: true, platform: 'browser', format: 'iife', target: 'es2020',
    jsx: 'automatic', nodePaths: [join(webappRoot, 'node_modules')], loader: { '.css': 'empty' }, logLevel: 'warning' });

  server = createServer(async (request, response) => {
    if (request.method !== 'GET') { response.writeHead(405).end(); return; }
    if (request.url === '/' || request.url === '/index.html') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(await readFile(htmlPath));
    } else if (request.url === '/harness.js') {
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }).end(await readFile(bundlePath));
    } else response.writeHead(404).end();
  });
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const port = server.address().port;
  browser = await chromium.launch({ channel: browserChannel, headless: true });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    if (request.url().endsWith('/api/csrf')) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ csrfToken: 'test-token' }) });
    } else if (request.method() === 'POST' && request.url().endsWith('/goal')) {
      pauseBody = request.postDataJSON();
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ session: 'b'.repeat(32), goal: { status: 'paused' } }) });
    } else await route.abort();
  });
  await page.goto(`http://127.0.0.1:${port}/`);
  const pause = page.getByRole('button', { name: '暂停目标' });
  const clear = page.getByRole('button', { name: '清除目标' });
  await page.waitForFunction(() => Boolean(window.__goalTest));
  await page.locator('[data-testid="session-goal"] summary').click();
  assert.equal(await pause.isDisabled(), false, 'running active goals still allow a pause request');
  assert.equal(await clear.isDisabled(), true, 'running sessions keep clear disabled');
  await pause.click();
  await page.waitForFunction(() => window.__goalTest.changed === 1);
  assert.deepEqual(pauseBody, { action: 'pause' }, 'pause goes through the goal HTTP owner');
  await page.locator('[data-testid="pane-option-toolbar"] [data-shortcut-action="open-mode-menu"]').click();
  const guarded = page.getByRole('menuitemradio', { name: '守护执行' });
  assert.match(await guarded.getAttribute('title'), /危险命令/);
  const evidence = resolve(webappRoot, '../验收资料/验证记录');
  await mkdir(evidence, { recursive: true });
  await page.screenshot({ path: join(evidence, 'z8-goal-guarded-ui.png'), fullPage: true });
  await guarded.click();
  await page.waitForFunction(() => window.__goalTest.mode === 'guarded');
  assert.deepEqual(pageErrors, [], 'interaction finishes without runtime errors');
  console.log(`Session goal interaction regression passed using ${browserChannel} Chrome.`);
} finally {
  let cleanupError;
  try { await browser?.close(); } catch (error) { cleanupError = error; }
  try {
    if (server?.listening) await new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
  } catch (error) { cleanupError ??= error; }
  try { await rm(tempRoot, { recursive: true, force: true }); } catch (error) { cleanupError ??= error; }
  if (cleanupError) throw cleanupError;
}
