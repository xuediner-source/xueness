// Real packaged Electron, frozen backend and Windows display scaling. Isolated data only.
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

assert.equal(process.platform, 'win32');
const root = resolve(import.meta.dirname, '..');
const executable = process.env.XUENESS_NATIVE_EXECUTABLE || join(root, 'desktop/release/win-unpacked/Xueness.exe');
const output = process.env.XUENESS_NATIVE_OUTPUT || join(root, 'native-windows-review');
await mkdir(output, { recursive: true });
const temporary = await mkdtemp(join(tmpdir(), 'xueness-native-windows-'));
const report = { views: [], pageErrors: [], modelRequests: [] };
let app;
async function capture(name) {
  let timer;
  const png = await Promise.race([app.evaluate(async ({ BrowserWindow }) => {
    const image = await BrowserWindow.getAllWindows()[0].capturePage(undefined, { stayHidden: true });
    return image.toPNG().toString('base64');
  }), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Native capture timeout')), 10000); })]).finally(() => clearTimeout(timer));
  await writeFile(join(output, name), Buffer.from(png, 'base64'));
}
try {
  for (const scale of [1, 1.5]) {
    const data = join(temporary, `scale-${scale}`);
    await mkdir(join(data, 'state'), { recursive: true });
    await writeFile(join(data, 'state/plugin-state.json'), JSON.stringify({ apiVersion: 1,
      enabled: { onboarding: false, updates: false, diagnostics: false } }));
    const env = { ...process.env, XUENESS_DESKTOP_DATA: data, XUENESS_ALLOW_REAL: '0',
      XUENESS_API_KEY: '', XUENESS_MODEL: '', XUENESS_WORKSPACE_ROOTS: '', XUENESS_MARKETPLACE_URL: '' };
    delete env.ELECTRON_RUN_AS_NODE; delete env.XUENESS_DESKTOP_SMOKE_FILE;
    app = await electron.launch({ executablePath: executable, args: [`--force-device-scale-factor=${scale}`], env, timeout: 45000 });
    const page = await app.firstWindow(); page.setDefaultTimeout(15000);
    page.on('pageerror', error => report.pageErrors.push(error.message));
    page.on('request', request => { if (new URL(request.url()).pathname.endsWith('/run')) report.modelRequests.push(request.url()); });
    await page.getByTestId('xn-desktop-titlebar').waitFor({ state: 'visible' });
    await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows().find(window => !window.isDestroyed()); window.setSize(1080, 760); window.showInactive(); });
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => { localStorage.setItem('xueness.theme', theme); document.documentElement.classList.toggle('dark', theme === 'dark'); }, theme);
      await page.waitForTimeout(100);
      const geometry = await page.evaluate(() => {
        const bar = document.querySelector('[data-testid=xn-desktop-titlebar]');
        const controls = document.querySelector('.xn-desktop-titlebar__actions').getBoundingClientRect();
        return { platform: bar.dataset.platform, width: innerWidth, height: innerHeight, devicePixelRatio,
          controlsRight: innerWidth - controls.right, overflow: document.documentElement.scrollWidth - innerWidth,
          windowToken: getComputedStyle(document.documentElement).getPropertyValue('--bg-window').trim(),
          buttonFont: getComputedStyle(bar.querySelector('button')).fontFamily,
          nodeAccess: typeof window.require !== 'undefined' };
      });
      const native = await app.evaluate(({ BrowserWindow, app }) => ({ background: BrowserWindow.getAllWindows()[0].getBackgroundColor(), data: app.getPath('userData') }));
      assert.equal(geometry.platform, 'windows'); assert.ok(geometry.controlsRight >= 148);
      assert.ok(geometry.overflow <= 1); assert.ok(geometry.buttonFont.startsWith('system-ui'));
      assert.equal(geometry.nodeAccess, false); assert.equal(native.data, data);
      assert.equal(native.background.toLowerCase(), geometry.windowToken.toLowerCase());
      report.views.push({ scale, theme, geometry, native });
      await capture(`native-${theme}-${scale}.png`);
    }
    // Native renderer can reach the backend without leaking desktop control
    // headers or requiring a real model to create a session and open its PTY.
    const session = await page.evaluate(async () => {
      const { csrfToken } = await (await fetch('/api/csrf')).json();
      const response = await fetch('/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({ task: 'Native Windows terminal fixture' }) });
      if (!response.ok) throw new Error(`Session ${response.status}`); return response.json();
    });
    await page.reload();
    await page.getByTestId(`xn-sidebar-item-${session.id}`).click();
    await page.getByTestId('xn-desktop-titlebar-terminal').click();
    const panel = page.locator('.xn-terminal-page');
    await panel.waitFor();
    await panel.getByRole('button', { name: '打开工作区终端', exact: true }).click();
    await panel.getByRole('button', { name: '关闭终端', exact: true }).waitFor();
    for (let n = 0; await panel.getByRole('button', { name: '关闭终端', exact: true }).isDisabled() && n < 100; n++) await page.waitForTimeout(30);
    assert.equal(await panel.getByRole('button', { name: '关闭终端', exact: true }).isDisabled(), false);
    await capture(`terminal-${scale}.png`);
    await panel.getByRole('button', { name: '关闭终端', exact: true }).click();
    await app.close(); app = undefined;
  }
  assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.modelRequests, []);
  console.log('PASS: real packaged Windows titlebar/theme/fonts at 100% and 150%; native session/terminal UI and clean exit');
} finally {
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
  await app?.close();
  assert.ok(resolve(temporary).startsWith(resolve(tmpdir()) + '\\'));
  await rm(temporary, { recursive: true, force: true });
}
