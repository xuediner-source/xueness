// Real production UI with isolated synthetic sessions. No model or user data.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(import.meta.dirname, '..');
const temporary = await mkdtemp(join(tmpdir(), 'xueness-phases-fixture-'));
const output = join(tmpdir(), 'xueness-conversation-phases-20261007');
await mkdir(output, { recursive: true });
const source = String.raw`
import json, sys, threading
from pathlib import Path
from datetime import datetime, timezone
from xueness import web
from xueness.bundled_plugins.providers import providers_api, default_selection
base, dist = map(Path, sys.argv[1:])
workspace=base/'workspace'; workspace.mkdir()
state=base/'state'; state.mkdir()
(state/'plugin-state.json').write_text(json.dumps({'apiVersion':1,'enabled':{'updates':False,'onboarding':False,'diagnostics':False}}))
ctx=web.build_context(state,base/'runs',workspace,allow_real=False)
ctx['webapp_dir']=dist
status,result=providers_api._handle_save(ctx,{'id':'fixture','name':'Synthetic model','baseUrl':'https://127.0.0.1:9/v1','model':'fixture-model','apiKey':'not-a-real-key'})
assert status==200,result
default_selection.save(state,{'providerId':'fixture','model':'fixture-model'})
fixtures=[]
for profile in ('standard','lightweight'):
 for phase in ('waiting_model','thinking','generating','tools','repairing','paused','completed'):
  session=ctx['store'].new('Fixture '+profile+' '+phase,workspace)
  session['title']='Fixture '+profile+' '+phase
  session['model_selection']={'provider_id':'fixture','model':'fixture-model'}
  session['runtime_profile']=profile
  session['status']='running' if phase not in ('paused','completed') else phase
  session['runtime_activity']={'phase':phase,'startedAt':datetime.now(timezone.utc).isoformat(),'requestStep':2,'reportedInputTokens':1200,'reportedCachedTokens':480,'reportedOutputTokens':37}
  session['messages'].append({'role':'assistant','content':'Previous completed answer.'})
  session['reasoning_history']=[{'message_index':2,'text':'Previous settled reasoning.'}]
  if phase in ('thinking','generating'):
   session['streaming']={'id':'fixture-'+phase,'text':'A current generated answer.' if phase=='generating' else '', 'reasoning':'Synthetic current reasoning.', 'status':'streaming'}
  ctx['store'].save(session)
  fixtures.append({'id':session['id'],'profile':profile,'phase':phase})
server=web.create_server(0,ctx)
threading.Thread(target=server.serve_forever,daemon=True).start()
print(json.dumps({'port':server.server_address[1],'fixtures':fixtures}),flush=True)
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
const errors = [], external = [], forbidden = [], results = [];
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
  const labels = { waiting_model: 'Waiting for model', thinking: 'Reasoning', generating: 'Generating', tools: 'Tool calling', repairing: 'Repair', paused: 'Paused', completed: 'Completed' };
  for (const theme of ['light', 'dark']) for (const width of [1280, 420]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme, reducedMotion: 'reduce' });
    await context.addInitScript(theme => { localStorage.setItem('xueness.theme', theme); localStorage.setItem('xueness.language', 'en'); }, theme);
    const page = await context.newPage(); page.setDefaultTimeout(12000);
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) { external.push(url.href); await route.abort(); return; }
      if (route.request().method() !== 'GET' && !url.pathname.endsWith('/viewed')) { forbidden.push(url.pathname); await route.abort(); return; }
      await route.continue();
    });
    await page.goto(origin);
    for (const fixture of ready.fixtures) {
      const item = page.getByTestId(`xn-sidebar-item-${fixture.id}`);
      await item.waitFor({ state: 'attached' });
      if (!await item.isVisible()) await page.getByTestId('xn-shell-sidebar-toggle').click();
      await item.click();
      const telemetry = page.getByTestId('request-telemetry');
      await telemetry.locator(':scope > summary').waitFor({ state: 'visible' });
      await page.waitForFunction(phase => document.querySelector(`.xn-runtime-monitor__request-phase--${phase}`), fixture.phase);
      assert.match(await telemetry.locator(':scope > summary').innerText(), new RegExp(labels[fixture.phase], 'i'));
      if (await telemetry.getAttribute('open') === null) await telemetry.locator(':scope > summary').click();
      const summary = page.getByRole('region', { name: 'Current model request status', exact: true });
      await summary.waitFor({ state: 'visible' });
      await page.waitForFunction(phase => document.querySelector(`.xn-runtime-monitor__request-phase--${phase}`), fixture.phase);
      assert.match(await summary.innerText(), new RegExp(labels[fixture.phase], 'i'));
      assert.match(await summary.innerText(), /1,200/);
      assert.match(await summary.innerText(), /480/);
      assert.match(await summary.innerText(), /37/);
      assert.doesNotMatch(await summary.innerText(), /[\u3400-\u9fff]/);
      assert.equal(await page.locator('.xn-runtime-monitor__timings').getAttribute('open'), null);
      if (fixture.phase === 'generating') {
        assert.equal(await page.locator('summary').filter({ hasText: /^Thinking…$/ }).count(), 0);
        assert.match(await page.getByTestId(fixture.profile === 'standard' ? 'timeline-stream' : 'lightweight-timeline').innerText(), /A current generated answer/);
      }
      if (fixture.phase === 'completed' || fixture.phase === 'paused') {
        assert.equal(await page.locator('[data-testid="timeline-stream-loading"], [data-testid="lightweight-timeline-streaming"]').count(), 0);
        assert.doesNotMatch(await summary.innerText(), /Elapsed/);
      }
      const geometry = await summary.evaluate(node => ({ width: node.getBoundingClientRect().width, overflow: document.body.scrollWidth > innerWidth }));
      assert.equal(geometry.overflow, false);
      await page.screenshot({ path: join(output, `${fixture.profile}-${fixture.phase}-${theme}-${width}.png`) });
      results.push({ ...fixture, theme, width, geometry, synthetic: true });
    }
    await context.close();
  }
  assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.deepEqual(forbidden, []);
  await writeFile(join(output, 'verification.json'), JSON.stringify({ results, errors, external, forbidden }, null, 2));
  console.log(`PASS: ${results.length} production conversation phase layouts, both profiles, themes and widths, with no model requests. ${output}`);
} finally {
  await browser?.close(); child.stdin.end();
  await new Promise(resolve => { if (child.exitCode !== null) resolve(); else { child.once('exit', resolve); setTimeout(() => { child.kill(); resolve(); }, 5000).unref(); } });
  await rm(temporary, { recursive: true, force: true });
}
