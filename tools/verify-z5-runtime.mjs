/** Stage acceptance: actual application HTTP, local model fixture, native hooks and MCP child. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ScriptedServer } from '../ts/packages/providers/test/support/scripted-server.ts';
import { chunk, events, SSE_HEAD, USAGE_CHUNK } from '../ts/packages/providers/test/support/http-fixtures.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), built = process.argv.includes('--built');
const ts = join(root, 'ts', ...(built ? ['dist'] : [])), ext = built ? 'js' : 'ts';
const require = createRequire(join(ts, 'package.json'));
const pkg = name => import(pathToFileURL(require.resolve(name)).href);
const [hookPlugin, contracts, appModule, frontModule] = await Promise.all([
  pkg('@xueness/plugin-hooks'), pkg('@xueness/contracts'),
  import(pathToFileURL(join(ts, 'apps/server/src/application-api.' + ext)).href),
  import(pathToFileURL(join(ts, 'apps/server/src/front-door.' + ext)).href),
]);
const scratch = mkdtempSync(join(tmpdir(), 'xueness-verify-z5-'));
const workspace = join(scratch, '工作区 spaces'), state = join(scratch, 'state');
for (const path of [workspace, state, join(workspace, '.xueness')]) mkdirSync(path);
writeFileSync(join(workspace, 'original.txt'), 'ORIGINAL-INPUT');
writeFileSync(join(workspace, 'actual.txt'), 'HOOK-UPDATED-INPUT');
writeFileSync(join(state, 'settings.json'), JSON.stringify({ workspace: { selectedRoots: [workspace], defaultRoot: workspace }, general: { sessionsAutoTitleEnabled: false, sessionsCancelPropagateEnabled: true } }));
const hookFile = join(scratch, 'hook.mjs'), mcpFile = join(scratch, 'mcp.mjs');
writeFileSync(hookFile, String.raw`
import fs from 'node:fs'; import path from 'node:path';
const mode=process.argv[2], state=process.argv[3];
let raw=''; for await (const chunk of process.stdin) raw+=chunk;
const payload=JSON.parse(raw||'{}');
const count=name=>fs.appendFileSync(path.join(state,name),'1\n');
if(mode==='prompt') console.log(JSON.stringify({additionalContext:'HOOK-CONTEXT-Z5'}));
if(mode==='rewrite') console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',updatedInput:{path:path.join(process.cwd(),'actual.txt')}}}));
if(mode==='stop'){count('stop-count');console.log(JSON.stringify({continue:true,reason:'HOOK-STOP-CONTINUE',additionalContext:'HOOK-STOP-CONTEXT'}));}
if(mode==='workspace-start') count('workspace-start');
if(mode==='workspace-post') count('workspace-post');
`);
writeFileSync(mcpFile, String.raw`
import fs from 'node:fs'; import path from 'node:path'; import readline from 'node:readline';
const state=process.argv[2], send=value=>process.stdout.write(JSON.stringify(value)+'\n');
fs.appendFileSync(path.join(state,'mcp-starts'),'1\n');
for await(const line of readline.createInterface({input:process.stdin})) {
 const message=JSON.parse(line), id=message.id, p=message.params||{};
 if(message.method==='initialize') send({jsonrpc:'2.0',id,result:{protocolVersion:p.protocolVersion,serverInfo:{name:'fixture',version:'1'},capabilities:{tools:{listChanged:true},resources:{subscribe:true,listChanged:true}}}});
 else if(message.method==='tools/list') send({jsonrpc:'2.0',id,result:{tools:[{name:'echo',description:'Local fixture',inputSchema:{type:'object',properties:{label:{type:'string'},wait:{type:'boolean'}},required:['label'],additionalProperties:false}}]}});
 else if(message.method==='resources/subscribe') {send({jsonrpc:'2.0',id,result:{}});send({jsonrpc:'2.0',method:'notifications/resources/updated',params:{uri:'fixture://private?token=do-not-persist'}});}
 else if(message.method==='resources/unsubscribe') send({jsonrpc:'2.0',id,result:{}});
 else if(message.method==='tools/call') {
  const label=p.arguments.label;
  fs.appendFileSync(path.join(state,'calls-'+label),'1\n');
  fs.writeFileSync(path.join(state,'awaiting-'+label),'ready');
  send({jsonrpc:'2.0',method:'notifications/resources/list_changed'});
  const finish=()=>send({jsonrpc:'2.0',id,result:{content:[{type:'text',text:JSON.stringify({cwd:process.cwd(),value:process.env.Z5_VALUE})}]}});
  if(p.arguments.wait) {const timer=setInterval(()=>{if(fs.existsSync(path.join(state,'release-'+label))){clearInterval(timer);finish();}},5);}
  else finish();
 } else if(message.method==='notifications/cancelled') fs.writeFileSync(path.join(state,'cancel-notice'),String(p.requestId));
 else if(message.method==='ping') send({jsonrpc:'2.0',id,result:{}});
}
`);
const command = (mode) => ({ type: 'process', command: process.execPath, args: [hookFile, mode, state] });
const project = {
  plugins: { shell: { shellMode: 'bash', startupScript: 'export Z5_LAYER=project\n' } },
  mcp: { servers: { fixture: { transport: 'stdio', command: process.execPath, args: [mcpFile, state], cwd: '.', env: { Z5_VALUE: 'configured-value', API_TOKEN: 'fixture-hidden' } } } },
  hooks: { enabled: true, events: {
    SessionStart: [{ hooks: [command('workspace-start')] }],
    PostToolUse: [{ matcher: 'mcp__fixture__echo', hooks: [command('workspace-post')] }],
  } },
};
writeFileSync(join(workspace, '.xueness/config.json'), JSON.stringify(project));
const server = await ScriptedServer.start();
const toolReply = calls => SSE_HEAD + events([chunk({ tool_calls: calls.map(([id, name, args], index) => ({ index, id, type: 'function', function: { name, arguments: JSON.stringify(args) } })) }, 'tool_calls'), USAGE_CHUNK]);
const finalReply = text => SSE_HEAD + events([chunk({ content: text }, 'stop'), USAGE_CHUNK]);
server.script('z5-main', [toolReply([
  ['shell-one', 'Bash', { command: 'printf "%s\\n" "$Z5_LAYER"', description: 'Check project configuration' }],
  ['read-one', 'Read', { file_path: join(workspace, 'original.txt') }],
  ['subscribe-one', 'mcp__fixture___xueness_resources_subscribe', { key: 'fixture://document' }],
  ['mcp-one', 'mcp__fixture__echo', { label: 'main', wait: true }],
]), finalReply('First response.\nEvidence: E1 E2 E3 E4'), finalReply('Continued once.\nEvidence: E1 E2 E3 E4')]);
server.script('z5-cancel', [toolReply([['cancel-one', 'mcp__fixture__echo', { label: 'cancel', wait: true }]])]);
const checks = [], failures = []; let api, front, origin, sid, activeSnapshot, found;
async function json(path, data, expected = 200) {
  const response = await fetch(origin + path, { method: data === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': api.csrfToken }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const body = await response.json(); assert.equal(response.status, expected, JSON.stringify(body)); return body;
}
async function waitFile(name) { for (let i = 0; i < 1000; i++) { if (existsSync(join(state, name))) return; await delay(10); } throw new Error('fixture did not reach ' + name); }
const count = name => readFileSync(join(state, name), 'utf8').trim().split('\n').length;
async function check(name, fn) { try { checks.push({ name, ...await fn() }); } catch (error) { failures.push({ name, error: String(error.stack ?? error) }); } }
try {
  api = await appModule.createApplicationApi({ projectRoot: root, projectDir: workspace, stateDir: state, webRuns: join(scratch, 'runs'), scheduler: false, allowReal: true,
    agent: { approver: () => () => ({ behavior: 'allow' }) } });
  front = frontModule.createFrontDoor({ webappDir: join(root, 'webapp/dist'), api });
  await new Promise(done => front.listen(0, '127.0.0.1', done)); origin = `http://127.0.0.1:${front.address().port}`;
  await check('layered_configuration_and_independent_trust', async () => {
    await json('/api/runtime-config', { config: { plugins: { shell: { shellMode: 'bash', startupScript: 'export Z5_LAYER=user\n' } } } });
    let view = await json('/api/runtime-config?root=' + encodeURIComponent(workspace));
    assert.equal(view.workspace.status, 'pending'); assert.match(view.config.plugins.shell.startupScript, /user/);
    assert.equal(existsSync(join(state, 'mcp-starts')), false);
    hookPlugin.setFeature(state, true); found = hookPlugin.discover(workspace);
    assert.equal(found.hooks.length, 2); assert.equal(hookPlugin.admitted(state, workspace).hooks.length, 0);
    await json('/api/runtime-config/trust', { root: workspace, digest: view.workspace.digest, decision: 'allow', confirmed: true });
    view = await json('/api/runtime-config?root=' + encodeURIComponent(workspace));
    assert.equal(view.workspace.status, 'trusted'); assert.equal(view.provenance['/plugins/shell/startupScript'], 'workspace');
    assert.match(view.config.plugins.shell.startupScript, /project/); assert.equal(view.config.mcp.servers.fixture.env.API_TOKEN, '[redacted]');
    assert.equal(hookPlugin.admitted(state, workspace).hooks.length, 0, 'configuration trust cannot grant hook trust');
    assert.equal(hookPlugin.grantTrust(state, workspace, found.hooks).ok, true);
    await json('/api/runtime-config?root=' + encodeURIComponent(scratch), undefined, 403);
    return { pendingUntilDigestGrant: true, provenance: true, separateHookTrust: true, secretRedacted: true, connectionsDuringReview: 0 };
  });
  if (failures.length) throw new Error('configuration setup failed');
  for (const [id, event, mode, matcher] of [['prompt', 'UserPromptSubmit', 'prompt'], ['rewrite', 'PreToolUse', 'rewrite', 'read|Read'], ['stop', 'Stop', 'stop']]) {
    await json('/api/resources/hooks', { id, event, command: process.execPath, args: [hookFile, mode, state], ...(matcher ? { matcher } : {}) });
  }
  for (const scenario of ['z5-main', 'z5-cancel']) await json('/api/providers', { id: scenario, name: 'Loopback fixture', baseUrl: server.base('ts', scenario), model: 'z5-fixture', apiKey: 'fixture', allowLoopbackHttp: true });
  sid = (await json('/api/sessions', { task: 'Check MCP and trusted hooks' })).id;
  const running = json(`/api/sessions/${sid}/run`, { provider_id: 'z5-main', allow_mcp: true, allow_hooks: true, steps: 8 });
  void running.catch(() => {});
  await waitFile('awaiting-main');
  activeSnapshot = await json(`/api/sessions/${sid}/mcp-runtime`);
  hookPlugin.revokeTrust(state, workspace, found.hooks.filter(row => row.event === 'PostToolUse').map(row => row.digest));
  writeFileSync(join(state, 'release-main'), 'go');
  const run = await running; assert.equal(run.status, 'completed', JSON.stringify(run));
  const session = await api.store.load(sid);
  await check('hook_output_input_revalidation_and_live_revocation', async () => {
    assert.match(session.results['shell-one'].output, /project/);
    assert.match(session.results['read-one'].output, /HOOK-UPDATED-INPUT/); assert.doesNotMatch(session.results['read-one'].output, /ORIGINAL-INPUT/);
    assert.equal(count('workspace-start'), 1); assert.equal(existsSync(join(state, 'workspace-post')), false);
    assert.equal(count('stop-count'), 1); assert.equal(server.requests('ts', 'z5-main').length, 3);
    assert.match(server.requests('ts', 'z5-main')[0].body, /HOOK-CONTEXT-Z5/);
    assert.match(server.requests('ts', 'z5-main')[2].body, /HOOK-STOP-CONTEXT/);
    return { actualProjectShell: true, inputRewritten: true, revokedHookNotStarted: true, untrustedContextInjected: true, stopContinuations: 1, modelRequests: 3 };
  });
  await check('mcp_port_subscriptions_and_durable_metadata', async () => {
    assert.equal(activeSnapshot.active, true); assert.equal(activeSnapshot.servers.length, 1); assert.equal(activeSnapshot.servers[0].status, 'connected');
    assert.ok(activeSnapshot.servers[0].resourceUpdatedCount >= 1); assert.equal(session.results['subscribe-one'].ok, true);
    assert.equal(session.results['mcp-one'].ok, true, JSON.stringify(session.results['mcp-one'])); assert.match(session.results['mcp-one'].output, /configured-value/);
    const page = await json(`/api/sessions/${sid}/events.runtime?limit=500`), activities = page.events.filter(event => event.type === 'McpActivity');
    for (const phase of ['connected', 'resource_updated', 'resources_changed']) assert.ok(activities.some(event => event.payload.phase === phase), phase);
    assert.doesNotMatch(JSON.stringify(activities), /fixture-hidden|do-not-persist|fixture:\/\/private/);
    assert.ok(contracts.recoverRuntimeProjection(page).lastMcpActivity);
    assert.equal((await json(`/api/sessions/${sid}/mcp-runtime`)).active, false);
    return { activeConnections: 1, resourceUpdates: activeSnapshot.servers[0].resourceUpdatedCount, activityEvents: activities.length, credentialFree: true, closedAfterRun: true };
  });
  await check('cancel_without_replay_and_owner_gates', async () => {
    const cancelId = (await json('/api/sessions', { task: 'Cancel the local MCP fixture' })).id;
    const pending = json(`/api/sessions/${cancelId}/run`, { provider_id: 'z5-cancel', allow_mcp: true, allow_hooks: true, steps: 4 });
    void pending.catch(() => {});
    await waitFile('awaiting-cancel'); await json(`/api/sessions/${cancelId}/stop`, {}); await pending;
    const cancelled = await api.store.load(cancelId); assert.equal(cancelled.status, 'stopped');
    assert.equal(cancelled.results['cancel-one'].ok, false); assert.equal(count('calls-cancel'), 1); assert.equal(server.requests('ts', 'z5-cancel').length, 1);
    assert.equal((await json(`/api/sessions/${cancelId}/mcp-runtime`)).active, false);
    await json('/api/plugins/mcp', { enabled: false }); await json(`/api/sessions/${sid}/mcp-runtime`, undefined, 403);
    await json('/api/plugins/settings', { enabled: false }); await json('/api/runtime-config', undefined, 403);
    return { stopped: true, toolAttempts: 1, replayed: false, modelRequests: 1, inactiveAfterCancel: true, pluginGates: true };
  });
} catch (error) { failures.push({ name: 'production_setup', error: String(error.stack ?? error) }); }
finally {
  if (front) { front.closeAllConnections(); await new Promise(done => front.close(done)); }
  await api?.close(); await server.close();
  if (dirname(resolve(scratch)) !== resolve(tmpdir()) || !basename(scratch).startsWith('xueness-verify-z5-')) throw new Error('unexpected scratch cleanup path');
  rmSync(scratch, { recursive: true, force: true });
}
process.stdout.write(JSON.stringify({ ok: failures.length === 0, mode: built ? 'built' : 'source', network: 'loopback-only', scenarios: checks, failures,
  modelRequests: server.requests('ts', 'z5-main').length + server.requests('ts', 'z5-cancel').length }) + '\n');
if (failures.length) process.exitCode = 1;
