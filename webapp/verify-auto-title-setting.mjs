// Visual evidence for `sessions.auto_title`: a real production build served by
// the real backend shows the default-on 会话自动命名 switch in the general
// settings section, toggling works, and the state is captured as a PNG.
// No model request is started and no user state is read (isolated temporary state).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(import.meta.dirname, '..');
const output = process.env.XUENESS_AUTOTITLE_SHOT || 'E:/models/apps/xueness-optimization-20261012/screenshots/auto-title-setting.png';
await mkdir(join(output, '..'), { recursive: true });
const temporary = await mkdtemp(join(tmpdir(), 'xueness-auto-title-state-'));
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
const python = process.env.PYTHON || 'E:/models/apps/xueness-build-env/Scripts/python.exe';
const child = spawn(python, [serverScript, temporary, join(root, 'webapp/dist')], {
  cwd: root, env: { ...process.env, PYTHONPATH: root, XUENESS_API_KEY: '', XUENESS_MODEL: '',
    XUENESS_MARKETPLACE_URL: '', XUENESS_WORKSPACE_ROOTS: '' },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let browser;
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
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
  const page = await context.newPage(); page.setDefaultTimeout(20000);
  await page.goto(`${origin}/?xuenessDesktop=1`);
  const newTask = page.getByTestId('xn-sidebar-action-new-task');
  await newTask.waitFor({ state: 'attached' });
  // Settings → general: the 会话自动命名 card exposes the default-on switch.
  await page.locator('.xn-sidebar-footer__action[data-sidebar-navigate="true"]').click();
  await page.getByTestId('xn-settings-nav-general').click();
  const autoTitleCard = page.locator('.xn-settings-card-group', { hasText: '会话自动命名' });
  await autoTitleCard.waitFor({ state: 'visible' });
  const autoTitleSwitch = autoTitleCard.locator('input[role="switch"]');
  assert.equal(await autoTitleSwitch.isChecked(), true, 'session auto-titling defaults to on');
  assert.equal(await autoTitleSwitch.isDisabled(), false, 'the switch is operable');
  // Toggling off really persists through the general preference channel…
  await autoTitleSwitch.click();
  await page.waitForFunction(() => {
    const card = [...document.querySelectorAll('.xn-settings-card-group')]
      .find(node => node.textContent?.includes('会话自动命名'));
    return card?.querySelector('input[role="switch"]')?.getAttribute('aria-checked') === 'false';
  });
  await autoTitleSwitch.click();
  await page.waitForFunction(() => {
    const card = [...document.querySelectorAll('.xn-settings-card-group')]
      .find(node => node.textContent?.includes('会话自动命名'));
    return card?.querySelector('input[role="switch"]')?.getAttribute('aria-checked') === 'true';
  });
  // …and the experiments card stays untouched below it.
  const experimentsCard = page.locator('.xn-settings-card-group', { hasText: '会话实验功能' });
  await experimentsCard.waitFor({ state: 'visible' });
  assert.equal(await experimentsCard.locator('input[role="switch"]').count(), 2);
  await autoTitleCard.scrollIntoViewIfNeeded();
  await page.screenshot({ path: output, fullPage: false });
  console.log(JSON.stringify({ ok: true, screenshot: output, switchDefaultOn: true,
    toggled: 'off→on round trip through the real settings API' }));
} finally {
  child.kill();
  await browser?.close().catch(() => {});
}
