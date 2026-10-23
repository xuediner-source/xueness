/** Z7 app-server shutdown lifecycle acceptance: only loopback providers. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { ScriptedServer } from '../ts/packages/providers/test/support/scripted-server.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const built = process.argv.includes('--built');
const runtimeRoot = join(root, 'ts', ...(built ? ['dist'] : []));
const ext = built ? 'js' : 'ts';
const entry = join(runtimeRoot, 'apps/server/src/cli/main.' + ext);
const schema = 'xueness.z7-shutdown.v1';
const scratch = mkdtempSync(join(tmpdir(), 'xueness-verify-z7-shutdown-'));
const fixture = await ScriptedServer.start();
const providerId = 'z7-shutdown-hang', model = 'z7-shutdown-fixture-model';
fixture.script(providerId, [[{ hang: true }]]);

function makeState(name) {
  const workspace = join(scratch, name, 'workspace');
  const state = join(scratch, name, 'state');
  mkdirSync(workspace, { recursive: true }); mkdirSync(state, { recursive: true });
  const workspaceIdentity = realpathSync(workspace);
  writeFileSync(join(state, 'settings.json'), JSON.stringify({
    workspace: { selectedRoots: [workspaceIdentity], defaultRoot: workspaceIdentity },
    general: { sessionsAutoTitleEnabled: false, sessionsCancelPropagateEnabled: true },
  }));
  writeFileSync(join(state, 'plugin-state.json'), JSON.stringify({ apiVersion: 1, enabled: { remote: true } }));
  const providers = join(state, 'providers'); mkdirSync(providers, { recursive: true });
  writeFileSync(join(providers, providerId + '.json'), JSON.stringify({
    id: providerId, name: 'Z7 shutdown loopback fixture', baseUrl: fixture.base('ts', providerId), model,
    apiKey: 'fixture-only-key', allowLoopbackHttp: true,
  }));
  return { workspaceIdentity, state, pluginState: join(state, 'plugin-state.json') };
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  })]).finally(() => clearTimeout(timer));
}

class AppServerChild {
  constructor(state) {
    this.child = spawn(process.execPath, [entry, '--state', state, 'app-server', '--workspace-root', activeWorkspace, '--allow-real-provider'], {
      cwd: root, env: { ...process.env, XUENESS_ALLOW_REAL: '1' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    this.frames = []; this.parseFailures = []; this.pending = new Map(); this.nextId = 1;
    this.stdout = ''; this.stderr = '';
    this.exit = new Promise(resolveExit => { this.resolveExit = resolveExit; });
    this.child.stdout.setEncoding('utf8'); this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', value => this.#read(value)); this.child.stderr.on('data', value => { this.stderr += value; });
    this.child.once('error', error => { this.spawnError = error; this.resolveExit({ code: null, signal: null, error }); });
    this.child.once('close', (code, signal) => {
      this.resolveExit({ code, signal });
      for (const [id, pending] of this.pending) pending.reject(new Error(`child closed before response ${id}`));
      this.pending.clear();
    });
  }
  #read(value) {
    this.stdout += value;
    for (;;) {
      const end = this.stdout.indexOf('\n'); if (end < 0) return;
      const line = this.stdout.slice(0, end).replace(/\r$/, ''); this.stdout = this.stdout.slice(end + 1);
      if (!line) { this.parseFailures.push('empty stdout line'); continue; }
      let frame;
      try { frame = JSON.parse(line); } catch { this.parseFailures.push(line.slice(0, 240)); continue; }
      this.frames.push(frame);
      if (Object.hasOwn(frame, 'id') && this.pending.has(frame.id)) {
        const pending = this.pending.get(frame.id); this.pending.delete(frame.id);
        if (frame.error) pending.reject(Object.assign(new Error(frame.error.message), { frame })); else pending.resolve(frame.result);
      }
    }
  }
  request(method, params = {}) {
    const id = this.nextId++;
    let resolveReply, rejectReply;
    const promise = new Promise((resolveValue, rejectValue) => { resolveReply = resolveValue; rejectReply = rejectValue; });
    this.pending.set(id, { resolve: resolveReply, reject: rejectReply });
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return promise;
  }
  async waitExit(timeoutMs = 15000) { return withTimeout(this.exit, timeoutMs, 'app-server exit'); }
  async cleanup() {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return { forced: false, status: await this.exit };
    this.child.stdin.end();
    try { return { forced: false, status: await withTimeout(this.exit, 5000, 'app-server cleanup after EOF') }; }
    catch {
      this.child.kill('SIGTERM');
      try { return { forced: true, status: await withTimeout(this.exit, 3000, 'app-server cleanup after SIGTERM') }; }
      catch { this.child.kill('SIGKILL'); return { forced: true, status: await withTimeout(this.exit, 3000, 'app-server cleanup after SIGKILL') }; }
    }
  }
  result() {
    return { stdout: this.stdout, stderr: this.stderr, frames: this.frames, parseFailures: this.parseFailures,
      exitCode: this.child.exitCode, signal: this.child.signalCode };
  }
}

let activeWorkspace = '';
const checks = [], failures = [], cleanup = [];
let first = null, second = null;
const fixtureCount = () => fixture.requests('ts', providerId).length;
const commandId = () => `c_${String(Date.now()).padStart(13, '0')}_${randomBytes(16).toString('hex')}`;

async function waitForProvider(expected) {
  const started = Date.now();
  while (Date.now() - started < 20000) {
    if (fixtureCount() >= expected) return Date.now() - started;
    await delay(50);
  }
  throw new Error(`expected provider request #${expected}; observed ${fixtureCount()}`);
}

async function beginDurableRun(peer, workspaceIdentity) {
  const hello = await withTimeout(peer.request('initialize', { protocolVersion: 1 }), 20000, 'initialize');
  assert.equal(hello.protocolName, 'xueness.app-server.v1');
  const createId = commandId();
  const created = await peer.request('command/execute', { workspaceIdentity, commandId: createId, type: 'create_session', payload: {
    task: 'Z7 shutdown lifecycle fixture', provider_id: providerId, model,
  } });
  assert.equal(created.status, 'accepted', JSON.stringify(created));
  const sessionId = created.result.id;
  const send = await peer.request('command/execute', { workspaceIdentity, sessionId, commandId: commandId(), type: 'send', payload: { text: 'Wait for the loopback provider until app-server shutdown.' } });
  assert.equal(send.status, 'accepted', JSON.stringify(send));
  const runId = commandId();
  const runRpcId = peer.nextId;
  const runPromise = peer.request('command/execute', { workspaceIdentity, sessionId, commandId: runId, type: 'run', payload: {} });
  runPromise.catch(() => {}); // EOF/watchdog may close the in-flight JSON-RPC request after draining it.
  const elapsedToModel = await waitForProvider(fixtureCount() + 1);
  return { sessionId, runId, runRpcId, runPromise, elapsedToModel };
}

async function recordScenario(name, body) {
  try { checks.push({ name, ok: true, ...(await body()) }); }
  catch (error) { failures.push({ name, error: String(error.stack ?? error) }); checks.push({ name, ok: false }); }
}

try {
  await recordScenario('stdin_eof_cancels_and_drains_active_durable_run', async () => {
    const env = makeState('eof'); activeWorkspace = env.workspaceIdentity; first = new AppServerChild(env.state);
    const run = await beginDurableRun(first, env.workspaceIdentity);
    first.child.stdin.end();
    const exited = await first.waitExit(15000);
    assert.equal(exited.code, 0, `EOF should drain and exit normally; stderr=${first.stderr.slice(-4000)}`);
    assert.equal(exited.signal, null);
    assert.equal(fixtureCount(), 1, 'EOF should not retry the provider request');
    assert.deepEqual(first.parseFailures, [], `stdout must contain only JSON-RPC frames: ${first.parseFailures.join('; ')}`);

    const firstProcess = first.result();
    first = null;
    const restart = new AppServerChild(env.state); first = restart;
    const hello = await withTimeout(restart.request('initialize', { protocolVersion: 1 }), 20000, 'restart initialize');
    assert.equal(hello.protocolName, 'xueness.app-server.v1');
    const query = await restart.request('command/query', { workspaceIdentity: env.workspaceIdentity, sessionId: run.sessionId, commandId: run.runId });
    const durable = query.result;
    assert.ok(durable === 'unknown' || ['accepted', 'failed'].includes(durable?.status), `unexpected persisted run receipt: ${JSON.stringify(durable)}`);
    assert.equal(fixtureCount(), 1, 'restart query must not replay the active run');
    const stop = await restart.request('shutdown'); assert.equal(stop.ok, true);
    restart.child.stdin.end();
    const restartExit = await restart.waitExit(10000); assert.equal(restartExit.code, 0);
    assert.deepEqual(restart.parseFailures, []);
    first = null;
    return { modelRequests: fixtureCount(), stdinEndedDuringRun: true, exitedNormally: true,
      runResponseDuringDrain: firstProcess.frames.some(frame => frame.id === run.runRpcId), restartQuery: durable,
      automaticReplayRequests: 0, childStdout: firstProcess.stdout, childStderr: firstProcess.stderr,
      childStdoutFrames: firstProcess.frames, restartStdout: restart.stdout, restartStdoutFrames: restart.frames,
      restartStderr: restart.stderr };
  });

  await recordScenario('plugin_disable_watchdog_drains_without_more_stdin', async () => {
    const env = makeState('plugin-disable'); activeWorkspace = env.workspaceIdentity; second = new AppServerChild(env.state);
    const before = fixtureCount();
    const run = await beginDurableRun(second, env.workspaceIdentity);
    writeFileSync(env.pluginState, JSON.stringify({ apiVersion: 1, enabled: { remote: false } }));
    const disabledAt = Date.now();
    const exited = await second.waitExit(12000);
    const shutdownMs = Date.now() - disabledAt;
    assert.equal(exited.code, 0, `watchdog should drain and exit normally; stderr=${second.stderr.slice(-4000)}`);
    assert.equal(exited.signal, null);
    assert.ok(shutdownMs < 8000, `watchdog shutdown took ${shutdownMs}ms`);
    assert.equal(fixtureCount() - before, 1, 'plugin-disable shutdown must not retry the model request');
    assert.deepEqual(second.parseFailures, [], `stdout must contain only JSON-RPC frames: ${second.parseFailures.join('; ')}`);
    return { modelRequests: fixtureCount() - before, watchdogShutdownMs: shutdownMs,
      noAdditionalStdinMessages: true, exitedNormally: true,
      runResponseDuringDrain: second.frames.some(frame => frame.method === undefined && frame.id === run.runRpcId),
      childStdout: second.stdout, childStdoutFrames: second.frames, childStderr: second.stderr };
  });
} catch (error) {
  failures.push({ name: 'setup', error: String(error.stack ?? error) });
} finally {
  for (const [name, child] of [['eof', first], ['plugin-disable', second]]) if (child) {
    const settled = await child.cleanup(); cleanup.push({ name, forcedForFailureCleanup: settled.forced, exitCode: settled.status.code, signal: settled.status.signal });
    if (settled.forced) failures.push({ name: `${name}_forced_cleanup`, error: 'child failed to exit through its expected lifecycle path' });
  }
  await fixture.close();
  if (resolve(dirname(scratch)) !== resolve(tmpdir())) throw new Error('unexpected scratch cleanup parent');
  rmSync(scratch, { recursive: true, force: true });
}

const output = { schema, ok: failures.length === 0, mode: built ? 'built' : 'source', network: '127.0.0.1-only',
  scenarios: checks, cleanup, failures, modelRequests: fixtureCount() };
const log = join(root, '验收资料', '验证记录', `z7-shutdown-${built ? 'built' : 'source'}-windows.json`);
mkdirSync(dirname(log), { recursive: true });
writeFileSync(log, JSON.stringify(output, null, 2) + '\n', 'utf8');
process.stdout.write(JSON.stringify(output, null, 2) + '\n');
if (failures.length) process.exitCode = 1;
