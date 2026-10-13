// Real production UI + isolated Store writes; no model execution or external network.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve, sep} from 'node:path';
import {chromium} from 'playwright';

const root = resolve(import.meta.dirname, '..');
const temporary = await mkdtemp(join(tmpdir(), 'xn-runtime-projection-'));
assert.ok(resolve(temporary).startsWith(resolve(tmpdir()) + sep));
const output = join(root, 'artifacts', 'runtime-projection-20261013');
await mkdir(output, {recursive: true});
const source = String.raw`
import json,sys,threading
from pathlib import Path
from xueness import web,core,plugin_runtime
from xueness.bundled_plugins.providers import providers_api,default_selection
base,dist=map(Path,sys.argv[1:]);state=base/'state';state.mkdir();workspace=base/'workspace';workspace.mkdir()
(state/'plugin-state.json').write_text(json.dumps({'apiVersion':1,'enabled':{'updates':False,'onboarding':False,'diagnostics':False}}))
ctx=web.build_context(state,base/'runs',workspace,allow_real=False);ctx['webapp_dir']=dist
providers_api._handle_save(ctx,{'id':'fixture','name':'Synthetic model','baseUrl':'http://127.0.0.1:9/v1','model':'fixture','apiKey':'fixture'})
default_selection.save(state,{'providerId':'fixture','model':'fixture'})
s=ctx['store'].new('Inspect the report.',workspace);s['title']='Runtime projection';s['status']='completed'
s['messages'] += [{'role':'assistant','content':'','tool_calls':[{'id':'call','function':{'name':'read','arguments':'{"path":"report.md"}'}}]},
 {'role':'tool','tool_call_id':'call','content':'{"ok":true,"output":"Report contents"}'},
 {'role':'assistant','content':'Initial recorded answer.'}]
s['reasoning_history']=[{'message_index':2,'text':'Read the real saved report.'}]
s['results']={'call':{'ok':True,'output':'Report contents'}}
s['completion']={'turn_id':'turn-1','status':'verified','verified':True,'summary':'Initial recorded answer.','tool_execution_status':'succeeded'}
ctx['store'].save(s);sid=s['id']
other=ctx['store'].new('Other request.',workspace);other['title']='Other session';other['status']='completed';other['messages'].append({'role':'assistant','content':'Other recorded answer.'});ctx['store'].save(other)
history=ctx['store'].new('History first.',workspace);history['title']='History session';history['status']='completed'
for i in range(65):history['messages'] += [{'role':'user','content':'History request '+str(i)},{'role':'assistant','content':'History answer '+str(i)}]
ctx['store'].save(history)
server=web.create_server(0,ctx);threading.Thread(target=server.serve_forever,daemon=True).start()
print(json.dumps({'port':server.server_address[1],'sid':sid,'other':other['id'],'history':history['id']}),flush=True)
try:
 for line in sys.stdin:
  cmd=json.loads(line)['cmd'];s=ctx['store'].load(sid)
  if cmd=='begin':
   core.append_user_turn(s,ctx['store'],'Live request.');s['status']='running';s['streaming']={'id':'wire-stream','status':'streaming','text':'Live partial','reasoning':'Live recorded thought.'}
  elif cmd=='grow':s['streaming']['text']='Live partial grows'
  elif cmd=='finish':
   stream=s.pop('streaming');stream.update(text='Live final response.',status='completed',final_message_index=len(s['messages']))
   s['messages'].append({'role':'assistant','content':'Live final response.'});s['stream_history']=[stream];s['status']='completed';s['completion']=None
  elif cmd=='disable':plugin_runtime.set_enabled(state,'runtimes',False)
  else:raise ValueError('unknown fixture command')
  if cmd!='disable':ctx['store'].save(s)
  print(json.dumps({'done':cmd}),flush=True)
finally:
 plugin_runtime.set_enabled(state,'runtimes',False);server.shutdown();server.server_close()
`;
const script = join(temporary, 'server.py');
await writeFile(script, source);
const child = spawn(process.env.PYTHON || 'python3', [script, temporary, join(root, 'webapp/dist')], {cwd: root,
  env: {...process.env, PYTHONPATH: root, XUENESS_API_KEY: '', XUENESS_MODEL: '', XUENESS_MARKETPLACE_URL: '', XUENESS_WORKSPACE_ROOTS: ''},
  stdio: ['pipe', 'pipe', 'pipe']});
const lines = [], waiters = [];
let buffered = '', stderr = '';
child.stderr.on('data', data => {stderr = (stderr + data).slice(-10000);});
child.stdout.on('data', data => {
  buffered += data;
  while (buffered.includes('\n')) {
    const index = buffered.indexOf('\n'), line = buffered.slice(0, index);buffered = buffered.slice(index + 1);
    if (line) {const value = JSON.parse(line);if (waiters.length) waiters.shift()(value);else lines.push(value);}
  }
});
function nextLine() {
  return new Promise((accept, reject) => {
    const timer = setTimeout(() => reject(new Error(stderr || 'fixture timed out')), 15000);
    const complete = value => {clearTimeout(timer);accept(value);};
    if (lines.length) complete(lines.shift());else waiters.push(complete);
  });
}
async function command(cmd) {child.stdin.write(JSON.stringify({cmd}) + '\n');assert.equal((await nextLine()).done, cmd);}
let browser, page, releaseRecovery;
const report = {requests: [], errors: [], external: [], checks: [], synthetic: true, modelRequests: 0};
try {
  const ready = await nextLine(), origin = `http://127.0.0.1:${ready.port}`;
  browser = await chromium.launch({channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true});
  const context = await browser.newContext({viewport: {width: 1280, height: 900}, reducedMotion: 'reduce'});
  await context.addInitScript(() => {localStorage.setItem('xueness.language', 'en');localStorage.setItem('xueness.theme', 'light');});
  page = await context.newPage();page.setDefaultTimeout(12000);
  page.on('pageerror', error => report.errors.push(error.message));
  let failNext = false, holdRecovery = false;
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) {report.external.push(url.href);await route.abort();return;}
    report.requests.push(url.pathname);
    if (request.method() === 'POST' && url.pathname.endsWith('/run')) {report.modelRequests++;await route.abort();return;}
    if (url.pathname === '/api/runtimes/v4' && failNext) {
      failNext = false;holdRecovery = true;
      await route.fulfill({status: 503, contentType: 'application/json', body: '{"error":"fixture transient failure"}'});return;
    }
    if (url.pathname === '/api/runtimes/v4' && holdRecovery) await new Promise(done => {releaseRecovery = done;});
    await route.continue();
  });
  async function pick(id) {
    const item = page.getByTestId(`xn-sidebar-item-${id}`);await item.waitFor({state: 'attached'});
    if (!await item.isVisible()) await page.getByTestId('xn-shell-sidebar-toggle').click();
    await item.click();
  }
  await page.goto(origin);await pick(ready.sid);
  await page.getByText('Initial recorded answer.', {exact: true}).last().waitFor();
  await page.locator('.xn-zc-work > summary').first().click();
  await page.locator('.xn-zc-reasoning > summary').first().click();
  await page.getByText('Read the real saved report.', {exact: true}).waitFor();
  assert.match(await page.locator('.xn-zc-reasoning').first().innerText(), /Read the real saved report/);
  assert.match(await page.locator('.xn-zc-work').first().innerText(), /report\.md/);
  await page.screenshot({path: join(output, 'desktop.png')});
  report.checks.push('recorded reasoning and tool arguments');
  await command('begin');await page.getByText('Live partial', {exact: true}).waitFor();
  await command('grow');await page.getByText('Live partial grows', {exact: true}).waitFor();
  // Release any current long poll before injecting the next failure, and hold
  // recovery long enough to inspect preserved content deterministically.
  failNext = true;
  await command('finish');
  await page.waitForFunction(() => document.body.textContent.includes('Conversation updates failed') || document.body.textContent.includes('fixture transient failure'));
  assert.ok(await page.getByText(/Live partial grows|Live final response\./, {exact: true}).count());
  holdRecovery = false;releaseRecovery?.();
  await page.getByText('Live final response.', {exact: true}).waitFor();
  assert.equal(await page.getByText('Live final response.', {exact: true}).count(), 1);
  assert.equal(await page.getByText('Live partial grows', {exact: true}).count(), 0);
  report.checks.push('stream updates and final identity without duplicates');
  await pick(ready.other);await page.getByText('Other recorded answer.', {exact: true}).waitFor();
  await pick(ready.sid);await page.getByText('Live final response.', {exact: true}).waitFor();
  assert.equal(await page.getByText('Other recorded answer.', {exact: true}).count(), 0);
  report.checks.push('transient failure preserves content; switched session ignores late reads');
  await pick(ready.history);await page.getByText('History answer 64', {exact: true}).waitFor();
  for (let count = 0; count < 4; count++) {
    const more = page.getByTestId('conversation-load-older').getByRole('button');
    if (!await more.count()) break;
    await more.click();await page.waitForFunction(() => !document.querySelector('[data-testid="conversation-load-older"] button')?.disabled);
  }
  // History virtualizes; the first-turn rail can mount the oldest page on demand.
  const rail = page.locator('.xn-conversation-history-rail__stop').first();
  await rail.click();await page.getByText('History first.', {exact: true}).last().waitFor();
  report.checks.push('older pages from the same runtime projection');
  await pick(ready.sid);await page.getByText('Live final response.', {exact: true}).waitFor();
  await page.setViewportSize({width: 420, height: 900});
  assert.equal(await page.evaluate(() => document.body.scrollWidth > innerWidth), false);
  await page.screenshot({path: join(output, 'narrow.png')});
  assert.ok(report.requests.includes('/api/runtimes/v4'));
  assert.equal(report.requests.some(path => /\/(updates|conversation|timeline|journal)$/.test(path)), false, 'legacy row reads ran while runtime projection was active');
  const compatibilityRead = page.waitForRequest(request => new URL(request.url()).pathname.endsWith('/updates'));
  await command('disable');
  await compatibilityRead;
  await page.getByText('Live final response.', {exact: true}).waitFor();
  report.checks.push('runtime disable ends live subscription and opens compatible session reads');
  assert.deepEqual(report.errors, []);assert.deepEqual(report.external, []);assert.equal(report.modelRequests, 0);
  console.log(`PASS: ${report.checks.length} production projection checks, desktop + narrow, no model calls. ${output}`);
} catch (error) {
  if (page && !page.isClosed()) {await page.screenshot({path: join(output, 'failure.png')});report.failure = String(error);
    report.body = (await page.locator('body').innerText()).slice(-12000);}
  throw error;
} finally {
  releaseRecovery?.();
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));await browser?.close();child.stdin.end();
  await new Promise(done => {if (child.exitCode !== null) done();else {child.once('exit', done);setTimeout(() => {child.kill();done();}, 5000).unref();}});
  await rm(temporary, {recursive: true, force: true});
}
