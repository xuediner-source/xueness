// Production renderer parity, with simulated OS/native update responses.
// This does not claim a Windows native installer or OS permission test.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(import.meta.dirname, '..');
const temporary = await mkdtemp(join(tmpdir(), 'xueness-desktop-parity-state-'));
const output = process.env.XUENESS_PARITY_OUTPUT || join(tmpdir(), 'xueness-desktop-parity-20261007');
await mkdir(output, { recursive: true });
const source = String.raw`
import json, sys, threading
from pathlib import Path
from xueness import web
base, dist = map(Path, sys.argv[1:])
workspace=base/'workspace'; workspace.mkdir()
state=base/'state'; state.mkdir()
(state/'plugin-state.json').write_text(json.dumps({'apiVersion':1,'enabled':{'onboarding':False,'diagnostics':False}}))
ctx=web.build_context(state,base/'runs',workspace,allow_real=False)
ctx['webapp_dir']=dist
server=web.create_server(0,ctx)
threading.Thread(target=server.serve_forever,daemon=True).start()
print(json.dumps({'port':server.server_address[1]}),flush=True)
try: sys.stdin.buffer.read()
finally: server.shutdown(); server.server_close()
`;
const serverScript = join(temporary, 'server.py');
await writeFile(serverScript, source);
const child = spawn(process.env.PYTHON || 'python3', [serverScript, temporary, join(root, 'webapp/dist')], {
  cwd: root, env: { ...process.env, PYTHONPATH: root, XUENESS_API_KEY: '', XUENESS_MODEL: '', XUENESS_MARKETPLACE_URL: '', XUENESS_WORKSPACE_ROOTS: '' },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let browser;
const errors = [], external = [], results = [];
try {
  const ready = await new Promise((accept, reject) => {
    let text = '', stderr = '';
    child.stderr.on('data', data => stderr += data);
    child.stdout.on('data', data => { text += data; if (text.includes('\n')) accept(JSON.parse(text.split('\n')[0])); });
    child.once('exit', code => reject(new Error(`Isolated server exited ${code}: ${stderr}`)));
    setTimeout(() => reject(new Error(`Server timeout: ${stderr}`)), 15000).unref();
  });
  const origin = `http://127.0.0.1:${ready.port}`;
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  for (const [nativePlatform, platform, modifier, installMode] of [
    ['MacIntel', 'macos', 'Meta', 'open-dmg'], ['Win32', 'windows', 'Control', 'restart'],
  ]) for (const theme of ['light', 'dark']) for (const width of [1280, 760]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme, reducedMotion: 'reduce', serviceWorkers: 'block' });
    await context.addInitScript(({ nativePlatform, theme }) => {
      Object.defineProperty(navigator, 'platform', { get: () => nativePlatform });
      localStorage.setItem('xueness.theme', theme);
      localStorage.setItem('xueness.language', 'en');
    }, { nativePlatform, theme });
    const page = await context.newPage(); page.setDefaultTimeout(12000);
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) { external.push(url.href); await route.abort(); return; }
      if (/\/run$/.test(url.pathname)) throw new Error('Verification must never start a model request');
      if (url.pathname === '/api/updates/status') {
        await route.fulfill({ json: { phase: 'current', currentVersion: '0.1.4', canDownload: false, canInstall: false, installMode, reason: '当前已是最新稳定版。' } });
        return;
      }
      await route.continue();
    });
    await page.goto(`${origin}/?xuenessDesktop=1`);
    const bar = page.getByTestId('xn-desktop-titlebar');
    await bar.waitFor({ state: 'visible' });
    assert.equal(await bar.getAttribute('data-platform'), platform);
    const newTask = page.getByTestId('xn-sidebar-action-new-task');
    await newTask.waitFor({ state: 'attached' });
    if (!await newTask.isVisible()) await page.getByTestId('xn-desktop-titlebar-sidebar').click();
    await newTask.waitFor({ state: 'visible' });
    const geometry = await bar.evaluate(node => {
      const rect = node.getBoundingClientRect(), style = getComputedStyle(node);
      const brand = node.querySelector('.xn-desktop-titlebar__brand').getBoundingClientRect();
      const actions = node.querySelector('.xn-desktop-titlebar__actions').getBoundingClientRect();
      return { width: rect.width, height: rect.height, left: brand.left, right: innerWidth - actions.right,
        background: style.backgroundColor, foreground: style.color, overflow: document.body.scrollWidth > innerWidth };
    });
    assert.equal(geometry.width, width);
    assert.equal(geometry.height, 40);
    assert.equal(geometry.overflow, false);
    if (platform === 'macos') { assert.ok(geometry.left >= 78); assert.ok(geometry.right >= 10 && geometry.right < 30); }
    else { assert.ok(geometry.left >= 10 && geometry.left < 30); assert.ok(geometry.right >= 148); }
    const shortcut = await page.getByTestId('xn-sidebar-action-new-task').innerText();
    assert.ok(shortcut.includes(platform === 'macos' ? '⌘N' : 'Ctrl+N'), shortcut);
    // Shared handlers must dispatch the platform-specific primary modifier.
    await page.keyboard.press(`${modifier}+k`);
    await page.getByRole('dialog').waitFor({ state: 'visible' });
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    const sidebar = page.getByTestId('xn-desktop-titlebar-sidebar');
    assert.ok(await sidebar.isEnabled());
    await sidebar.focus();
    assert.equal(await sidebar.evaluate(node => getComputedStyle(node).outlineStyle), 'solid');
    await page.getByTestId('xn-desktop-titlebar-help').click();
    const help = page.locator('.xn-desktop-titlebar__menu');
    await help.waitFor({ state: 'visible' });
    const bounds = await help.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width, 'Titlebar menu stays in the viewport');
    await page.getByTestId('xn-desktop-titlebar-help').click();
    await page.screenshot({ path: join(output, `${platform}-${theme}-${width}.png`) });
    // Inspect the real settings surface and the host-mode-specific update help.
    await page.keyboard.press(`${modifier}+,`);
    await page.getByTestId('xn-settings-search').waitFor({ state: 'visible' });
    await page.getByTestId('xn-settings-search').fill('updates');
    await page.getByTestId('xn-settings-nav-updates').click();
    const installation = page.getByTestId('update-installation-help');
    await installation.waitFor({ state: 'visible' });
    await page.waitForFunction(mode => {
      const text = document.querySelector('[data-testid="update-installation-help"]')?.textContent || '';
      return mode === 'open-dmg' ? text.includes('Finder') : text.includes('Restart and update');
    }, installMode);
    const instructions = await installation.textContent();
    assert.doesNotMatch(instructions, /[\u3400-\u9fff]/);
    assert.equal(await page.getByTestId('desktop-update-indicator').count(), 0);
    results.push({ platform, nativePlatform, simulatedOS: true, theme, width, geometry, shortcut, installMode, instructions });
    await context.close();
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  await writeFile(join(output, 'verification.json'), JSON.stringify({ results, errors, external, nativeWindowsVerified: false }, null, 2));
  console.log(`PASS: 8 production renderer layouts, macOS/Windows controls, theme, shortcuts and update help; no models or external requests. Evidence: ${output}`);
} finally {
  await browser?.close(); child.stdin.end();
  await new Promise(resolve => { if (child.exitCode !== null) resolve(); else { child.once('exit', resolve); setTimeout(() => { child.kill(); resolve(); }, 5000).unref(); } });
  await rm(temporary, { recursive: true, force: true });
}
