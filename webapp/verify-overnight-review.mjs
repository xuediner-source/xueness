#!/usr/bin/env node
// Verify the production build with isolated, explicitly synthetic model/session
// fixtures. No provider request, native permission request, or external network
// call is allowed.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = process.env.XUENESS_REVIEW_OUTPUT || '/tmp/xueness-overnight-review-20261007';
const temporary = await mkdtemp(join(tmpdir(), 'xueness-overnight-ui-'));
const serverSource = String.raw`
import json, sys, threading
from pathlib import Path
from xueness import web
from xueness.bundled_plugins.providers import default_selection, providers_api
base, dist = map(Path, sys.argv[1:])
workspace = base / 'workspace'
workspace.mkdir()
state = base / 'state'
state.mkdir()
(state / 'plugin-state.json').write_text(json.dumps({'apiVersion':1,'enabled':{'updates':False,'onboarding':False,'diagnostics':False}}))
ctx = web.build_context(state, base / 'runs', workspace, allow_real=False)
ctx['webapp_dir'] = dist
status, result = providers_api._handle_save(ctx, {'id':'review-only','name':'Review fixture','baseUrl':'https://127.0.0.1:9/v1','model':'fixture-model','apiKey':'fixture-not-a-real-key','reasoningLevels':['none','low','medium','high','max']})
assert status == 200, result
default_selection.save(state, {'providerId':'review-only','model':'fixture-model','reasoningEffort':'low'})
store = ctx['store']
sessions=[]
for name, count in [('Long review fixture',120),('Short review fixture',3)]:
    session = store.new(name, workspace)
    session['title'] = name
    for i in range(count):
        if i: session['messages'].append({'role':'user','content':f'Fixture request {i+1}'})
        session['messages'].append({'role':'assistant','content':f'Fixture response {i+1}. '+('Synthetic content for layout verification only. '*10)})
    session['status'] = 'completed'
    store.save(session)
    sessions.append(session['id'])
server = web.create_server(0,ctx,host='127.0.0.1')
thread = threading.Thread(target=lambda:server.serve_forever(poll_interval=0.1),daemon=True)
thread.start()
print(json.dumps({'port':server.server_address[1],'sessions':sessions}),flush=True)
try:
    sys.stdin.readline()
finally:
    server.shutdown()
    server.server_close()
    thread.join(timeout=5)
`;
await mkdir(output, { recursive: true });
const script = join(temporary, 'server.py');
await writeFile(script, serverSource);
const child = spawn(process.env.PYTHON || 'python3', [script, temporary, join(root, 'webapp/dist')], {
  // The environment-model catalog entry is built from these isolated dummy
  // values. allow_real stays false, and no run/provider request is made.
  cwd: root, env: {
    ...process.env,
    PYTHONPATH: root,
    XUENESS_ALLOW_REAL: '0',
    XUENESS_PROVIDER: 'openai',
    XUENESS_API_BASE: 'https://127.0.0.1:9/v1',
    XUENESS_MODEL: 'review-environment-model',
    XUENESS_API_KEY: 'fixture-not-a-real-key',
    XUENESS_MARKETPLACE_URL: '',
    XUENESS_WORKSPACE_ROOTS: '',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});
const logs = [];
child.stderr.on('data', value => logs.push(String(value)));
let browser;
const summary = { syntheticFixture: true, productionBuild: join(root, 'webapp/dist'), screenshots: [], views: [], externalRequests: [], pageErrors: [] };
try {
  const ready = await new Promise((accept, reject) => {
    let text = '';
    child.stdout.on('data', value => { text += String(value); if (text.includes('\n')) { try { accept(JSON.parse(text.split('\n')[0])); } catch (error) { reject(error); } } });
    child.once('exit', code => reject(new Error(`Server startup exited ${code}: ${logs.join('')}`)));
    setTimeout(() => reject(new Error(`Server startup timeout: ${logs.join('')}`)), 20000).unref();
  });
  const origin = `http://127.0.0.1:${ready.port}`;
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  for (const scheme of ['light', 'dark']) for (const width of [1280, 420]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: scheme, reducedMotion: 'reduce', serviceWorkers: 'block' });
    await context.addInitScript(({ scheme }) => {
      localStorage.setItem('xueness.theme', scheme);
      localStorage.setItem('xueness.language', 'en');
    }, { scheme });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => summary.pageErrors.push(error.message));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) { summary.externalRequests.push(url.href); await route.abort(); return; }
      if (/\/run$/.test(url.pathname)) throw new Error('A real run must never be requested by this review');
      await route.continue();
    });
    await page.goto(origin);
    await page.getByTestId('xn-shell-sidebar').waitFor({ state:'attached' });
    const longTask = page.getByTestId(`xn-sidebar-item-${ready.sessions[0]}`);
    await longTask.waitFor({ state:'attached' });
    if (!await longTask.isVisible()) await page.getByTestId('xn-shell-sidebar-toggle').click();
    await longTask.click();
    await page.getByTestId('timeline-stream').waitFor({ state:'visible' });
    await page.getByRole('button',{name:'Choose model',exact:true}).click();
    const modelOptions = page.getByTestId('composer-model-options');
    await modelOptions.waitFor({ state:'visible' });
    const modelRows = modelOptions.locator('[data-model-row]');
    const environmentRow = modelOptions.locator('[data-model-row=":review-environment-model"]');
    const fixtureRow = modelOptions.locator('[data-model-row="review-only:fixture-model"]');
    await environmentRow.waitFor({ state:'visible' });
    await fixtureRow.waitFor({ state:'visible' });
    const visibleModels = await modelRows.evaluateAll(nodes => nodes.map(node => node.getAttribute('data-model-row')));
    assert.deepEqual(visibleModels.sort(), [':review-environment-model','review-only:fixture-model'].sort(),
      'the environment model and saved profile must appear together in the unified list');
    assert.equal(await modelOptions.locator('[role="tab"]').count(), 0, 'the model list must not split entries into tabs');

    const edit = page.getByTestId('composer-model-detail-edit');
    await fixtureRow.focus();
    for (let i = 0; i < 8 && !await edit.evaluate(node => node === document.activeElement); i++) await page.keyboard.press('Tab');
    assert.equal(await edit.evaluate(node => node === document.activeElement), true, 'Tab from the focused model row must reach the detail card Edit action');
    try {
      await fixtureRow.click();
    } catch (error) {
      await page.screenshot({path:join(output,`failed-model-${scheme}-${width}.png`)});
      throw new Error(`Model selection ${scheme}/${width}: ${error.message}`);
    }
    assert.match(await page.getByRole('button',{name:'Choose model',exact:true}).innerText(), /Review fixture/,
      'clicking a saved-profile row must select that model');
    const slider = page.getByRole('slider',{name:'Reasoning effort',exact:true});
    await slider.waitFor({state:'visible'});
    await slider.press('End');
    await page.waitForFunction(() => document.querySelector('[data-testid="reasoning-effort-slider-value"]')?.textContent === 'max');
    assert.equal(await slider.getAttribute('aria-valuenow'),await slider.getAttribute('aria-valuemax'));
    assert.deepEqual(await page.locator('.xn-reasoning-slider__energy, .xn-reasoning-slider__star').evaluateAll(nodes => nodes.map(node=>getComputedStyle(node).animationName).filter(name=>name!=='none')), [], 'Reduced-motion slider must not animate');
    await page.getByTestId('session-timeline-scroller').waitFor({ state:'visible' });
    const scroller = page.getByTestId('session-timeline-scroller');
    try {
      await page.waitForFunction(() => { const node = document.querySelector('[data-testid="session-timeline-scroller"]'); return node.scrollHeight > node.clientHeight; });
    } catch (error) {
      await page.screenshot({path:join(output,`failed-${scheme}-${width}.png`)});
      const state = await page.evaluate(() => { const node=document.querySelector('[data-testid="session-timeline-scroller"]'); return {scrollHeight:node?.scrollHeight,clientHeight:node?.clientHeight,items:node?.querySelectorAll('.xn-timeline-item').length,text:document.body.innerText}; });
      throw new Error(`${error.message}\n${JSON.stringify(state)}`);
    }
    await scroller.hover();
    await page.mouse.wheel(0,-500);
    await page.getByTestId('session-back-to-bottom').waitFor({ state:'visible' });
    const geometry = await page.evaluate(() => ({ documentWidth:document.documentElement.scrollWidth, width:innerWidth, theme:document.documentElement.dataset.xnTheme }));
    assert.ok(geometry.documentWidth <= width+1, `Overflow: ${JSON.stringify(geometry)}`);
    assert.equal(geometry.theme, scheme);
    const path = join(output, `conversation-${scheme}-${width}.png`);
    await page.screenshot({ path, animations:'disabled' });
    summary.screenshots.push(path);
    summary.views.push({ scheme, width, modelsVisibleTogether: visibleModels, ...geometry });
    await page.getByTestId('session-back-to-bottom').click();
    await page.waitForFunction(() => { const node = document.querySelector('[data-testid="session-timeline-scroller"]'); return node.scrollHeight-node.scrollTop-node.clientHeight < 80; });
    if (scheme === 'light' && width === 420) {
      await page.getByRole('button',{name:'Choose model',exact:true}).click();
      const savedProfileRow = page.locator('[data-model-row="review-only:fixture-model"]');
      await savedProfileRow.waitFor({ state:'visible' });
      await savedProfileRow.focus();
      const editButton = page.getByTestId('composer-model-detail-edit');
      await editButton.waitFor({ state:'visible' });
      const detailLayout = await page.evaluate(() => {
        const card=document.querySelector('[data-testid="composer-model-detail"]');
        const menu=card?.closest('[role="menu"]');
        const edit=card?.querySelector('[data-testid="composer-model-detail-edit"]');
        const rect=(node) => { const r=node?.getBoundingClientRect(); return r && {left:r.left,top:r.top,right:r.right,bottom:r.bottom}; };
        const cr=rect(card), mr=rect(menu), er=rect(edit);
        const overlap=Boolean(cr && mr && cr.left<mr.right && cr.right>mr.left && cr.top<mr.bottom && cr.bottom>mr.top);
        return {card:cr,menu:mr,edit:er,overlap};
      });
      assert.equal(detailLayout.overlap, false, `narrow detail card must stay outside the model menu: ${JSON.stringify(detailLayout)}`);
      const detailShot = join(output,'model-detail-light-420.png');
      await page.screenshot({path:detailShot});
      summary.screenshots.push(detailShot);
      await editButton.click();
      await page.getByTestId('model-provider-navigation').waitFor({ state:'visible' });
    }
    await context.close();
  }
  assert.deepEqual(summary.externalRequests, []);
  assert.deepEqual(summary.pageErrors, []);
  await writeFile(join(output,'verification.json'),JSON.stringify(summary,null,2));
  console.log(`PASS: production conversation UI, light/dark at 1280/420px, isolated API/session fixtures; ${summary.screenshots.length} screenshots at ${output}`);
} finally {
  if (browser) await browser.close();
  child.stdin.end('\n');
  if (child.exitCode === null) await new Promise(done => { child.once('exit',done); setTimeout(() => { child.kill('SIGTERM'); done(); },5000).unref(); });
  await rm(temporary,{recursive:true,force:true});
}
