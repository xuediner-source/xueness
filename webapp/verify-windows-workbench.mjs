// Windows production workbench checks; all API state is temporary and model calls are blocked.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(import.meta.dirname, '..');
const output = process.env.XUENESS_WINDOWS_OUTPUT || join(root, 'windows-review');
const assets = process.env.XUENESS_WINDOWS_ASSETS || join(root, 'webapp/dist');
await mkdir(output, { recursive: true });
const temporary = await mkdtemp(join(tmpdir(), 'xueness-windows-workbench-'));
const source = String.raw`
import json,sys,threading
from pathlib import Path
from xueness import web
base,dist=map(Path,sys.argv[1:])
workspace=base/'workspace';workspace.mkdir()
state=base/'state';state.mkdir()
(state/'plugin-state.json').write_text(json.dumps({'apiVersion':1,'enabled':{'onboarding':False,'diagnostics':False,'updates':False}}))
ctx=web.build_context(state,base/'runs',workspace,allow_real=False);ctx['webapp_dir']=dist
session=ctx['store'].new('Windows approval recovery fixture',workspace)
session.update(status='paused',pause_code='approval_required',pause_reason='等待你批准工具调用；批准后继续。')
session['messages'].append({'role':'assistant','content':'', 'tool_calls':[{'id':'win-approval','type':'function',
    'function':{'name':'write','arguments':json.dumps({'path':'fixture.txt','content':'fixture'})}}]})
session['results']={'win-approval':{'ok':False,'error':'denied','error_code':'approval_required','awaiting_approval':True}}
ctx['store'].save(session)
server=web.create_server(0,ctx);threading.Thread(target=server.serve_forever,daemon=True).start()
print(json.dumps({'port':server.server_address[1],'approvalSession':session['id']}),flush=True)
try:sys.stdin.buffer.read()
finally:server.shutdown();server.server_close()
`;
const serverScript = join(temporary, 'server.py');
await writeFile(serverScript, source);
const child = spawn(process.env.PYTHON || 'python', [serverScript, temporary, assets], {
  cwd: root, env: { ...process.env, PYTHONPATH: root, XUENESS_ALLOW_REAL: '0', XUENESS_API_KEY: '', XUENESS_MODEL: '', XUENESS_MARKETPLACE_URL: '', XUENESS_WORKSPACE_ROOTS: '' },
  windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
});
const report = { errors: [], externalRequests: [], modelRequests: [], views: [], approvalRecovery: null };
let browser;
try {
  const ready = await new Promise((accept, reject) => {
    let text = '', stderr = '';
    child.stderr.on('data', data => stderr += data);
    child.stdout.on('data', data => { text += data; if (text.includes('\n')) accept(JSON.parse(text.split('\n')[0])); });
    child.once('exit', code => reject(new Error(`Server exited ${code}: ${stderr}`)));
    setTimeout(() => reject(new Error(`Server timeout: ${stderr}`)), 15000).unref();
  });
  const origin = `http://127.0.0.1:${ready.port}`;
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  for (const theme of ['light', 'dark']) for (const [width, height, scale] of [[1280, 800, 1], [960, 800, 1], [760, 800, 1], [1024, 600, 1.5]]) {
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale, colorScheme: theme, reducedMotion: 'reduce', serviceWorkers: 'block' });
    await context.addInitScript(({ theme }) => {
      localStorage.setItem('xueness.theme', theme);
      localStorage.setItem('xueness.language', 'zh');
    }, { theme });
    const page = await context.newPage(); page.setDefaultTimeout(12000);
    page.on('pageerror', error => report.errors.push(error.message));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) { report.externalRequests.push(url.href); return route.abort(); }
      if (/\/run$/.test(url.pathname)) { report.modelRequests.push(url.pathname); return route.abort(); }
      return route.continue();
    });
    await page.goto(`${origin}/?xuenessDesktop=1`, { waitUntil: 'networkidle' });
    await page.getByTestId('xn-desktop-titlebar').waitFor({ state: 'visible' });
    if (!process.env.XUENESS_WINDOWS_BASELINE) {
      const composer = await page.locator('.xn-hero__composer').boundingBox();
      assert.ok(composer && composer.y + composer.height < height - 16, `Home composer below fold at ${width}x${height}`);
    }
    const fonts = await page.evaluate(() => {
      const selectors = ['html', 'body', '.xn-sidebar-action', '.xn-desktop-titlebar', 'textarea', 'h1', 'button'];
      return selectors.map(selector => {
        const node = document.querySelector(selector); if (!node) return { selector, absent: true };
        const style = getComputedStyle(node);
        return { selector, fontFamily: style.fontFamily, fontSize: style.fontSize, fontWeight: style.fontWeight, fontToken: style.getPropertyValue('--font-sans').trim(), monoToken: style.getPropertyValue('--font-mono').trim() };
      });
    });
    const cdp = await context.newCDPSession(page);
    await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
    const { root: documentRoot } = await cdp.send('DOM.getDocument');
    const actualFonts = [];
    for (const selector of ['.xn-desktop-titlebar__brand', 'h1', '.xn-sidebar-action span']) {
      const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: documentRoot.nodeId, selector });
      actualFonts.push({ selector, fonts: nodeId ? (await cdp.send('CSS.getPlatformFontsForNode', { nodeId })).fonts : [] });
    }
    if (!process.env.XUENESS_WINDOWS_BASELINE) {
      // Codex 风格已不再使用衬线令牌；无衬线与等宽令牌须保留 Windows 中文回退且不落到宋体。
      for (const token of ['fontToken', 'monoToken']) {
        assert.ok(fonts.some(font => font[token] && font[token].includes('Microsoft YaHei UI') && !/SimSun/.test(font[token])), `${token} CJK fallback`);
      }
      for (const font of fonts.filter(font => !font.absent)) {
        assert.ok(font.fontFamily.startsWith('system-ui'), `Inconsistent font: ${JSON.stringify(font)}`);
      }
    }
    const view = { theme, width, height, scale, fonts, actualFonts, pages: [] };
    report.views.push(view);
    await page.screenshot({ path: join(output, `home-${theme}-${width}.png`) });
    const newTask = page.getByTestId('xn-sidebar-action-new-task');
    if (!await newTask.isVisible()) await page.getByTestId('xn-desktop-titlebar-sidebar').click();
    await newTask.waitFor({ state: 'visible' });
    for (const [action, panel] of [['automations', 'automations-panel'], ['marketplace', 'marketplace-panel']]) {
      const navigation = page.getByTestId(`xn-sidebar-action-${action}`);
      if (!await navigation.isVisible()) await page.getByTestId('xn-desktop-titlebar-sidebar').click();
      await navigation.click();
      await page.getByTestId(panel).waitFor({ state: 'visible' });
      if (action === 'automations') await page.getByTestId(panel).getByRole('button', { name: '刷新', exact: true }).first().waitFor({ state: 'visible' });
      if (action === 'marketplace') await page.getByTestId('marketplace-list').waitFor({ state: 'visible' });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await page.screenshot({ path: join(output, `${action}-${theme}-${width}.png`) });
      const geometry = await page.evaluate(() => ({ viewport: innerWidth, width: document.documentElement.scrollWidth, family: getComputedStyle(document.body).fontFamily }));
      view.pages.push({ action, ...geometry });
      assert.ok(geometry.width <= geometry.viewport + 1, `${action} overflows at ${width}`);
      if (action === 'marketplace') {
        const grid = page.getByTestId('marketplace-list');
        view.gridStyles = await grid.evaluate(node => ({ padding: getComputedStyle(node).padding, background: getComputedStyle(node).backgroundColor,
          rules: [...document.styleSheets].flatMap(sheet => [...sheet.cssRules].filter(rule => rule.selectorText && node.matches(rule.selectorText)).map(rule => rule.cssText)) }));
        await page.getByTestId('marketplace-card-detail').first().click();
        await page.getByTestId('marketplace-detail').waitFor();
        await page.getByTestId('marketplace-back').click();
        const search = page.getByTestId('marketplace-search');
        await search.fill('no matching extension');
        await page.getByTestId('marketplace-empty').waitFor();
        await search.fill('');
        await grid.waitFor();
      }
    }
    await context.close();
  }
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
  await context.addInitScript(() => localStorage.setItem('xueness.language', 'zh'));
  const page = await context.newPage(); page.setDefaultTimeout(12000);
  page.on('pageerror', error => report.errors.push(error.message));
  let approvalPosts = 0, resumePosts = 0, releaseResume;
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) { report.externalRequests.push(url.href); return route.abort(); }
    if (route.request().method() === 'POST' && url.pathname.endsWith('/approvals')) approvalPosts++;
    if (route.request().method() === 'POST' && url.pathname.endsWith('/run')) {
      resumePosts++;
      await new Promise(resolve => releaseResume = resolve);
      releaseResume = undefined;
      return route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'Synthetic unavailable provider' }) });
    }
    return route.continue();
  });
  await page.goto(`${origin}/?xuenessDesktop=1`);
  await page.getByTestId(`xn-sidebar-item-${ready.approvalSession}`).click();
  await page.getByRole('button', { name: '批准并重试', exact: true }).click();
  const busyResume = page.getByRole('button', { name: '正在继续…', exact: true });
  await busyResume.waitFor(); assert.equal(await busyResume.isDisabled(), true);
  for (let n = 0; !releaseResume && n < 100; n++) await page.waitForTimeout(20);
  assert.ok(releaseResume, 'Approval did not start the resume request'); releaseResume();
  await page.getByRole('button', { name: '继续执行', exact: true }).waitFor();
  await page.getByText('已批准，等待执行', { exact: true }).waitFor();
  assert.equal(approvalPosts, 1); assert.equal(resumePosts, 1);
  await page.getByRole('button', { name: '继续执行', exact: true }).click();
  for (let n = 0; !releaseResume && n < 100; n++) await page.waitForTimeout(20);
  assert.ok(releaseResume); releaseResume();
  await page.getByRole('button', { name: '继续执行', exact: true }).waitFor();
  assert.equal(approvalPosts, 1, 'Retry incorrectly created another approval');
  assert.equal(resumePosts, 2);
  report.approvalRecovery = { approvalPosts, resumePosts, duplicateApproval: false, repeatedClickDisabled: true };
  await page.screenshot({ path: join(output, 'approval-recovery.png') });
  await context.close();
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.externalRequests, []);
  assert.deepEqual(report.modelRequests, []);
  console.log(`PASS: ${report.views.length} Windows workbench views; no external/model requests or page errors`);
} finally {
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
  await browser?.close();
  child.stdin.end();
  await new Promise(accept => { if (child.exitCode !== null) return accept(); child.once('exit', accept); setTimeout(() => { child.kill(); accept(); }, 5000).unref(); });
  await rm(temporary, { recursive: true, force: true });
}
