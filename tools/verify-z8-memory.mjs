/** Z8 memory-dream acceptance: the production API and loopback-only providers. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ScriptedServer } from '../ts/packages/providers/test/support/scripted-server.ts';
import { chunk, events, SSE_HEAD, USAGE_CHUNK } from '../ts/packages/providers/test/support/http-fixtures.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const built = process.argv.includes('--built');
const tsRoot = join(root, 'ts'), runtimeRoot = join(tsRoot, ...(built ? ['dist'] : [])), ext = built ? 'js' : 'ts';
const [appModule, frontModule, memoryModule] = await Promise.all([
  import(pathToFileURL(join(runtimeRoot, 'apps/server/src/application-api.' + ext)).href),
  import(pathToFileURL(join(runtimeRoot, 'apps/server/src/front-door.' + ext)).href),
  import(pathToFileURL(join(runtimeRoot, 'plugins/memory/src/memory.' + ext)).href),
]);

const schema = 'xueness.z8-memory.v1';
const scratch = mkdtempSync(join(tmpdir(), 'xueness-verify-z8-memory-'));
const workspace = join(scratch, '工作区 spaces'), otherWorkspace = join(scratch, '另一工作区');
const state = join(scratch, 'isolated state'), memoryRoot = join(scratch, 'isolated memory root');
const webRuns = join(scratch, 'isolated web runs');
const settingsFile = join(state, 'settings.json');
for (const path of [workspace, otherWorkspace, state, memoryRoot, webRuns]) mkdirSync(path, { recursive: true });
const workspaceIdentity = realpathSync(workspace), otherIdentity = realpathSync(otherWorkspace);
const mainProvider = 'z8-memory-main', hangProvider = 'z8-memory-hang', model = 'z8-memory-fixture-model';
const tracksA = memoryModule.trackPaths(memoryRoot, workspaceIdentity), tracksB = memoryModule.trackPaths(memoryRoot, otherIdentity);
for (const path of [dirname(tracksA.key), dirname(tracksB.key)]) mkdirSync(path, { recursive: true });
writeFileSync(tracksA.key, 'Existing project KEY value.\n');
writeFileSync(tracksA.memory, 'Global MEMORY value.\n');
writeFileSync(tracksA.user, 'USER preference value.\n');
writeFileSync(tracksB.key, 'Project B key must remain private.\n');
writeFileSync(join(workspace, 'probe.txt'), 'Z8 safe read fixture.\n');
const settingsValue = {
  workspace: { selectedRoots: [workspaceIdentity, otherIdentity], defaultRoot: workspaceIdentity },
  general: { sessionsAutoTitleEnabled: false, sessionsCancelPropagateEnabled: true, memoryEnabled: true },
};
writeFileSync(settingsFile, JSON.stringify(settingsValue));
const pluginState = join(state, 'plugin-state.json');
writeFileSync(pluginState, JSON.stringify({ apiVersion: 1, enabled: { memory: true } }));

const fixture = await ScriptedServer.start();
const candidateText = 'Use pnpm for project builds.\n';
const updatedText = 'Memory refresh marker after the first model request.\n';
const candidate = sourceSessionId => JSON.stringify({ content: candidateText, summary: 'Builds use pnpm.', sourceSessionIds: [sourceSessionId] });
const reply = text => SSE_HEAD + events([chunk({ role: 'assistant', content: text }, 'stop'), USAGE_CHUNK]);
const readTool = SSE_HEAD + events([
  chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'z8-memory-read', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: 'probe.txt' }) } }] }, 'tool_calls'),
  USAGE_CHUNK,
]);
// Request 1 is the one-shot dream; requests 2-3 are one agent turn around a safe read.
fixture.script(mainProvider, [reply(''), reply(''), reply('')]);
fixture.script(hangProvider, [[{ hang: true }]]);

const checks = [], failures = [];
let api, front, origin = '', ownerA = null, updatedDuringTurn = false, closed = false;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const hashFile = path => sha(readFileSync(path));
const withTimeout = async (promise, ms, label) => {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms); })]); }
  finally { if (timer) clearTimeout(timer); }
};
const waitForRequests = async (id, count, ms = 15000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (fixture.requests('ts', id).length >= count) return; await delay(20); }
  throw new Error(`provider ${id} received ${fixture.requests('ts', id).length}/${count} requests`);
};

async function scenario(name, body) {
  try { checks.push({ name, ok: true, ...(await body()) }); }
  catch (error) { failures.push({ name, error: String(error.stack ?? error) }); checks.push({ name, ok: false }); }
}
async function json(path, data, expected = 200) {
  const response = await fetch(origin + path, {
    method: data === undefined ? 'GET' : 'POST',
    headers: { ...(data === undefined ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': api.csrfToken }) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  let body; try { body = await response.json(); } catch { body = null; }
  assert.equal(response.status, expected, JSON.stringify(body));
  return body;
}
async function makeSession(task, rootPath, providerId) {
  const session = await api.store.new(task, rootPath);
  session.mode = 'build'; session.permission_mode = 'edit'; session.runtime_profile = 'standard';
  session.model_selection = { provider_id: providerId, model };
  (session.messages).push({ role: 'assistant', content: 'Project decision: use pnpm for builds.' });
  await api.store.save(session);
  return String(session.id);
}
async function installProvider(id) {
  await json('/api/providers', { id, name: 'Z8 loopback fixture', baseUrl: fixture.base('ts', id), model, apiKey: 'fixture-only-key', allowLoopbackHttp: true });
}
async function addDream(sessionId, sourceSessionId) {
  return json(`/api/sessions/${sessionId}/memory-dreams`, { sourceSessionIds: [sourceSessionId], name: 'Z8 project facts' });
}
async function updatePlugin(enabled) {
  writeFileSync(pluginState, JSON.stringify({ apiVersion: 1, enabled: { memory: enabled } }));
}
async function updateMemorySetting(enabled) {
  const value = JSON.parse(JSON.stringify(settingsValue)); value.general.memoryEnabled = enabled;
  writeFileSync(settingsFile, JSON.stringify(value));
}

try {
  api = await appModule.createApplicationApi({
    projectRoot: root, projectDir: workspaceIdentity, stateDir: state, webRuns, workspaceRoots: [workspaceIdentity, otherIdentity],
    scheduler: false, allowReal: true, env: { ...process.env, XUENESS_MEMORY_ROOT: memoryRoot },
    agent: { onEvent(sessionId, event) {
      if (sessionId === ownerA && event.type === 'tool_result' && event.name === 'read' && !updatedDuringTurn) {
        writeFileSync(tracksA.key, updatedText); updatedDuringTurn = true;
      }
    } },
  });
  front = frontModule.createFrontDoor({ webappDir: join(root, 'webapp/dist'), api });
  await new Promise(done => front.listen(0, '127.0.0.1', done));
  origin = `http://127.0.0.1:${front.address().port}`;
  await installProvider(mainProvider); await installProvider(hangProvider);

  ownerA = await makeSession('Z8 memory dream owner A', workspaceIdentity, mainProvider);
  const sourceA = await makeSession('Z8 source evidence A', workspaceIdentity, mainProvider);
  const ownerB = await makeSession('Z8 memory dream owner B', otherIdentity, mainProvider);
  const sourceB = await makeSession('Z8 source evidence B', otherIdentity, mainProvider);

  await scenario('isolated_draft_snapshot_and_one_shot_review_apply', async () => {
    const first = await addDream(ownerA, sourceA);
    assert.equal(first.status, 'draft'); assert.equal(first.sourceSessionIds.length, 1);
    assert.equal(fixture.requests('ts', mainProvider).length, 0, 'propose must not call a provider');
    assert.equal((await json(`/api/sessions/${ownerB}/memory-dreams/${first.id}`, undefined, 403)).error !== undefined, true);
    await json(`/api/sessions/${ownerA}/memory-dreams`, { sourceSessionIds: [sourceB] }, 400);

    await api.store.update(sourceA, session => {
      session.messages.push({ role: 'assistant', content: 'A newer durable project decision.' }); return true;
    });
    await json(`/api/sessions/${ownerA}/memory-dreams/${first.id}/start`, { digest: first.startDigest, confirmed: true, allowReal: true }, 409);
    assert.equal(fixture.requests('ts', mainProvider).length, 0, 'source drift must be rejected before model admission');

    // The next proposal captures the current source snapshot. First prove both explicit approvals are required.
    const draft = await addDream(ownerA, sourceA);
    await json(`/api/sessions/${ownerA}/memory-dreams/${draft.id}/start`, { digest: draft.startDigest, confirmed: false, allowReal: true }, 409);
    await json(`/api/sessions/${ownerA}/memory-dreams/${draft.id}/start`, { digest: draft.startDigest, confirmed: true, allowReal: false }, 403);
    assert.equal(fixture.requests('ts', mainProvider).length, 0);
    fixture.script(mainProvider, [reply(candidate(sourceA)), readTool, reply('Z8 memory refresh verified.')]);
    const started = await json(`/api/sessions/${ownerA}/memory-dreams/${draft.id}/start`, { digest: draft.startDigest, confirmed: true, allowReal: true });
    assert.equal(started.status, 'running');
    await withTimeout(api.memoryDreams.wait(draft.id), 20000, 'memory dream model handoff');
    const ready = await json(`/api/sessions/${ownerA}/memory-dreams/${draft.id}`);
    assert.equal(ready.status, 'ready'); assert.equal(ready.candidate.content, candidateText);
    assert.ok(ready.usage && ready.usage !== 'unknown', 'provider-reported usage must be preserved');
    assert.equal(readFileSync(tracksA.key, 'utf8'), 'Existing project KEY value.\n', 'ready candidates are not written to KEY.md');
    assert.equal(fixture.requests('ts', mainProvider).length, 1, 'start makes exactly one model request');
    const dreamRequest = JSON.parse(fixture.requests('ts', mainProvider)[0].body);
    assert.ok(!Array.isArray(dreamRequest.tools) || dreamRequest.tools.length === 0, 'handoff request must have no tools');
    assert.equal(dreamRequest.tool_choice, undefined, 'handoff request must not choose tools');

    const before = { key: hashFile(tracksA.key), memory: hashFile(tracksA.memory), user: hashFile(tracksA.user), otherKey: hashFile(tracksB.key) };
    await json(`/api/sessions/${ownerA}/memory-dreams/${draft.id}/apply`, { digest: ready.applyDigest, confirmed: false }, 409);
    await api.store.update(ownerA, session => { session.mode = 'plan'; session.permission_mode = 'plan'; return true; });
    await json(`/api/sessions/${ownerA}/memory-dreams/${draft.id}/apply`, { digest: ready.applyDigest, confirmed: true }, 403);
    await api.store.update(ownerA, session => { session.mode = 'build'; session.permission_mode = 'edit'; return true; });
    const applied = await json(`/api/sessions/${ownerA}/memory-dreams/${draft.id}/apply`, { digest: ready.applyDigest, confirmed: true });
    assert.equal(applied.status, 'applied'); assert.equal(readFileSync(tracksA.key, 'utf8'), candidateText);
    assert.notEqual(hashFile(tracksA.key), before.key);
    assert.equal(hashFile(tracksA.memory), before.memory); assert.equal(hashFile(tracksA.user), before.user);
    assert.equal(hashFile(tracksB.key), before.otherKey, 'a different project key must remain untouched');

    const beforeCompactions = (await api.store.load(ownerA)).compactions.length;
    const run = await json(`/api/sessions/${ownerA}/run`, {});
    assert.equal(run.status, 'completed', JSON.stringify(run));
    assert.equal(updatedDuringTurn, true, 'the read tool result should change KEY between two prepareRequest calls');
    const requests = fixture.requests('ts', mainProvider);
    assert.equal(requests.length, 3, 'dream and the two-request agent turn must each call once');
    const beforeRefresh = JSON.parse(requests[1].body), afterRefresh = JSON.parse(requests[2].body);
    assert.ok(beforeRefresh.messages.some(row => typeof row.content === 'string' && row.content.includes(candidateText.trim())), 'the first request must see the applied candidate');
    assert.ok(afterRefresh.messages.some(row => typeof row.content === 'string' && row.content.includes(updatedText.trim())), 'the next request must reread the changed memory track');
    const afterCompactions = (await api.store.load(ownerA)).compactions.length;
    assert.equal(afterCompactions, beforeCompactions, 'memory refresh must not require compaction');
    return { sourceDriftStatus: 409, foreignOwnerStatus: 403, crossProjectSourceStatus: 400,
      proposeProviderRequests: 0, missingStartConfirmationStatus: 409, missingAllowRealStatus: 403,
      dreamProviderRequests: 1, dreamTools: dreamRequest.tools?.length ?? 0, usageReported: true,
      readyWroteKey: false, planApplyStatus: 403, applied: true, onlyProjectKeyChanged: true,
      prepareRequestRefreshedAfterFileChange: true, compactionsBefore: beforeCompactions, compactionsAfter: afterCompactions };
  });

  await scenario('general_memory_enabled_gate', async () => {
    const before = fixture.requests('ts', mainProvider).length;
    await updateMemorySetting(false);
    await json(`/api/sessions/${ownerA}/memory-dreams`, { sourceSessionIds: [sourceA] }, 403);
    assert.equal(fixture.requests('ts', mainProvider).length, before, 'disabled memory must refuse before provider admission');
    await updateMemorySetting(true);
    return { disabledDreamStatus: 403, modelRequestsWhileDisabled: 0, settingRestored: true };
  });

  await scenario('plugin_disable_aborts_and_drains_model_job', async () => {
    const owner = await makeSession('Z8 disable in-flight memory dream', workspaceIdentity, hangProvider);
    const draft = await addDream(owner, sourceA);
    await json(`/api/sessions/${owner}/memory-dreams/${draft.id}/start`, { digest: draft.startDigest, confirmed: true, allowReal: true });
    await waitForRequests(hangProvider, 1);
    await updatePlugin(false);
    await withTimeout(api.memoryDreams.wait(draft.id), 10000, 'disabled memory dream drain');
    const persisted = JSON.parse(readFileSync(join(state, 'memory-dreams', `${draft.id}.json`), 'utf8'));
    assert.equal(persisted.status, 'cancelled'); assert.equal(fixture.requests('ts', hangProvider).length, 1);
    await updatePlugin(true);
    return { providerRequests: 1, pluginDisableAbortedJob: true, persistedStatus: persisted.status, drained: true };
  });

  await scenario('application_close_aborts_and_drains_without_orphan', async () => {
    const owner = await makeSession('Z8 close in-flight memory dream', workspaceIdentity, hangProvider);
    const draft = await addDream(owner, sourceA);
    await json(`/api/sessions/${owner}/memory-dreams/${draft.id}/start`, { digest: draft.startDigest, confirmed: true, allowReal: true });
    await waitForRequests(hangProvider, 2);
    await withTimeout(api.close(), 15000, 'ApplicationApi close with active memory dream'); closed = true;
    await api.memoryDreams.wait(draft.id);
    const persisted = JSON.parse(readFileSync(join(state, 'memory-dreams', `${draft.id}.json`), 'utf8'));
    assert.equal(persisted.status, 'cancelled'); assert.equal(fixture.requests('ts', hangProvider).length, 2);
    return { totalProviderRequests: 2, closeAbortedJob: true, persistedStatus: persisted.status, noOrphanAfterClose: true };
  });
} catch (error) {
  failures.push({ name: 'setup_or_scenario', error: String(error.stack ?? error) });
} finally {
  if (front) {
    front.closeAllConnections();
    await new Promise(resolveClose => front.close(() => resolveClose()));
  }
  if (api && !closed) { try { await api.close(); } catch (error) { failures.push({ name: 'api_cleanup', error: String(error.stack ?? error) }); } }
  await fixture.close();
  if (resolve(dirname(scratch)) !== resolve(tmpdir()) || !basename(scratch).startsWith('xueness-verify-z8-memory-')) throw new Error('unexpected scratch cleanup path');
  rmSync(scratch, { recursive: true, force: true });
}

const output = { schema, ok: failures.length === 0, mode: built ? 'built' : 'source', network: '127.0.0.1-only', scenarios: checks, failures,
  providerRequests: { memoryMain: fixture.requests('ts', mainProvider).length, cancellation: fixture.requests('ts', hangProvider).length,
    total: fixture.requests('ts', mainProvider).length + fixture.requests('ts', hangProvider).length } };
const serialized = JSON.stringify(output, null, 2) + '\n';
const log = join(root, '验收资料', '验证记录', `z8-memory-${built ? 'built' : 'source'}.json`);
mkdirSync(dirname(log), { recursive: true }); writeFileSync(log, serialized, 'utf8');
process.stdout.write(serialized);
if (failures.length) process.exitCode = 1;
