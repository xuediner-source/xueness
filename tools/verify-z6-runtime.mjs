/** Z6 acceptance: production ApplicationApi/FrontDoor and loopback-only agents. */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ScriptedServer } from '../ts/packages/providers/test/support/scripted-server.ts';
import { chunk, events, SSE_HEAD, USAGE_CHUNK } from '../ts/packages/providers/test/support/http-fixtures.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const built = process.argv.includes('--built');
const ts = join(root, 'ts', ...(built ? ['dist'] : []));
const ext = built ? 'js' : 'ts';
const [appModule, frontModule] = await Promise.all([
  import(pathToFileURL(join(ts, 'apps/server/src/application-api.' + ext)).href),
  import(pathToFileURL(join(ts, 'apps/server/src/front-door.' + ext)).href),
]);

const scratch = mkdtempSync(join(tmpdir(), 'xueness-verify-z6-'));
const workspace = join(scratch, '工作区 spaces');
const state = join(scratch, 'isolated state');
const webRuns = join(scratch, 'web runs');
mkdirSync(workspace, { recursive: true });
mkdirSync(state, { recursive: true });
mkdirSync(join(workspace, 'inputs'), { recursive: true });
writeFileSync(join(workspace, 'inputs', 'a.txt'), 'SOURCE-A-ORIGINAL\n');
writeFileSync(join(workspace, 'inputs', 'b.txt'), 'SOURCE-B-ORIGINAL\n');
writeFileSync(join(state, 'settings.json'), JSON.stringify({
  workspace: { selectedRoots: [workspace], defaultRoot: workspace },
  general: { sessionsAutoTitleEnabled: false, sessionsCancelPropagateEnabled: true },
}));

const server = await ScriptedServer.start();
const reply = text => SSE_HEAD + events([chunk({ content: text }, 'stop'), USAGE_CHUNK]);
server.script('z6-main', [
  reply('{"ok":"not-a-boolean","round":1}'),
  reply('{"ok":false,"round":1}'),
  reply('{"ok":true,"round":2}'),
  reply(JSON.stringify('reviewed input A')),
  reply(JSON.stringify('reviewed input B')),
]);
server.script('z6-cancel', [[{ hang: true }]]);

const checks = [], failures = [];
let api, front, origin = '';
let apiClosed = false;
let cancellationRequests = 0, hostCloseRequests = 0;
let ownerSid, otherSid, mainRunId;
const mainSource = [
  'interface Verdict { ok: boolean; round: number }',
  "phase('collect');",
  "log('z6 local acceptance');",
  "const planner=agent('planner');",
  "let verdict=await planner.ask<Verdict>('first');",
  "for(let i=0;!verdict.ok&&i<2;i++){verdict=await planner.ask<Verdict>('next')};",
  "const paths=await files.glob('inputs/*.txt');",
  'const fan=await Promise.all(paths.map(p=>agent(`reader-${p}`).ask<string>(`Review ${p}`)));',
  "const content=await files.read('inputs/a.txt');",
  'report({round:verdict.round,count:fan.length,content});',
  "phase('review');",
  "const approval=await hole('review','Approve output?');",
  'return {round:verdict.round,count:fan.length,approval};',
].join('\n');

async function json(path, data, expected = 200) {
  const response = await fetch(origin + path, {
    method: data === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': api.csrfToken },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  let body;
  try { body = await response.json(); } catch { body = null; }
  assert.equal(response.status, expected, JSON.stringify(body));
  return body;
}

async function scenario(name, body) {
  try { checks.push({ name, ok: true, ...(await body()) }); }
  catch (error) { failures.push({ name, error: String(error.stack ?? error) }); checks.push({ name, ok: false }); }
}

async function createSession(task, providerId = undefined) {
  return json('/api/sessions', {
    task, root: workspace,
    ...(providerId === undefined ? {} : { provider_id: providerId, model: 'z6-fixture-model' }),
  });
}

async function installLoopbackProfile(id) {
  await json('/api/providers', {
    id, name: 'Z6 loopback fixture', baseUrl: server.base('ts', id), model: 'z6-fixture-model',
    apiKey: 'fixture-only-key', allowLoopbackHttp: true,
  });
  await json('/api/providers/default', { providerId: id, model: 'z6-fixture-model' });
  const selection = await json('/api/providers/default');
  assert.equal(selection.default.providerId, id);
  assert.equal(selection.default.model, 'z6-fixture-model');
}

async function waitForRequests(id, count, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (server.requests('ts', id).length >= count) return;
    await delay(15);
  }
  throw new Error(`loopback fixture ${id} received ${server.requests('ts', id).length}/${count} requests`);
}

async function waitRun(id, timeoutMs = 45000) {
  let timer;
  try {
    await Promise.race([
      api.dynamicWorkflows.wait(id),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`workflow ${id} did not settle within ${timeoutMs}ms`)), timeoutMs); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

async function withTimeout(promise, timeoutMs, label) {
  let timer;
  try {
    await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} did not settle within ${timeoutMs}ms`)), timeoutMs); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

try {
  api = await appModule.createApplicationApi({
    projectRoot: root, projectDir: workspace, stateDir: state, webRuns, workspaceRoots: [workspace],
    scheduler: false, allowReal: true,
  });
  front = frontModule.createFrontDoor({ webappDir: join(root, 'webapp/dist'), api });
  await new Promise(done => front.listen(0, '127.0.0.1', done));
  origin = `http://127.0.0.1:${front.address().port}`;

  await scenario('compile_draft_digest_and_session_ownership', async () => {
    ownerSid = (await createSession('Z6 workflow ownership check')).id;
    const base = `/api/sessions/${ownerSid}/workflow-scripts`;
    const bad = await json(base + '/compile', { source: 'const secret = process.env.API_KEY;\nreturn secret;' });
    assert.equal(bad.ok, false);
    assert.ok(bad.diagnostics.some(item => item.code === 'DYN_FORBIDDEN_GLOBAL' && item.line === 1 && item.column > 0));
    assert.deepEqual((await json(base)).runs, [], 'compile must not create a run');

    const draft = await json(base, { source: "return 'draft';", name: 'Z6 ownership draft' });
    assert.equal(draft.status, 'draft'); assert.match(draft.digest, /^[a-f0-9]{64}$/); assert.equal(draft.writable, false);
    await json(base + '/' + draft.id + '/start', { digest: '0'.repeat(64), confirmed: true, allowReal: true }, 409);
    otherSid = (await createSession('Z6 workflow foreign owner check')).id;
    const foreign = `/api/sessions/${otherSid}/workflow-scripts/${draft.id}`;
    await json(foreign, undefined, 403);
    await json(foreign + '/start', { digest: draft.digest, confirmed: true, allowReal: true }, 403);
    assert.equal((await json(base + '/' + draft.id)).status, 'draft');
    assert.equal(server.requests('ts', 'z6-main').length + server.requests('ts', 'z6-cancel').length, 0);
    return { diagnosticLocation: true, draftDigest: true, staleStartStatus: 409, foreignReadStatus: 403, foreignStartStatus: 403, modelRequests: 0 };
  });

  await scenario('typed_actors_reads_report_hole_and_resume_replay', async () => {
    await installLoopbackProfile('z6-main');
    const session = await createSession('Z6 typed workflow execution', 'z6-main');
    ownerSid = session.id;
    const base = `/api/sessions/${ownerSid}/workflow-scripts`;
    const compiled = await json(base + '/compile', { source: mainSource });
    assert.equal(compiled.ok, true, JSON.stringify(compiled.diagnostics));
    assert.ok(Object.keys(compiled.schemas).length >= 3, 'typed ask schemas should be compiled');
    const created = await json(base, { source: mainSource, name: 'Z6 main fixture', maxConcurrency: 2 });
    mainRunId = created.id;
    assert.match(created.digest, /^[a-f0-9]{64}$/); assert.equal(created.writable, false);
    assert.ok((await json(base)).runs.some(run => run.id === mainRunId));
    await json(`${base}/${mainRunId}/concurrency`, { maxConcurrency: 3 });
    const ready = await json(`${base}/${mainRunId}`);
    assert.equal(ready.maxConcurrency, 3);
    await json(`${base}/${mainRunId}/start`, { digest: ready.digest, confirmed: true, allowReal: true });
    await waitRun(mainRunId);

    const awaiting = await json(`${base}/${mainRunId}`);
    assert.equal(awaiting.status, 'awaiting_user');
    const holeNode = Object.values(awaiting.nodes).find(node => node.kind === 'hole' && node.status === 'awaiting_user');
    assert.ok(holeNode?.id, 'manual hole should wait for a user answer');
    assert.equal(awaiting.phase, 'review');
    assert.equal(awaiting.reports.length, 1);
    assert.deepEqual(awaiting.reports[0], { round: 2, count: 2, content: 'SOURCE-A-ORIGINAL\n' });
    const planner = Object.values(awaiting.actors).find(actor => actor.name === 'planner');
    assert.ok(planner?.sessionId, 'planner actor should retain its session');
    assert.equal(planner.asks, 2);
    const plannerAsks = Object.values(awaiting.nodes).filter(node => node.kind === 'ask' && node.actorId === planner.id);
    assert.deepEqual(plannerAsks.map(node => node.actorSeq).sort(), [1, 2]);
    assert.equal(Object.values(awaiting.actors).filter(actor => actor.name?.startsWith('reader-')).length, 2);
    assert.equal(server.requests('ts', 'z6-main').length, 5, 'first invalid typed result must get one repair, followed by four settled asks');

    const page = await json(`${base}/${mainRunId}/events?afterSeq=0`);
    assert.ok(page.events.some(event => event.type === 'phase' && event.phase === 'collect'));
    assert.ok(page.events.some(event => event.type === 'phase' && event.phase === 'review'));
    assert.ok(page.events.some(event => event.type === 'log' && event.message === 'z6 local acceptance'));
    assert.ok(page.events.some(event => event.type === 'node_awaiting_user' && event.nodeId === holeNode.id));
    const latestSeq = page.events.at(-1).seq;
    const tail = await json(`${base}/${mainRunId}/events?afterSeq=${latestSeq - 1}`);
    assert.equal(tail.events.length, 1);

    await json(`${base}/${mainRunId}/resolve`, { nodeId: holeNode.id, answer: 'approved' });
    const resolved = await json(`${base}/${mainRunId}`);
    await json(`${base}/${mainRunId}/resume`, { digest: resolved.digest, confirmed: true, allowReal: true });
    await waitRun(mainRunId);
    const completed = await json(`${base}/${mainRunId}`);
    assert.equal(completed.status, 'completed');
    assert.deepEqual(completed.result, { round: 2, count: 2, approval: 'approved' });
    assert.equal(completed.reports.length, 1, 'resume must replay the report without duplicating it');
    assert.equal(server.requests('ts', 'z6-main').length, 5, 'cold journal replay must not call the model again');
    return { typedRepairRequests: 2, plannerAsks: 2, samePlannerSession: true, fanoutActors: 2, readOriginal: true, reportsAfterResume: 1, holeResolved: true, replayModelRequests: 0, totalModelRequests: 5, phaseAndLogEvents: true };
  });

  await scenario('amend_reuses_readonly_cache_without_replaying_models', async () => {
    assert.ok(mainRunId, 'main run must exist before amend');
    const base = `/api/sessions/${ownerSid}/workflow-scripts`;
    const previous = await json(`${base}/${mainRunId}`);
    assert.equal(previous.status, 'completed');
    const amendedSource = previous.source.replace("hole('review','Approve output?')", "'amended'");
    assert.notEqual(amendedSource, previous.source);
    const amended = await json(`${base}/${mainRunId}/amend`, { source: amendedSource });
    assert.notEqual(amended.id, mainRunId); assert.match(amended.digest, /^[a-f0-9]{64}$/); assert.equal(amended.status, 'draft');
    assert.equal(amended.importedFrom, mainRunId);
    assert.equal(amended.workspaceFingerprint, previous.workspaceFingerprint);
    await json(`${base}/${amended.id}/start`, { digest: amended.digest, confirmed: true, allowReal: true });
    await waitRun(amended.id);
    const result = await json(`${base}/${amended.id}`);
    const originalAfter = await json(`${base}/${mainRunId}`);
    assert.equal(result.status, 'completed');
    assert.deepEqual(result.result, { round: 2, count: 2, approval: 'amended' });
    assert.equal(result.reports.length, 1);
    assert.equal(originalAfter.result.approval, 'approved', 'the original completed run must not change');
    assert.equal(server.requests('ts', 'z6-main').length, 5, 'amend should reuse every read-only ask/read result');
    return { newRunId: true, matchingWorkspaceFingerprint: true, readOnlyAskAndReadCacheReused: true, amendedResult: 'amended', originalRunUnchanged: true, totalModelRequests: 5 };
  });

  await scenario('cancel_hung_actor_once_and_workflows_plugin_gate', async () => {
    await installLoopbackProfile('z6-cancel');
    const session = await createSession('Z6 cancel a hanging actor', 'z6-cancel');
    const base = `/api/sessions/${session.id}/workflow-scripts`;
    const created = await json(base, { source: "await agent('blocked').ask('Wait');", name: 'Z6 blocked actor' });
    const runPath = `${base}/${created.id}`;
    await json(runPath + '/start', { digest: created.digest, confirmed: true, allowReal: true });
    await waitForRequests('z6-cancel', 1);
    const cancelled = await json(runPath + '/cancel', {});
    assert.equal(cancelled.status, 'cancelled');
    await waitRun(created.id);
    await delay(150);
    const settled = await json(runPath);
    assert.equal(settled.status, 'cancelled'); assert.equal(settled.active, false);
    assert.equal(server.requests('ts', 'z6-cancel').length, 1, 'cancelled actor must not replay its request');
    cancellationRequests = server.requests('ts', 'z6-cancel').length;
    assert.ok(Object.values(settled.actors).some(actor => actor.name === 'blocked' && actor.sessionId));
    await json('/api/plugins/workflows', { enabled: false });
    await json(base, undefined, 403);
    await json('/api/plugins/workflows', { enabled: true });
    assert.equal(server.requests('ts', 'z6-cancel').length, 1);

    const beforeCloseRequests = server.requests('ts', 'z6-cancel').length;
    const closing = await json(base, { source: "await agent('blocked').ask('Wait');", name: 'Z6 host close actor' });
    await json(`${base}/${closing.id}/start`, { digest: closing.digest, confirmed: true, allowReal: true });
    await waitForRequests('z6-cancel', 2);
    const inFlight = await json(`${base}/${closing.id}`);
    assert.equal(inFlight.status, 'running'); assert.equal(inFlight.active, true);
    const closeWait = api.dynamicWorkflows.wait(closing.id);
    await withTimeout(api.close(), 30000, 'ApplicationApi.close with an active actor');
    apiClosed = true;
    await closeWait;
    const closedRun = api.dynamicWorkflows.store.load(closing.id);
    assert.equal(closedRun.status, 'cancelled', 'host close must cancel and await the active actor');
    assert.equal(server.requests('ts', 'z6-cancel').length, 2);
    hostCloseRequests = server.requests('ts', 'z6-cancel').length - beforeCloseRequests;
    return { status: 'cancelled', activeActorStopped: true, cancelModelRequests: cancellationRequests, replayed: false, workflowsPluginGate403: true, pluginRestored: true, hostCloseStatus: 'cancelled', hostCloseModelRequests: hostCloseRequests };
  });
} catch (error) {
  failures.push({ name: 'production_setup', error: String(error.stack ?? error) });
} finally {
  if (!apiClosed) {
    try { if (api) await withTimeout(api.close(), 30000, 'ApplicationApi.close during cleanup'); }
    catch (error) { failures.push({ name: 'application_close', error: String(error.stack ?? error) }); }
  }
  if (front) { front.closeAllConnections(); await new Promise(done => front.close(done)); }
  await server.close();
  if (dirname(resolve(scratch)) !== resolve(tmpdir()) || !basename(scratch).startsWith('xueness-verify-z6-')) throw new Error('unexpected scratch cleanup path');
  rmSync(scratch, { recursive: true, force: true });
}

const output = {
  ok: failures.length === 0,
  mode: built ? 'built' : 'source',
  network: 'loopback-only',
  scenarios: checks,
  failures,
  modelRequests: {
    typedWorkflow: server.requests('ts', 'z6-main').length,
    cancellationCase: cancellationRequests,
    hostCloseCase: hostCloseRequests,
    cancelledAndClosedWorkflowProfile: server.requests('ts', 'z6-cancel').length,
    total: server.requests('ts', 'z6-main').length + server.requests('ts', 'z6-cancel').length,
  },
};
const serialized = JSON.stringify(output, null, 2) + '\n';
const log = join(root, '验收资料', '验证记录', built ? 'z6-runtime-built-windows.json' : 'z6-runtime-source-windows.json');
mkdirSync(dirname(log), { recursive: true });
writeFileSync(log, serialized, 'utf8');
process.stdout.write(serialized);
if (failures.length) process.exitCode = 1;
