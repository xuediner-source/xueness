/** Source/built stage acceptance against the real application front door, using local fixtures. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ScriptedServer } from '../ts/packages/providers/test/support/scripted-server.ts';
import { chunk, events, SSE_HEAD, USAGE_CHUNK } from '../ts/packages/providers/test/support/http-fixtures.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), built = process.argv.includes('--built');
const ts = join(root, 'ts', ...(built ? ['dist'] : [])), ext = built ? 'js' : 'ts';
const require = createRequire(join(ts, 'package.json'));
const pkg = name => import(pathToFileURL(require.resolve(name)).href);
const [engine, providerTools, kernel, contracts, appModule, frontModule] = await Promise.all([
  pkg('@xueness/engine-tools'), pkg('@xueness/plugin-providers'), pkg('@xueness/kernel'), pkg('@xueness/contracts'),
  import(pathToFileURL(join(ts, 'apps/server/src/application-api.' + ext)).href),
  import(pathToFileURL(join(ts, 'apps/server/src/front-door.' + ext)).href),
]);
const scratch = mkdtempSync(join(tmpdir(), 'xueness-verify-z4-'));
const workspace = join(scratch, '工作区 spaces'), state = join(scratch, 'state'), home = join(scratch, 'home');
for (const path of [workspace, state, home]) mkdirSync(path);
const oldHome = process.env.HOME; process.env.HOME = home;
const bashPath = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
assert.ok(existsSync(bashPath), 'Bash must already be installed; this check never installs it');
const shellPath = value => process.platform === 'win32' ? '/' + value[0].toLowerCase() + value.slice(2).replaceAll('\\', '/') : value;
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const initMarker = join(workspace, 'init.txt'), startupMarker = join(workspace, 'startup.txt');
writeFileSync(join(home, '.bashrc'), `printf 'init\\n' >> ${quote(shellPath(initMarker))}\nalias z4_probe='printf "rc-value\\n"'\n`);
writeFileSync(join(workspace, 'lines.txt'), 'first\r\n第二行🙂\r\nthird\r\n');
const binary = Buffer.from(Array.from({ length: 257 }, (_, index) => index % 256));
writeFileSync(join(workspace, 'bytes.bin'), binary);
writeFileSync(join(state, 'settings.json'), JSON.stringify({ workspace: { selectedRoots: [workspace], defaultRoot: workspace }, general: { sessionsAutoTitleEnabled: false } }));
const fullText = 'fixture content '.repeat(1800) + 'FULL-CONTENT-TAIL-Z4';
let networkRequests = 0, closedResponses = 0, approvals = 0;
const net = {
  async lookup() { return ['93.184.216.34']; },
  async request(exchange) {
    networkRequests++;
    assert.equal(exchange.address, '93.184.216.34');
    const redirect = exchange.host === 'start.example';
    return { status: redirect ? 302 : 200, contentType: 'text/plain', ...(redirect ? { location: 'https://final.example/content?secret=fixture' } : {}),
      async read(limit) { return Buffer.from(redirect ? '' : fullText).subarray(0, limit); }, close() { closedResponses++; } };
  },
};
const server = await ScriptedServer.start(), scenario = 'z4-main';
const toolReply = calls => SSE_HEAD + events([chunk({ tool_calls: calls.map(([id, name, args], index) => ({ index, id, type: 'function', function: { name, arguments: JSON.stringify(args) } })) }, 'tool_calls'), USAGE_CHUNK]);
server.script(scenario, [
  toolReply([
    ['shell-one', 'Bash', { command: 'z4_probe; printf "%s\\n" "$Z4_STARTUP"', description: 'Check configured shell' }],
    ['read-one', 'Read', { file_path: join(workspace, 'lines.txt'), offset: 2, limit: 1 }],
    ['fetch-one', 'web_fetch', { url: 'http://start.example/a?secret=fixture' }],
  ]),
  toolReply([['fetch-two', 'web_fetch', { url: 'https://start.example/a?secret=fixture' }]]),
  SSE_HEAD + events([chunk({ content: 'Stage Z4 fixture complete.\nEvidence: E1 E2 E3 E4' }, 'stop'), USAGE_CHUNK]),
]);
const checks = [], failures = []; let api, front, origin, sid;
async function json(path, data, expected = 200) {
  const response = await fetch(origin + path, { method: data === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': api.csrfToken }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const body = await response.json(); assert.equal(response.status, expected, JSON.stringify(body)); return body;
}
async function check(name, fn) { try { checks.push({ name, ...await fn() }); } catch (error) { failures.push({ name, error: String(error.stack ?? error) }); } }
try {
  api = await appModule.createApplicationApi({ projectRoot: root, projectDir: workspace, stateDir: state, webRuns: join(scratch, 'runs'), scheduler: false, allowReal: true,
    agent: { networkNet: net, approver: () => () => { approvals++; return { behavior: 'allow' }; } } });
  front = frontModule.createFrontDoor({ webappDir: join(root, 'webapp/dist'), api });
  await new Promise(done => front.listen(0, '127.0.0.1', done)); origin = `http://127.0.0.1:${front.address().port}`;
  await check('persisted_shell_config_and_lazy_initialization', async () => {
    assert.equal((await json('/api/shell/settings')).settings.shellMode, 'system');
    await json('/api/shell/settings', { shellMode: 'bash', shellExecutable: bashPath, captureInit: true,
      startupScript: `export Z4_STARTUP=stage4\nprintf 'startup\\n' >> ${quote(shellPath(startupMarker))}\n` });
    assert.equal(existsSync(initMarker), false); assert.equal(existsSync(startupMarker), false);
    await json('/api/shell/settings', { shellMode: 'invalid' }, 400);
    assert.equal((await json('/api/shell/settings')).settings.shellMode, 'bash');
    return { defaultSystemShell: true, persisted: true, saveExecutesNothing: true };
  });
  await json('/api/providers', { id: 'local', name: 'Loopback fixture', baseUrl: server.base('ts', scenario), model: 'z4-fixture', apiKey: 'fixture', allowLoopbackHttp: true });
  sid = (await json('/api/sessions', { task: 'Check shell, file ranges and a cached web page' })).id;
  const run = await json(`/api/sessions/${sid}/run`, { provider_id: 'local', steps: 8 });
  assert.equal(run.status, 'completed', JSON.stringify(run));
  const session = await api.store.load(sid);
  await check('approved_shell_and_streaming_read', async () => {
    assert.equal(session.results['shell-one'].ok, true, JSON.stringify(session.results['shell-one']));
    assert.match(session.results['shell-one'].output, /rc-value[\s\S]*stage4/);
    assert.equal(readFileSync(initMarker, 'utf8'), 'init\n'); assert.equal(readFileSync(startupMarker, 'utf8'), 'startup\n');
    assert.match(session.results['read-one'].output, /第二行🙂/);
    assert.equal(session.results['read-one'].data.startLine, 2); assert.equal(session.results['read-one'].data.endLine, 2);
    assert.equal(session.messages.find(row => row.tool_call_id === 'read-one')._read_state.range, true);
    return { gitBash: process.platform === 'win32', platform: process.platform, initCount: 1, startupCount: 1, partialRead: true, approvals };
  });
  await check('bounded_byte_api_and_plugin_switch', async () => {
    const path = `/api/sessions/${sid}/file-bytes?path=bytes.bin&offset=250&limit=16`;
    const range = await json(path);
    assert.deepEqual(Buffer.from(range.base64, 'base64'), binary.subarray(250));
    assert.equal(range.totalBytes, 257); assert.equal(range.nextOffset, null);
    assert.equal(range.hash, createHash('sha256').update(binary).digest('hex'));
    await json(`/api/sessions/${sid}/file-bytes?path=bytes.bin&limit=65537`, undefined, 400);
    await json('/api/plugins/files', { enabled: false }); await json(path, undefined, 403); await json('/api/plugins/files', { enabled: true });
    await json('/api/plugins/shell', { enabled: false }); await json('/api/shell/settings', undefined, 403); await json('/api/plugins/shell', { enabled: true });
    return { rangeBytes: 7, hashVerified: true, pluginGates: true };
  });
  await check('redirect_cache_full_result_and_durable_activity', async () => {
    assert.ok(api.agent.knownTools().includes('tool_result_read'));
    const result = session.results['fetch-one'];
    assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.data.fullContent, fullText);
    assert.equal(JSON.parse(result.output).fullContent, undefined); assert.ok(result.output.length < fullText.length);
    assert.equal(session.results['fetch-two'].data.cacheHit, true); assert.equal(networkRequests, 2); assert.equal(closedResponses, 2);
    const page = await json(`/api/sessions/${sid}/events.runtime?limit=500`);
    const activity = page.events.filter(event => event.type === 'NetworkRequest');
    for (const phase of ['started', 'redirected', 'completed', 'cache_hit']) assert.ok(activity.some(event => event.payload.phase === phase), phase);
    assert.ok(activity.every(event => !JSON.stringify(event).includes('secret')));
    assert.equal(contracts.recoverRuntimeProjection(page).lastNetworkRequest.phase, 'cache_hit');
    const stored = contracts.pyJsonDumps(Object.fromEntries(Object.entries(result).filter(([key]) => !['media', '_read_state'].includes(key))));
    const offset = contracts.pyLen(stored.slice(0, stored.indexOf('FULL-CONTENT-TAIL-Z4')));
    const k = kernel.Context.create({ roots: { workspace: [workspace], state, temp: join(scratch, 'results') } });
    const host = new kernel.PluginHost(k, [providerTools.createProviderResultTools(() => session, {
      // F02.02: required ProviderToolSearchBinding — live kernel catalog projection (empty-safe until host.start).
      catalog: () => k.tools.list().map(({ name, description, alwaysLoad, shouldDefer }) => ({ name, description, alwaysLoad, shouldDefer })),
    })], { enabled: { providers: true } });
    try {
      await host.start();
      const tool = k.tools.get('tool_result_read');
      const env = engine.createToolEnv({ cwd: workspace, artifactsDir: join(scratch, 'results'), owner: sid }); env.currentSession = () => session;
      const read = await tool.run({ tool_call_id: 'fetch-one', offset, limit: 80 }, env);
      assert.match(read.output, /FULL-CONTENT-TAIL-Z4/);
    } finally { await host.dispose(); await k.dispose(); }
    return { transportRequests: networkRequests, redirects: 1, cacheHit: true, fullContentChars: fullText.length, resultPaging: true, activityEvents: activity.length, queryRedacted: true };
  });
} catch (error) { failures.push({ name: 'production_setup', error: String(error.stack ?? error) }); }
finally {
  if (front) { front.closeAllConnections(); await new Promise(done => front.close(done)); }
  await api?.close(); await server.close();
  if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
  if (dirname(resolve(scratch)) !== resolve(tmpdir()) || !basename(scratch).startsWith('xueness-verify-z4-')) throw new Error('unexpected scratch cleanup path');
  rmSync(scratch, { recursive: true, force: true });
}
process.stdout.write(JSON.stringify({ ok: failures.length === 0, mode: built ? 'built' : 'source', network: 'fixture-and-loopback-only', scenarios: checks, failures, modelRequests: server.requests('ts', scenario).length }) + '\n');
if (failures.length) process.exitCode = 1;
