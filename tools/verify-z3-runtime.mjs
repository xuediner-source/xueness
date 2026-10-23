import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { dirname, basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ScriptedServer } from '../ts/packages/providers/test/support/scripted-server.ts';
import { chunk, events, SSE_HEAD, USAGE_CHUNK } from '../ts/packages/providers/test/support/http-fixtures.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), built = process.argv.includes('--built');
const mode = built ? 'built' : 'source', ts = join(root, 'ts', ...(built ? ['dist'] : []));
const require = createRequire(join(ts, 'package.json'));
const pkg = name => import(pathToFileURL(require.resolve(name)).href);
const [sessions, plugin, contracts, appModule, frontModule] = await Promise.all([
  pkg('@xueness/sessions'), pkg('@xueness/plugin-sessions'), pkg('@xueness/contracts'),
  import(pathToFileURL(join(ts, 'apps/server/src/application-api.' + (built ? 'js' : 'ts'))).href),
  import(pathToFileURL(join(ts, 'apps/server/src/front-door.' + (built ? 'js' : 'ts'))).href),
]);
const scratch = mkdtempSync(join(tmpdir(), 'xueness-verify-z3-')), workspace = join(scratch, 'workspace'), state = join(scratch, 'state');
mkdirSync(workspace); mkdirSync(state);
writeFileSync(join(workspace, 'memo.txt'), 'original 世界🙂\r\n');
writeFileSync(join(state, 'settings.json'), JSON.stringify({ workspace: { selectedRoots: [workspace], defaultRoot: workspace }, general: { sessionsAutoTitleEnabled: false } }));
const server = await ScriptedServer.start(), scenarioId = 'z3-main';
const toolReply = calls => SSE_HEAD + events([chunk({ tool_calls: calls.map(([id, name, args], index) => ({ index, id, type: 'function', function: { name, arguments: JSON.stringify(args) } })) }, 'tool_calls'), USAGE_CHUNK]);
server.script(scenarioId, [
  toolReply([['read-one', 'Read', { file_path: join(workspace, 'memo.txt') }]]),
  toolReply([['write-one', 'Write', { file_path: join(workspace, 'memo.txt'), content: 'agent revision\n' }], ['write-two', 'Write', { file_path: join(workspace, 'new.txt'), content: 'created\n' }]]),
  SSE_HEAD + events([chunk({ content: 'Updated files.\nEvidence: E1 E2 E3' }, 'stop'), USAGE_CHUNK]),
]);
const checks = [], failures = []; let api, front, origin, sessionId;
const startedAt = performance.now();
async function json(path, data, expected = 200) {
  const response = await fetch(origin + path, { method: data === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': api.csrfToken }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const body = await response.json(); assert.equal(response.status, expected, JSON.stringify(body)); return body;
}
async function check(name, fn) { try { checks.push({ name, ...await fn() }); } catch (error) { failures.push({ name, error: String(error.message ?? error) }); } }
try {
  api = await appModule.createApplicationApi({ projectRoot: root, projectDir: workspace, stateDir: state, webRuns: join(scratch, 'runs'), scheduler: false, env: { XUENESS_SESSION_SQLITE: '1' }, allowReal: true, agent: { approver: () => () => ({ behavior: 'allow' }) } });
  front = frontModule.createFrontDoor({ webappDir: join(root, 'webapp/dist'), api });
  await new Promise(done => front.listen(0, '127.0.0.1', done)); origin = `http://127.0.0.1:${front.address().port}`;
  await json('/api/providers', { id: 'local', name: 'Loopback fixture', baseUrl: server.base('ts', scenarioId), model: 'z3-fixture', apiKey: 'fixture', allowLoopbackHttp: true });
  sessionId = (await json('/api/sessions', { task: 'Update memo and create a new file' })).id;
  const run = await json(`/api/sessions/${sessionId}/run`, { provider_id: 'local', steps: 8 });
  assert.equal(run.status, 'completed'); assert.equal(server.requests('ts', scenarioId).length, 3);

  await check('durable_runtime_event_recovery', async () => {
    let page = await json(`/api/sessions/${sessionId}/events.runtime?limit=5`), projection = contracts.recoverRuntimeProjection(page);
    let pages = 1, eventCount = page.events.length;
    while (page.hasMore) {
      page = await json(`/api/sessions/${sessionId}/events.runtime?after=${page.next}&epoch=${page.epoch}&limit=5`);
      projection = contracts.recoverRuntimeProjection(page, projection); eventCount += page.events.length; pages++;
    }
    assert.equal(projection.status, 'completed'); assert.equal(projection.tools.length, 3); assert.equal(projection.gaps.length, 0);
    assert.ok(projection.transcript.some(row => row.text.includes('Updated files')));
    const cold = plugin.createSessionRuntimeEventLog(state, sessionId).metadata(); assert.equal(cold.lastSequenceNumber, page.head);
    const s = await api.store.load(sessionId); assert.ok(s.stable_fork_boundaries?.length);
    const response = await fetch(`${origin}/api/sessions/${sessionId}/events.runtime`, { headers: { Accept: 'text/event-stream', 'Last-Event-ID': `re1.${page.epoch}.${page.head - 1}` } });
    assert.equal(response.status, 200); assert.match(await response.text(), /event: RunSettled|event: TurnPhase/);
    return { pages, eventCount, coldHead: cold.lastSequenceNumber, toolResults: projection.tools.length, stableBoundary: true, lastEventId: true };
  });

  await check('sqlite_snapshot_query_and_migration', async () => {
    await api.store.update(sessionId, s => { s.large_integer = 9007199254740993n; s.negative_zero = new contracts.JsonFloat(-0); return true; });
    const status = await json('/api/sessions/storage');
    const listed = await json('/api/sessions/storage/list?root=' + encodeURIComponent(workspace));
    assert.ok(JSON.stringify(listed).includes(sessionId));
    const library = new plugin.SqliteSessionLibrary(state), row = library.listReadOnly().find(item => item.id === sessionId);
    assert.equal(row.session.large_integer, 9007199254740993n); assert.match(contracts.pyJsonDumps(row.session), /"negative_zero": -0.0/);
    const output = join(scratch, 'exported'); const exported = plugin.exportSessionLibrary(state, output);
    const cold = new sessions.SessionStore(output), restored = await cold.load(sessionId), revision = restored.history_revision;
    restored.title = 'continued after migration'; await cold.save(restored);
    assert.ok(Number(restored.history_revision) > Number(revision));
    return { enabled: true, exported: exported.exported, lossless: true, revisionContinued: true, statusAvailable: !!status };
  });

  await check('fork_with_guidance_and_system_notice', async () => {
    await api.store.update(sessionId, s => {
      const final = s.messages.findLastIndex(m => m.role === 'assistant' && !m.tool_calls?.length);
      s.messages.splice(final, 0, { role: 'user', content: 'Keep the existing scope', _input_kind: 'guide' }, { role: 'user', content: 'Background status', _input_kind: 'background_notice', _meta_source: 'task_status', _background_task_notice: 'fixture:exited' }); return true;
    });
    const listed = await json(`/api/sessions/${sessionId}/fork-boundaries`); assert.equal(listed.boundaries.length, 1);
    const created = await json(`/api/sessions/${sessionId}/fork`, { revision: listed.revision, boundary: listed.boundaries[0].token }, 201);
    const source = await api.store.load(sessionId), child = await api.store.load(created.session.id);
    const sourceIds = new Set(source.messages.map(m => m._message_id));
    assert.ok(child.messages.every(m => !sourceIds.has(m._message_id)));
    assert.ok(Object.keys(child.results).every(id => !Object.hasOwn(source.results, id)));
    assert.equal(server.requests('ts', scenarioId).length, 3);
    return { boundaries: 1, childLocalIdentities: true, childTools: Object.keys(child.results).length, effectReplay: false };
  });

  await check('file_and_conversation_rewind', async () => {
    let current = await api.store.load(sessionId); const messageId = current.messages[1]._message_id;
    const preview = await json(`/api/sessions/${sessionId}/file-rewind?messageId=${messageId}`); assert.equal(preview.canApply, true); assert.equal(preview.files.length, 2);
    await json(`/api/sessions/${sessionId}/file-rewind`, { messageId, revision: preview.revision, confirmed: true });
    assert.equal(readFileSync(join(workspace, 'memo.txt'), 'utf8'), 'original 世界🙂\r\n'); assert.equal(existsSync(join(workspace, 'new.txt')), false);
    const targets = await json(`/api/sessions/${sessionId}/rewind-targets`);
    await json(`/api/sessions/${sessionId}/rewind`, { messageId, revision: targets.revision, confirmed: true });
    current = await new sessions.SessionStore(state).load(sessionId); assert.equal(current.messages.length, 1); assert.equal(Object.keys(current.results).length, 0);
    const log = plugin.createSessionRuntimeEventLog(state, sessionId).readPage({ limit: 500 });
    assert.ok(log.events.some(event => event.type === 'HistoryReset' && event.payload.generation === 1));
    assert.ok(log.events.some(event => event.type === 'FileRewound'));
    assert.equal(contracts.recoverRuntimeProjection(log).tools.length, 0);
    assert.equal(server.requests('ts', scenarioId).length, 3);
    return { restoredFiles: 2, retainedMessages: 1, generation: 1, effectReplay: false, resetEvent: true };
  });
} catch (error) { failures.push({ name: 'production_setup', error: String(error.message ?? error) }); }
finally {
  if (front) { front.closeAllConnections(); await new Promise(done => front.close(done)); }
  await api?.close(); await server.close();
  const target = resolve(scratch);
  if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('xueness-verify-z3-')) throw new Error('unexpected scratch cleanup path');
  rmSync(target, { recursive: true, force: true });
}
process.stdout.write(JSON.stringify({ ok: failures.length === 0, mode, network: 'loopback-only', scenarios: checks, failures, totalScenarios: checks.length, modelRequests: server.requests('ts', scenarioId).length, elapsedMs: Math.round(performance.now() - startedAt) }) + '\n');
if (failures.length) process.exitCode = 1;
