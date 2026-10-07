// Production UI, isolated state, synthetic provider credentials. All inference
// starts are intercepted; this checks UI/request wiring, not model performance.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(import.meta.dirname, '..');
const temporary = await mkdtemp(join(tmpdir(), 'xueness-effort-fixture-'));
const output = join(tmpdir(), 'xueness-reasoning-effort-20261007');
await mkdir(output, { recursive: true });
const source = String.raw`
import json, sys, threading
from pathlib import Path
from xueness import web
from xueness.bundled_plugins.providers import providers_api, default_selection
base, dist = map(Path, sys.argv[1:])
workspace=base/'workspace'; workspace.mkdir()
state=base/'state'; state.mkdir()
(state/'plugin-state.json').write_text(json.dumps({'apiVersion':1,'enabled':{'updates':False,'onboarding':False,'diagnostics':False}}))
ctx=web.build_context(state,base/'runs',workspace,allow_real=True)
ctx['webapp_dir']=dist
for ident,levels in [('fixture',['low','medium','high']),('unknown',[]),('single',['high'])]:
 status,result=providers_api._handle_save(ctx,{'id':ident,'name':'Synthetic '+ident,'baseUrl':'https://127.0.0.1:9/v1','model':ident+'-model','apiKey':'not-a-real-key','reasoningLevels':levels})
 assert status==200,result
default_selection.save(state,{'providerId':'fixture','model':'fixture-model'})
server=web.create_server(0,ctx)
threading.Thread(target=server.serve_forever,daemon=True).start()
print(json.dumps({'port':server.server_address[1]}),flush=True)
try: sys.stdin.buffer.read()
finally: server.shutdown(); server.server_close()
`;
const script = join(temporary, 'server.py');
await writeFile(script, source);
const child = spawn(process.env.PYTHON || 'python3', [script, temporary, join(root, 'webapp/dist')], {
  cwd: root, env: { ...process.env, PYTHONPATH: root, XUENESS_API_KEY: '', XUENESS_MODEL: '', XUENESS_MARKETPLACE_URL: '', XUENESS_WORKSPACE_ROOTS: '' },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let browser;
const errors = [], external = [], results = [], runBodies = [];
try {
  const ready = await new Promise((accept, reject) => {
    let text = '', stderr = '';
    child.stderr.on('data', data => stderr += data);
    child.stdout.on('data', data => { text += data; if (text.includes('\n')) accept(JSON.parse(text.split('\n')[0])); });
    child.once('exit', code => reject(new Error(`Fixture exited ${code}: ${stderr}`)));
    setTimeout(() => reject(new Error(`Fixture timeout: ${stderr}`)), 15000).unref();
  });
  const origin = `http://127.0.0.1:${ready.port}`;
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  for (const theme of ['light', 'dark']) for (const width of [1280, 420]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme, reducedMotion: 'reduce' });
    await context.addInitScript(theme => { localStorage.setItem('xueness.theme', theme); localStorage.setItem('xueness.language', 'en'); }, theme);
    const page = await context.newPage(); page.setDefaultTimeout(12000);
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== origin) { external.push(url.href); await route.abort(); return; }
      if (request.method() === 'POST' && /^\/api\/sessions\/[^/]+\/run$/.test(url.pathname)) {
        runBodies.push(request.postDataJSON());
        await route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ error: 'Synthetic request capture; no inference started.' }) });
        return;
      }
      await route.continue();
    });
    await page.goto(origin);
    const trigger = page.getByTestId('reasoning-effort-trigger');
    try { await trigger.waitFor({ state: 'visible' }); }
    catch (error) {
      await page.screenshot({ path: join(output, 'startup-failure.png') });
      await writeFile(join(output, 'startup-failure.txt'), await page.locator('body').innerText());
      throw error;
    }
    for (const profile of ['standard', 'lightweight']) {
      if (profile === 'lightweight') {
        await page.getByRole('button', { name: 'Choose model', exact: true }).click();
        await page.getByRole('menuitemradio', { name: 'Local lightweight', exact: true }).click();
        await trigger.waitFor({ state: 'visible' });
      }
      await trigger.click();
      const slider = page.getByRole('slider', { name: 'Reasoning effort', exact: true });
      await slider.press('End');
      assert.equal(await slider.getAttribute('aria-valuetext'), 'High');
      assert.match(await trigger.innerText(), /High/);
      await page.waitForFunction(() => {
        const r = document.querySelector('[data-testid="reasoning-effort-popover"]').getBoundingClientRect();
        return r.left >= 15.5 && r.right <= innerWidth - 15.5;
      });
      const box = await slider.boundingBox();
      await page.screenshot({ path: join(output, `before-drag-${profile}-${theme}-${width}.png`) });
      const hit = await page.evaluate(({x,y}) => {
        const node = document.elementFromPoint(x,y); return { tag: node?.tagName, classes: node?.className, testid: node?.getAttribute('data-testid') };
      }, { x: box.x + 18, y: box.y + box.height / 2 });
      assert.equal(hit.classes, 'xn-reasoning-slider__track', JSON.stringify({hit, box, panel: await page.getByTestId('reasoning-effort-popover').evaluate(n => ({rect:n.getBoundingClientRect().toJSON(),style:n.getAttribute('style'),transform:getComputedStyle(n).transform}))}));
      // Preview default while dragging, without changing the applied choice.
      await page.mouse.move(box.x + 18, box.y + box.height / 2); await page.mouse.down();
      assert.equal(await page.getByTestId('reasoning-effort-preview').innerText(), 'Default');
      assert.match(await trigger.innerText(), /High/);
      await page.mouse.up();
      assert.match(await trigger.innerText(), /Default/);
      await slider.press('ArrowRight');
      assert.equal(await slider.getAttribute('aria-valuetext'), 'Low');
      await slider.press('End');
      // Pointer cancel must leave the committed choice untouched.
      await page.mouse.move(box.x + 18, box.y + box.height / 2); await page.mouse.down();
      await slider.dispatchEvent('pointercancel', { pointerId: 1, bubbles: true });
      await page.mouse.up();
      assert.match(await trigger.innerText(), /High/);
      const geometry = await page.getByTestId('reasoning-effort-popover').evaluate(node => {
        const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, viewport: innerWidth, overflow: document.body.scrollWidth > innerWidth };
      });
      assert.ok(geometry.left >= 0 && geometry.right <= width && geometry.top >= 0, JSON.stringify(geometry));
      assert.equal(geometry.overflow, false);
      await page.screenshot({ path: join(output, `${profile}-${theme}-${width}.png`) });
      await slider.press('Escape');
      assert.equal(await page.getByTestId('reasoning-effort-popover').count(), 0);
      assert.equal(await trigger.evaluate(node => document.activeElement === node), true);
      results.push({ theme, width, profile, geometry, synthetic: true });
    }
    // The real composer preparation endpoint receives a valid choice; prevent
    // the subsequent model run and inspect its request instead of paying for it.
    const input = page.locator('textarea').first(); await input.fill('Synthetic effort wiring test.');
    const before = runBodies.length;
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.waitForFunction(() => document.body.innerText.includes('Synthetic request capture; no inference started.'));
    assert.equal(runBodies.length, before + 1);
    assert.equal(runBodies.at(-1).reasoning_effort, 'high');
    assert.equal(runBodies.at(-1).provider_id, 'fixture');
    await page.getByRole('button', { name: 'Choose model', exact: true }).click();
    await page.locator('[data-model-row="unknown:unknown-model"]').click();
    await trigger.click();
    assert.equal(await page.getByRole('slider').count(), 0);
    assert.match(await page.getByTestId('reasoning-effort-popover').innerText(), /no declared reasoning levels/);
    await page.getByRole('button', { name: 'Configure reasoning levels', exact: true }).press('Escape');
    await page.getByRole('button', { name: 'Choose model', exact: true }).click();
    await page.locator('[data-model-row="single:single-model"]').click();
    await trigger.click();
    const single = page.getByRole('slider');
    assert.equal(await single.getAttribute('aria-valuemax'), '1');
    await single.press('End');
    assert.match(await trigger.innerText(), /High/);
    await context.close();
  }
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  await writeFile(join(output, 'verification.json'), JSON.stringify({ results, runBodies, errors, external, modelRequests: 0 }, null, 2));
  console.log(`PASS: ${results.length} production effort layouts; drag/release/cancel/keyboard/focus and real composer request wiring; no model requests. ${output}`);
} finally {
  await browser?.close(); child.stdin.end();
  await new Promise(resolve => { if (child.exitCode !== null) resolve(); else { child.once('exit', resolve); setTimeout(() => { child.kill(); resolve(); }, 5000).unref(); } });
  await rm(temporary, { recursive: true, force: true });
}
