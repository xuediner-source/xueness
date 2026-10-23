/** Z7 native stdio protocol acceptance: real CLI child + loopback-only provider. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ScriptedServer } from '../ts/packages/providers/test/support/scripted-server.ts';
import { chunk, events, SSE_HEAD, USAGE_CHUNK } from '../ts/packages/providers/test/support/http-fixtures.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const built = process.argv.includes('--built');
const tsRoot = join(root, 'ts'), runtimeRoot = join(tsRoot, ...(built ? ['dist'] : []));
const ext = built ? 'js' : 'ts';
const managerOps = await import(pathToFileURL(join(runtimeRoot, 'plugins/remote/src/manager-ops.' + ext)).href);
// Seed journals through the native store. The acceptance child itself is the
// source or built CLI under test; this helper import only prepares fixtures.
const { SessionStore } = await import(pathToFileURL(join(tsRoot, 'packages/sessions/src/store.ts')).href);
const schema = 'xueness.headless.v1';
const scratch = mkdtempSync(join(tmpdir(), 'xueness-verify-z7-'));
const workspace = join(scratch, '工作区 spaces');
const otherWorkspace = join(scratch, '另一工作区');
const state = join(scratch, 'isolated state');
mkdirSync(workspace, { recursive: true }); mkdirSync(otherWorkspace, { recursive: true }); mkdirSync(state, { recursive: true });
const workspaceIdentity = realpathSync(workspace);
const otherIdentity = realpathSync(otherWorkspace);
const mainProvider = 'z7-main', hangProvider = 'z7-hang', model = 'z7-fixture-model';
writeFileSync(join(state, 'settings.json'), JSON.stringify({
  workspace: { selectedRoots: [workspaceIdentity, otherIdentity], defaultRoot: workspaceIdentity },
  general: { sessionsAutoTitleEnabled: false, sessionsCancelPropagateEnabled: true, sessionsAnswerQuestionEnabled: true },
}));
writeFileSync(join(state, 'plugin-state.json'), JSON.stringify({ apiVersion: 1, enabled: { remote: true } }));

const fixture = await ScriptedServer.start();
const completion = text => SSE_HEAD + events([chunk({ role: 'assistant', content: text }, 'stop'), USAGE_CHUNK]);
fixture.script(mainProvider, [
  completion('Z7-HEADLESS-TEXT'), completion('Z7-HEADLESS-JSON'), completion('Z7-HEADLESS-STREAM'), completion('Z7-HEADLESS-CONTINUE'),
]);
fixture.script(hangProvider, [[{ hang: true }]]);
mkdirSync(join(state, 'providers'), { recursive: true });
for (const id of [mainProvider, hangProvider]) writeFileSync(join(state, 'providers', id + '.json'), JSON.stringify({
  id, name: 'Z7 loopback fixture', baseUrl: fixture.base('ts', id), model, apiKey: 'fixture-only-key',
  allowLoopbackHttp: true, capabilities: ['image'],
}));

const store = new SessionStore(state);
const checks = [], failures = [];
let peer = null, oldSnapshot = null, durableSessionId = null, createCommandId = null, sendCommandId = null, runCommandId = null;
let questionSessionId = null, mediaSessionId = null, continueSessionId = null;

class RpcError extends Error {
  constructor(frame) { super(frame.error?.message ?? 'JSON-RPC request failed'); this.frame = frame; }
}

class AppServerChild {
  constructor(child) {
    this.child = child; this.lines = []; this.notifications = []; this.waiters = [];
    this.pending = new Map(); this.nextId = 1; this.stdout = ''; this.stderr = ''; this.parseFailures = [];
    this.exit = new Promise(resolveExit => { this.resolveExit = resolveExit; });
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', value => this.#stdout(value)); child.stderr.on('data', value => { this.stderr += value; });
    child.once('error', error => { this.spawnError = error; this.resolveExit({ code: null, signal: null, error }); });
    child.once('close', (code, signal) => {
      this.resolveExit({ code, signal });
      for (const [id, request] of this.pending) request.reject(new Error(`app-server exited before response ${id}; exit=${code}, stderr=${this.stderr.slice(-4000)}`));
      this.pending.clear();
    });
  }
  #stdout(value) {
    this.stdout += value;
    for (;;) {
      const newline = this.stdout.indexOf('\n'); if (newline < 0) break;
      const line = this.stdout.slice(0, newline).replace(/\r$/, ''); this.stdout = this.stdout.slice(newline + 1);
      if (!line) { this.parseFailures.push('empty stdout frame'); continue; }
      let frame;
      try { frame = JSON.parse(line); } catch { this.parseFailures.push(line.slice(0, 240)); continue; }
      const record = { frame, at: this.lines.length };
      this.lines.push(record);
      if (Object.hasOwn(frame, 'id') && this.pending.has(frame.id)) {
        const request = this.pending.get(frame.id); this.pending.delete(frame.id);
        if (frame.error) request.reject(new RpcError(frame)); else request.resolve(frame.result);
      } else if (typeof frame.method === 'string') {
        this.notifications.push(record);
        for (const waiter of [...this.waiters]) if (waiter.accepts(frame)) {
          this.waiters.splice(this.waiters.indexOf(waiter), 1); clearTimeout(waiter.timer); waiter.resolve(record);
        }
      } else this.parseFailures.push(`unmatched response id ${String(frame.id)}`);
    }
  }
  start(method, params = {}) {
    const id = this.nextId++;
    let resolveRequest, rejectRequest;
    const promise = new Promise((resolveValue, rejectValue) => { resolveRequest = resolveValue; rejectRequest = rejectValue; });
    this.pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return { id, promise };
  }
  request(method, params = {}) { return this.start(method, params).promise; }
  hasPending(id) { return this.pending.has(id); }
  notification(method, predicate = () => true, timeoutMs = 10000) {
    const found = this.notifications.find(item => item.frame.method === method && predicate(item.frame));
    if (found) { this.notifications.splice(this.notifications.indexOf(found), 1); return Promise.resolve(found); }
    return new Promise((resolveValue, rejectValue) => {
      const waiter = { accepts: frame => frame.method === method && predicate(frame), resolve: resolveValue, timer: null };
      waiter.timer = setTimeout(() => { this.waiters.splice(this.waiters.indexOf(waiter), 1); rejectValue(new Error(`timed out waiting for ${method}`)); }, timeoutMs);
      this.waiters.push(waiter);
    });
  }
  async finish() {
    if (this.child.exitCode === null && this.child.signalCode === null) {
      try { await withTimeout(this.request('shutdown'), 8000, 'app-server shutdown response'); } catch { /* EOF remains the cleanup path. */ }
      this.child.stdin.end();
    }
    const status = await withTimeout(this.exit, 12000, 'app-server EOF exit');
    return status;
  }
}

function startAppServer() {
  const entry = join(runtimeRoot, 'apps/server/src/cli/main.' + ext);
  const args = [entry, '--state', state, 'app-server', '--workspace-root', workspaceIdentity, '--allow-real-provider'];
  const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, XUENESS_ALLOW_REAL: '1' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  return new AppServerChild(child);
}

async function runHeadless(args, timeoutMs = 90000) {
  const entry = join(runtimeRoot, 'apps/server/src/cli/main.' + ext);
  const child = spawn(process.execPath, [entry, '--state', state, 'headless', ...args], {
    cwd: root, env: { ...process.env, XUENESS_ALLOW_REAL: '1' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; });
  const status = await withTimeout(new Promise((done, reject) => {
    child.once('error', reject); child.once('close', (code, signal) => done({ code, signal }));
  }), timeoutMs, 'headless CLI exit');
  return { ...status, stdout, stderr };
}

function commandId() { return `c_${String(Date.now()).padStart(13, '0')}_${randomBytes(16).toString('hex')}`; }
const scope = sessionId => ({ workspaceIdentity, sessionId });
const command = (sessionId, id, type, payload) => peer.request('command/execute', { ...scope(sessionId), commandId: id, type, payload });
const queryCommand = (sessionId, id) => peer.request('command/query', { ...scope(sessionId), commandId: id });
const assertRpcRefusal = async (promise, code, label) => {
  await assert.rejects(promise, error => error instanceof RpcError && error.frame.error.code === code, label);
};
async function withTimeout(promise, timeoutMs, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs); })]); }
  finally { if (timer) clearTimeout(timer); }
}
async function waitUntil(read, accept, label, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await read(); if (accept(value)) return value;
    await delay(80);
  }
  throw new Error(`${label} did not reach the expected state`);
}
async function scenario(name, body) {
  try { checks.push({ name, ok: true, ...(await body()) }); }
  catch (error) { failures.push({ name, error: String(error.stack ?? error) }); checks.push({ name, ok: false }); }
}
function orderOf(peerValue, predicate) { return peerValue.lines.find(item => predicate(item.frame))?.at ?? -1; }
function assertNoAnsi(text, label) { assert.doesNotMatch(text, /\u001b\[[0-?]*[ -/]*[@-~]/u, `${label} contains ANSI escape codes`); }
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

try {
  peer = startAppServer();
  const hello = await withTimeout(peer.request('initialize', { protocolVersion: 1 }), 20000, 'v1 initialize');
  assert.ok(managerOps.acceptHello(hello), 'the plugin manager must accept the real v1 initialize result');
  assert.equal(hello.workspaceIdentity, workspaceIdentity, 'the server identity must be the canonical workspace root');

  await scenario('v1_manager_identity_and_workspace_isolation', async () => {
    const index = await peer.request('workspace/index', { workspaceIdentity });
    assert.equal(index.workspaceIdentity, workspaceIdentity); assert.equal(index.root, workspaceIdentity);
    const sessionIndex = await peer.request('sessions/index', { workspaceIdentity });
    assert.ok(managerOps.acceptIndex(sessionIndex, workspaceIdentity));
    assertRpcRefusal(peer.request('sessions/index', { workspaceIdentity: otherIdentity }), -32000, 'foreign workspace identity must be refused');
    const foreign = await store.new('Z7 cross-workspace refusal', otherIdentity);
    assertRpcRefusal(peer.request('session/read', { workspaceIdentity, sessionId: String(foreign.id) }), -32000, 'foreign session root must be refused');
    return { protocolName: hello.protocolName, workspaceIdentity, managerAcceptedHello: true, managerAcceptedIndex: true, foreignIdentityRefused: true, foreignSessionRefused: true };
  });

  await scenario('durable_create_send_receipts_and_controlled_long_run', async () => {
    const before = (await store.list()).length;
    createCommandId = commandId();
    const createPayload = { task: 'Z7 durable run cancellation fixture', provider_id: hangProvider, model };
    const created = await command(null, createCommandId, 'create_session', createPayload);
    assert.equal(created.status, 'accepted', JSON.stringify(created));
    durableSessionId = created.result.id;
    assert.match(durableSessionId, /^[0-9a-f]{32}$/);
    const duplicateCreate = await command(null, createCommandId, 'create_session', createPayload);
    assert.equal(duplicateCreate.status, 'duplicate'); assert.equal(duplicateCreate.originalStatus, 'accepted');
    const conflictCreate = await command(null, createCommandId, 'create_session', { ...createPayload, task: 'changed payload' });
    assert.equal(conflictCreate.status, 'rejected'); assert.equal(conflictCreate.reasonCode, 'command_id_conflict');
    assert.equal((await store.list()).length, before + 1, 'create retry/conflict must not create another journal');
    assert.equal((await queryCommand(null, createCommandId)).result.status, 'accepted');

    sendCommandId = commandId(); const text = 'hold this real run until the stop control arrives';
    const sent = await command(durableSessionId, sendCommandId, 'send', { text });
    assert.equal(sent.status, 'accepted', JSON.stringify(sent));
    const savedAfterSend = await store.load(durableSessionId), userCount = savedAfterSend.messages.filter(message => message.role === 'user').length;
    const duplicateSend = await command(durableSessionId, sendCommandId, 'send', { text });
    assert.equal(duplicateSend.status, 'duplicate'); assert.equal(duplicateSend.originalStatus, 'accepted');
    const conflictSend = await command(durableSessionId, sendCommandId, 'send', { text: 'a different command body' });
    assert.equal(conflictSend.reasonCode, 'command_id_conflict');
    assert.equal((await store.load(durableSessionId)).messages.filter(message => message.role === 'user').length, userCount, 'send retry must append exactly once');
    assert.equal((await queryCommand(durableSessionId, sendCommandId)).result.status, 'accepted');

    runCommandId = commandId();
    const running = peer.start('command/execute', { ...scope(durableSessionId), commandId: runCommandId, type: 'run', payload: {} });
    await waitUntil(() => fixture.requests('ts', hangProvider).length, count => count === 1, 'loopback model admission', 30000);
    assert.ok(peer.hasPending(running.id), 'durable run must stay pending while the actual AgentRunner is waiting on the fixture');
    const queryStarted = Date.now();
    assert.equal((await queryCommand(durableSessionId, runCommandId)).result, 'unknown');
    const busyCommand = await command(durableSessionId, commandId(), 'send', { text: 'must not be accepted while running' });
    assert.equal(busyCommand.status, 'rejected');
    assert.ok(['session_busy', 'state_conflict'].includes(busyCommand.reasonCode), JSON.stringify(busyCommand));
    const active = await peer.request('session/read', scope(durableSessionId));
    assert.ok(active.active_turn_id, 'the run must have a persisted active turn before stop');
    const stopped = await command(durableSessionId, commandId(), 'stop', { expected_turn_id: active.active_turn_id });
    assert.ok(['accepted', 'noop'].includes(stopped.status), JSON.stringify(stopped));
    assert.ok(Date.now() - queryStarted < 3000, 'query and stop controls should be serviced while run is pending');
    const runAck = await withTimeout(running.promise, 20000, 'durable AgentRunner result');
    assert.ok(['accepted', 'failed'].includes(runAck.status), JSON.stringify(runAck));
    const runQuery = await queryCommand(durableSessionId, runCommandId);
    assert.equal(runQuery.result.commandId, runCommandId); assert.equal(runQuery.result.status, runAck.status);
    const duplicateRun = await command(durableSessionId, runCommandId, 'run', {});
    assert.equal(duplicateRun.status, 'duplicate'); assert.equal(fixture.requests('ts', hangProvider).length, 1, 'a settled run retry must not call the provider again');
    const snapshot = await peer.request('conversation/snapshot', scope(durableSessionId));
    oldSnapshot = { logEpoch: snapshot.logEpoch, seq: snapshot.seq };
    return { createStatus: created.status, createRetry: duplicateCreate.status, createConflict: conflictCreate.reasonCode, oneCreatedJournal: true,
      sendRetry: duplicateSend.status, sendConflict: conflictSend.reasonCode, sendQuery: 'accepted', runStayedPendingUntilStop: true,
      concurrentQueryStopResponsive: true, runStatus: runAck.status, modelRequests: fixture.requests('ts', hangProvider).length };
  });

  if (peer) {
    const status = await peer.finish(); peer = null;
    assert.equal(status.code, 0, `app-server must exit after shutdown/EOF; stderr: ${status.error ?? ''}`);
  }

  await scenario('restart_queries_ack_and_old_epoch_falls_back_without_replay', async () => {
    assert.ok(durableSessionId && runCommandId && oldSnapshot);
    peer = startAppServer();
    const hello = await withTimeout(peer.request('initialize', { protocolVersion: 1 }), 20000, 'restart v1 initialize');
    assert.ok(managerOps.acceptHello(hello));
    const created = await queryCommand(null, createCommandId);
    assert.equal(created.result.commandId, createCommandId); assert.equal(created.result.status, 'accepted');
    const run = await queryCommand(durableSessionId, runCommandId);
    assert.ok(['accepted', 'failed'].includes(run.result.status));
    const resumed = await peer.request('conversation/resume', { ...scope(durableSessionId), ...oldSnapshot });
    assert.equal(resumed.mode, 'snapshot', 'an epoch from the prior process must request a fresh snapshot');
    assert.equal(fixture.requests('ts', hangProvider).length, 1, 'startup must never replay an acknowledged run');
    return { createAckSurvivedRestart: true, runAckSurvivedRestart: true, oldEpochMode: resumed.mode, automaticReplayRequests: 0 };
  });

  await scenario('v2_deferred_subscriptions_flow_resync_and_workflow_resume', async () => {
    const previous = await peer.finish(); peer = null;
    assert.equal(previous.code, 0, `v1 connection must close cleanly before a fresh v2 negotiation; stderr: ${previous.error ?? ''}`);
    peer = startAppServer();
    const hello = await peer.request('initialize', { protocolVersion: 2 });
    assert.equal(hello.protocolName, 'xueness.app-server.v2'); assert.equal(hello.workspaceIdentity, workspaceIdentity);
    const controllerRequest = peer.start('controller/subscribe', { workspaceIdentity });
    const controllerAck = await controllerRequest.promise;
    const controllerFrame = await peer.notification('controller/frame', p => p.params.subscriptionId === controllerAck.subscriptionId);
    assert.equal(controllerFrame.frame.params.delivery, 'initial');
    assert.ok(controllerAck.accepted);
    assert.ok(controllerRequest.id < 0 || controllerRequest.id > 0);
    const controllerResponseAt = orderOf(peer, frame => frame.id === controllerRequest.id && frame.result?.subscriptionId === controllerAck.subscriptionId);
    assert.ok(controllerResponseAt >= 0 && controllerResponseAt < controllerFrame.at, 'controller ACK must precede its initial frame');

    const subRequest = peer.start('conversation/subscribe', scope(durableSessionId));
    const sub = await subRequest.promise;
    const initial = await peer.notification('conversation/frame', p => p.params.subscriptionId === sub.subscriptionId);
    assert.equal(initial.frame.params.delivery, 'initial');
    const subResponseAt = orderOf(peer, frame => frame.id === subRequest.id && frame.result?.subscriptionId === sub.subscriptionId);
    assert.ok(subResponseAt >= 0 && subResponseAt < initial.at, 'conversation ACK must precede its initial frame');

    const sendDelta = async text => command(durableSessionId, commandId(), 'send', { text });
    await sendDelta('subscription persistent delta one');
    const delta = await peer.notification('conversation/frame', p => p.params.subscriptionId === sub.subscriptionId && p.params.delivery === 'online');
    assert.equal(delta.frame.params.envelope.mode, 'resume');

    await peer.request('connection/flow', { workspaceIdentity, paused: true });
    const pausedAt = peer.lines.length;
    await sendDelta('subscription change while paused'); await delay(550);
    assert.equal(peer.lines.slice(pausedAt).filter(item => item.frame.method === 'conversation/frame' && item.frame.params.subscriptionId === sub.subscriptionId).length, 0,
      'paused flow must withhold conversation frames');
    await peer.request('connection/flow', { workspaceIdentity, paused: false });
    await peer.notification('conversation/frame', p => p.params.subscriptionId === sub.subscriptionId && p.params.delivery === 'online');

    const resyncRequest = peer.start('conversation/resync', { workspaceIdentity, subscriptionId: sub.subscriptionId });
    const resync = await resyncRequest.promise;
    const recovery = await peer.notification('conversation/frame', p => p.params.subscriptionId === sub.subscriptionId && p.params.delivery === 'recovery');
    const resyncResponseAt = orderOf(peer, frame => frame.id === resyncRequest.id && frame.result?.generation === resync.generation);
    assert.ok(resyncResponseAt >= 0 && resyncResponseAt < recovery.at, 'resync ACK must precede recovery frame');
    assert.equal((await peer.request('conversation/unsubscribe', { workspaceIdentity, subscriptionId: sub.subscriptionId })).unsubscribed, true);
    const unsubscribedAt = peer.lines.length;
    await sendDelta('must not arrive after unsubscribe'); await delay(500);
    assert.equal(peer.lines.slice(unsubscribedAt).filter(item => item.frame.method === 'conversation/frame' && item.frame.params.subscriptionId === sub.subscriptionId).length, 0);
    await peer.request('controller/unsubscribe', { workspaceIdentity, subscriptionId: controllerAck.subscriptionId });

    const workflowSession = await store.new('Z7 actorless workflow protocol fixture', workspaceIdentity);
    const beforeModelRequests = fixture.requests('ts', mainProvider).length;
    const source = "report({verified: true}); phase('review'); const answer = await hole('review', 'Approve?'); return {answer};";
    const created = await peer.request('workflow/create', { ...scope(String(workflowSession.id)), source, name: 'Z7 actorless no-replay check' });
    const workflowSubRequest = peer.start('workflow/subscribe', { ...scope(String(workflowSession.id)), runId: created.id, afterSeq: 0 });
    const workflowSub = await workflowSubRequest.promise;
    const workflowInitial = await peer.notification('workflow/frame', p => p.params.subscriptionId === workflowSub.subscriptionId);
    assert.equal(workflowInitial.frame.params.delivery, 'initial');
    assert.ok(orderOf(peer, frame => frame.id === workflowSubRequest.id) < workflowInitial.at, 'workflow ACK must precede initial frame');
    await peer.request('workflow/start', { ...scope(String(workflowSession.id)), runId: created.id, digest: created.digest, confirmed: true, allowReal: true });
    const awaiting = await waitUntil(() => peer.request('workflow/get', { ...scope(String(workflowSession.id)), runId: created.id }), value => value.status === 'awaiting_user', 'workflow manual hole');
    const hole = Object.values(awaiting.nodes).find(node => node.kind === 'hole' && node.status === 'awaiting_user');
    assert.ok(hole?.id, 'actorless workflow must reach its manual hole'); assert.equal(awaiting.reports.length, 1);
    await peer.request('workflow/resolve', { ...scope(String(workflowSession.id)), runId: created.id, nodeId: hole.id, answer: 'approved' });
    const resolved = await peer.request('workflow/get', { ...scope(String(workflowSession.id)), runId: created.id });
    await peer.request('workflow/resume', { ...scope(String(workflowSession.id)), runId: created.id, digest: resolved.digest, confirmed: true, allowReal: true });
    const completed = await waitUntil(() => peer.request('workflow/get', { ...scope(String(workflowSession.id)), runId: created.id }), value => value.status === 'completed', 'workflow completion');
    assert.deepEqual(completed.result, { answer: 'approved' }); assert.equal(completed.reports.length, 1, 'resume must not duplicate report events');
    const eventsPage = await peer.request('workflow/events', { ...scope(String(workflowSession.id)), runId: created.id, afterSeq: 0 });
    const sequences = eventsPage.events.map(event => event.seq);
    assert.equal(new Set(sequences).size, sequences.length, 'persisted workflow events must not replay duplicate sequence numbers');
    assert.equal(fixture.requests('ts', mainProvider).length, beforeModelRequests, 'actorless workflow must not issue a model request');
    await peer.request('workflow/unsubscribe', { workspaceIdentity, subscriptionId: workflowSub.subscriptionId });
    return { controllerAckBeforeFrame: true, conversationAckBeforeFrame: true, persistentDelta: true, flowPauseResume: true, resyncAckBeforeRecovery: true,
      unsubscribeStopsFrames: true, workflowAckBeforeFrame: true, workflowStatus: completed.status, reportsAfterResume: completed.reports.length,
      uniqueEventSequences: true, workflowModelRequests: 0 };
  });

  await scenario('media_composer_question_guidance_and_withdrawal', async () => {
    mediaSessionId = String((await store.new('Z7 media prepared durable send', workspaceIdentity)).id);
    const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lV8AAAAASUVORK5CYII=', 'base64');
    const declaration = { version: 1, uploadId: 'z7-' + randomBytes(8).toString('hex'), draftId: 'z7-draft', totalChunks: 1,
      checksum: 'sha256:' + sha256(image), chunkBytes: image.length, name: 'fixture.png', mimeType: 'image/png', size: image.length, origin: 'paste' };
    const begun = await peer.request('media/begin', { workspaceIdentity, sessionId: null, payload: declaration });
    const mediaId = begun.ref.id; assert.match(mediaId, /^[0-9a-f]{32}$/);
    assert.equal((await peer.request('media/status', { workspaceIdentity, sessionId: null, payload: { id: mediaId } })).status, 'pending');
    await peer.request('media/chunk', { workspaceIdentity, sessionId: null, payload: { id: mediaId, chunkIndex: 0, data: image.toString('base64') } });
    await peer.request('media/commit', { workspaceIdentity, sessionId: null, payload: { id: mediaId } });
    assert.equal((await peer.request('media/status', { workspaceIdentity, sessionId: null, payload: { id: mediaId } })).status, 'committed');
    const prepared = await peer.request('composer/prepare', { workspaceIdentity, sessionId: null, payload: {
      text: 'Inspect this local fixture image', provider_id: mainProvider, model,
      input: { attachmentRefs: [{ id: mediaId }] },
    } });
    assert.match(prepared.token, /^[0-9a-f]{32}$/);
    const sentId = commandId();
    const sent = await command(mediaSessionId, sentId, 'send', { text: 'Inspect this local fixture image', prepared_token: prepared.token });
    assert.equal(sent.status, 'accepted', JSON.stringify(sent));
    assert.equal((await queryCommand(mediaSessionId, sentId)).result.status, 'accepted');
    const mediaJournal = await store.load(mediaSessionId);
    assert.ok(mediaJournal.messages.some(message => message.role === 'user' && Array.isArray(message._media_refs) && message._media_refs.length === 1), 'durable send must transfer prepared media ownership into its journal');

    const question = await store.new('Z7 question mapping fixture', workspaceIdentity), questionText = 'Should the local proposal proceed?';
    question.status = 'awaiting_user'; question.pending_question = questionText;
    question.results = { 'z7-ask-user-call': { ok: true, awaiting_user: true, question: questionText } };
    question.messages.push(
      { role: 'assistant', content: '', tool_calls: [{ id: 'z7-ask-user-call', type: 'function', function: { name: 'ask_user', arguments: JSON.stringify({ question: questionText }) } }] },
      { role: 'tool', tool_call_id: 'z7-ask-user-call', content: '{}' },
    );
    await store.save(question); questionSessionId = String(question.id);
    const questionView = await peer.request('question/read', scope(questionSessionId));
    assert.equal(questionView.question.text, questionText);
    const answers = { questionId: questionView.question.id, answer: 'approved locally' };
    const answer = await peer.request('question/answer', { ...scope(questionSessionId), payload: answers });
    assert.equal(answer.accepted, true);
    const queried = await peer.request('question/query', { ...scope(questionSessionId), questionId: answers.questionId, payload: { answer: 'approved locally' } });
    assert.equal(queried.result, 'accepted');
    const guidance = await peer.request('guidance/read', scope(mediaSessionId));
    const withdrawals = await peer.request('withdrawal/list', scope(mediaSessionId));
    assert.ok(Array.isArray(guidance.pending_guidance) && Array.isArray(guidance.guidance_history));
    assert.ok(Array.isArray(withdrawals.withdrawals));
    return { mediaUpload: 'begin/chunk/commit/status', mediaPrepared: true, durableSendReceipt: sent.status, mediaPinnedToMessage: true,
      questionAnswer: answer.accepted, questionQuery: queried.result, guidanceRead: true, withdrawalList: true };
  });

  await scenario('fragment_reconstruction_and_scope_checks', async () => {
    const large = await store.load(durableSessionId);
    large.messages.push({ role: 'assistant', content: 'Z7_FRAGMENT_BODY_' + 'x'.repeat(900000) });
    await store.save(large);
    const declaration = await peer.request('conversation/snapshot', scope(durableSessionId));
    assert.equal(declaration.schema, 'xueness.remote-fragment.v1', 'large real snapshot should use the native fragment envelope');
    assert.ok(declaration.totalChunks > 1); assert.ok(declaration.sha256);
    const sameRoot = await store.new('Z7 fragment wrong session scope', workspaceIdentity);
    const firstParams = { workspaceIdentity, sessionId: durableSessionId, transferId: declaration.transferId, chunkIndex: 0 };
    const first = await peer.request('response/read', firstParams);
    assert.deepEqual(await peer.request('response/read', firstParams), first, 'a chunk must be safely readable more than once');
    await assertRpcRefusal(peer.request('response/read', { ...firstParams, sessionId: String(sameRoot.id) }), -32000, 'transfer must reject a different session');
    await assertRpcRefusal(peer.request('response/read', { ...firstParams, chunkIndex: declaration.totalChunks }), -32602, 'transfer must reject an invalid chunk index');
    const parts = [Buffer.from(first.data, 'base64')];
    for (let index = 1; index < declaration.totalChunks; index++) {
      const part = await peer.request('response/read', { ...firstParams, chunkIndex: index });
      assert.equal(part.chunkIndex, index); parts.push(Buffer.from(part.data, 'base64'));
    }
    const raw = Buffer.concat(parts);
    assert.equal(raw.length, declaration.byteLength); assert.equal(sha256(raw), declaration.sha256);
    const reconstructed = JSON.parse(raw.toString('utf8'));
    assert.equal(reconstructed.schema, 'xueness.conversation-transport.v1');
    assert.ok(JSON.stringify(reconstructed).includes('Z7_FRAGMENT_BODY_'));
    return { declaration: declaration.schema, chunks: declaration.totalChunks, hashVerified: true, sessionScopeRefused: true, invalidChunkRefused: true, repeatReadStable: true };
  });

  await scenario('headless_text_json_stream_resume_continue_root_and_permissions', async () => {
    const textRun = await runHeadless(['-p', 'Return the text fixture exactly.', '--root', workspaceIdentity, '--provider-id', mainProvider, '--mode', 'plan', '--output-format', 'text']);
    assert.equal(textRun.code, 0, textRun.stderr); assert.equal(textRun.stdout, 'Z7-HEADLESS-TEXT'); assertNoAnsi(textRun.stdout, 'text stdout');
    const newestTextSession = (await store.list()).map(row => row.id).filter(Boolean);
    let headlessSessionId = null;
    for (const id of newestTextSession) { const journal = await store.load(String(id)); if (journal.task === 'Return the text fixture exactly.') headlessSessionId = String(id); }
    assert.ok(headlessSessionId, 'text headless session is not in the native store');

    const jsonRun = await runHeadless(['--resume', headlessSessionId, '-p', 'Append one JSON turn.', '--root', workspaceIdentity, '--output-format', 'json']);
    assert.equal(jsonRun.code, 0, jsonRun.stderr); assertNoAnsi(jsonRun.stdout, 'json stdout');
    const resultPacket = JSON.parse(jsonRun.stdout);
    assert.deepEqual(Object.keys(resultPacket).sort(), ['completion', 'mode', 'pending', 'pending_question', 'result', 'schema', 'sessionId', 'status', 'steps', 'type', 'usage'].sort());
    assert.equal(resultPacket.schema, schema); assert.equal(resultPacket.type, 'result'); assert.equal(resultPacket.sessionId, headlessSessionId);
    assert.equal(resultPacket.result, 'Z7-HEADLESS-JSON');
    const afterJson = await store.load(headlessSessionId);
    assert.deepEqual(resultPacket.usage, afterJson.usage ?? afterJson.provider_usage ?? null, 'usage must be copied directly from the journal without another request');

    const streamRun = await runHeadless(['--resume', headlessSessionId, '-p', 'Append one streamed turn.', '--root', workspaceIdentity, '--output-format', 'stream-json', '--stream']);
    assert.equal(streamRun.code, 0, streamRun.stderr); assertNoAnsi(streamRun.stdout, 'stream-json stdout');
    const packets = streamRun.stdout.trimEnd().split('\n').map(line => JSON.parse(line));
    assert.equal(packets[0].type, 'init'); assert.equal(packets[0].schema, schema); assert.equal(packets[0].resumed, true);
    assert.ok(packets.slice(1, -1).every(packet => packet.type === 'event' && packet.event && typeof packet.event === 'object'));
    assert.equal(packets.at(-1).type, 'result'); assert.equal(packets.at(-1).result, 'Z7-HEADLESS-STREAM');

    const candidate = await store.new('Z7 continue under requested root', workspaceIdentity);
    candidate.mode = 'plan'; candidate.permission_mode = 'edit'; candidate.model_selection = { provider_id: mainProvider, model };
    candidate.usage = { fixtureExisting: true }; await store.save(candidate); continueSessionId = String(candidate.id);
    await delay(25);
    const foreign = await store.new('Z7 newer session in another root', otherIdentity);
    foreign.model_selection = { provider_id: mainProvider, model }; await store.save(foreign);
    const continued = await runHeadless(['--continue', '--root', workspaceIdentity, '--output-format', 'json']);
    assert.equal(continued.code, 0, continued.stderr); const continuePacket = JSON.parse(continued.stdout);
    assert.equal(continuePacket.sessionId, continueSessionId, 'continue must filter by canonical requested root before choosing latest');
    const continuedJournal = await store.load(continueSessionId);
    assert.equal(continuedJournal.mode, 'plan'); assert.equal(continuedJournal.permission_mode, 'edit');
    assert.equal(continuePacket.mode, 'plan'); assert.deepEqual(continuePacket.usage, continuedJournal.usage ?? continuedJournal.provider_usage ?? null);

    const beforeConflictRequests = fixture.requests('ts', mainProvider).length;
    const conflict = await runHeadless(['--resume', headlessSessionId, '--continue', '--root', workspaceIdentity]);
    assert.equal(conflict.code, 2); assert.equal(conflict.stdout, ''); assert.match(conflict.stderr, /互斥|mutually exclusive|--resume and --continue/i);
    assert.equal(fixture.requests('ts', mainProvider).length, beforeConflictRequests, 'parser conflicts must be rejected before model admission');
    assert.equal(fixture.requests('ts', mainProvider).length, 4, 'headless should make exactly one provider request per real run');
    return { textExact: true, jsonPacket: true, streamJsonNdjson: true, streamRuntimeEvents: packets.length > 2,
      resumeAppendedUserTurns: 2, continueSelectedRequestedRoot: true, foreignRootNotSelected: true,
      preservedMode: continuedJournal.mode, preservedPermissionMode: continuedJournal.permission_mode, yoloEscalation: false,
      parserConflictExitCode: conflict.code, providerRequests: fixture.requests('ts', mainProvider).length };
  });

  if (peer) {
    const status = await peer.finish(); peer = null;
    assert.equal(status.code, 0, `final app-server must exit after shutdown/EOF; stderr: ${status.error ?? ''}`);
    assert.deepEqual(status.signal, null);
  }
} catch (error) {
  failures.push({ name: 'setup_or_cleanup', error: String(error.stack ?? error) });
} finally {
  if (peer) {
    try { const status = await peer.finish(); if (status.code !== 0) failures.push({ name: 'app_server_cleanup', error: `exit ${status.code}, signal ${status.signal ?? 'none'}` }); }
    catch (error) { failures.push({ name: 'app_server_cleanup', error: String(error.stack ?? error) }); }
  }
  await fixture.close();
  if (resolve(dirname(scratch)) !== resolve(tmpdir()) || !basename(scratch).startsWith('xueness-verify-z7-')) throw new Error('unexpected scratch cleanup path');
  rmSync(scratch, { recursive: true, force: true });
}

const output = { ok: failures.length === 0, mode: built ? 'built' : 'source', network: '127.0.0.1-only', scenarios: checks, failures,
  modelRequests: { appServerRun: fixture.requests('ts', hangProvider).length, headless: fixture.requests('ts', mainProvider).length,
    total: fixture.requests('ts', hangProvider).length + fixture.requests('ts', mainProvider).length } };
const serialized = JSON.stringify(output, null, 2) + '\n';
const log = join(root, '验收资料', '验证记录', built ? 'z7-runtime-built-windows.json' : 'z7-runtime-source-windows.json');
mkdirSync(dirname(log), { recursive: true }); writeFileSync(log, serialized, 'utf8');
process.stdout.write(serialized);
if (failures.length) process.exitCode = 1;
