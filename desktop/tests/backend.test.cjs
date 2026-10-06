const test = require('node:test');
const assert = require('node:assert/strict');
const { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { Backend } = require('../src/backend.cjs');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitForFile(path, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return readFileSync(path, 'utf8').trim();
    await delay(20);
  }
  throw new Error(`timed out waiting for ${path}`);
}

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(20);
  }
  throw new Error('timed out waiting for condition');
}

function processExists(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; if (error.code === 'EPERM') return true; throw error; }
}

function fixtures(root, mode, markerDelayMs) {
  const workerPath = join(root, 'workflow-worker.cjs');
  const commandPath = join(root, 'term-resistant-command.cjs');
  const pidPath = join(root, 'command.pid');
  const markerPath = join(root, 'late-write');
  const backendPath = join(root, 'backend-host.cjs');

  writeFileSync(commandPath, `
    const fs = require('node:fs');
    process.on('SIGTERM', () => {});
    setTimeout(() => fs.writeFileSync(process.argv[2], 'late'), ${markerDelayMs});
  `);
  writeFileSync(workerPath, `
    const { spawn } = require('node:child_process');
    const { createInterface } = require('node:readline');
    const pidPath = ${JSON.stringify(pidPath)};
    const markerPath = ${JSON.stringify(markerPath)};
    const commandPath = ${JSON.stringify(commandPath)};
    const ownerPid = Number(process.argv[2]);
    const command = spawn(process.execPath, [commandPath, markerPath], {
      detached: true, stdio: 'ignore'
    });
    require('node:fs').writeFileSync(pidPath, String(command.pid));
    let cancelling = false;
    async function cancel() {
      if (cancelling) return;
      cancelling = true;
      try { process.kill(-command.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      let exited = command.exitCode !== null || command.signalCode !== null;
      const commandExited = new Promise(resolve => command.once('exit', () => { exited = true; resolve(); }));
      await Promise.race([commandExited, new Promise(resolve => setTimeout(resolve, 2000))]);
      if (!exited) {
        try { process.kill(-command.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
        await commandExited;
      }
      process.exit(0);
    }
    createInterface({ input: process.stdin }).on('line', line => { if (line === 'cancel') void cancel(); });
    setInterval(() => {
      try { process.kill(ownerPid, 0); }
      catch (error) { if (error.code === 'ESRCH') void cancel(); }
    }, 25);
  `);
  writeFileSync(backendPath, `
    const { spawn } = require('node:child_process');
    const { createInterface } = require('node:readline');
    const worker = spawn(process.execPath, [${JSON.stringify(workerPath)}, String(process.pid)], {
      stdio: ['pipe', 'ignore', 'ignore']
    });
    process.stdout.write(JSON.stringify({ type: 'ready', url: 'http://127.0.0.1:4567' }) + '\\n');
    createInterface({ input: process.stdin }).on('line', line => {
      if (line.includes('shutdown')) {
        ${mode === 'normal' ? "worker.stdin.write('cancel\\n'); setTimeout(() => process.exit(0), 2000);" : ''}
      }
    });
  `);

  return { backendPath, pidPath, markerPath, root };
}

async function stopFixture(t, mode, markerDelayMs, postStopWaitMs) {
  const root = mkdtempSync(join(tmpdir(), 'xueness-desktop-tree-'));
  const fixture = fixtures(root, mode, markerDelayMs);
  let commandPid;
  const backend = new Backend({ executable: process.execPath, args: [fixture.backendPath], cwd: root,
    data: root, assets: root, node: process.execPath, playwright: '' });
  t.after(async () => {
    if (Number.isInteger(commandPid)) {
      try { process.kill(-commandPid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    if (backend.child && backend.child.exitCode === null && backend.child.signalCode === null) await backend.stop();
    rmSync(root, { recursive: true, force: true });
  });

  await backend.start();
  commandPid = Number(await waitForFile(fixture.pidPath));
  assert.ok(Number.isInteger(commandPid) && commandPid > 0);
  await backend.stop();
  await delay(postStopWaitMs);
  assert.equal(existsSync(fixture.markerPath), false, 'a command survived host shutdown and wrote later');
  assert.equal(processExists(commandPid), false, 'the TERM-resistant command process survived host shutdown');
}

test('POSIX normal shutdown drains the workflow worker before reclaiming its process group', {
  skip: process.platform === 'win32',
}, async t => {
  await stopFixture(t, 'normal', 3200, 1400);
});

test('POSIX forced host exit leaves the workflow worker alive to kill its command group', {
  skip: process.platform === 'win32',
}, async t => {
  await stopFixture(t, 'forced', 5500, 700);
});

test('private pipe accepts only well-formed update policy and fixed update request shapes before ready', async t => {
  const root = mkdtempSync(join(tmpdir(), 'xueness-desktop-update-pipe-'));
  const hostPath = join(root, 'host.cjs');
  const replyPath = join(root, 'reply.json');
  const requestId = '0123456789abcdef0123456789abcdef';
  writeFileSync(hostPath, `
    const fs = require('node:fs');
    const { createInterface } = require('node:readline');
    const requestId = ${JSON.stringify(requestId)};
    const replyPath = ${JSON.stringify(replyPath)};
    const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
    send({ type: 'update-policy', enabled: true, autoDownload: false });
    send({ type: 'update-policy', enabled: true, autoDownload: 'false' });
    send({ type: 'update-policy', enabled: true, autoDownload: false, url: 'https://example.invalid' });
    send({ type: 'update', id: 'bad', action: 'status' });
    send({ type: 'update', id: requestId, action: 'status', url: 'https://example.invalid' });
    send({ type: 'update', id: requestId, action: 'download' });
    send({ type: 'update', id: requestId, action: 'install', version: '1.2.3-beta' });
    send({ type: 'update', id: requestId, action: 'status' });
    send({ type: 'ready', url: 'http://127.0.0.1:4567' });
    createInterface({ input: process.stdin }).on('line', line => {
      let value; try { value = JSON.parse(line); } catch { return; }
      if (value.id === requestId) fs.writeFileSync(replyPath, JSON.stringify(value));
      if (value.type === 'shutdown') process.exit(0);
    });
  `);
  const backend = new Backend({ executable: process.execPath, args: [hostPath], cwd: root,
    data: root, assets: root, node: process.execPath, playwright: '' });
  const policies = [];
  const requests = [];
  backend.on('update-policy', message => policies.push(message));
  backend.on('update', message => requests.push(message));
  t.after(async () => {
    if (backend.child && backend.child.exitCode === null && backend.child.signalCode === null) await backend.stop();
    rmSync(root, { recursive: true, force: true });
  });

  await backend.start();
  await waitFor(() => requests.length === 1);
  assert.deepEqual(policies, [{ enabled: true, autoDownload: false }]);
  assert.deepEqual(requests, [{ type: 'update', id: requestId, action: 'status' }]);
  backend.reply({ id: requestId, state: { phase: 'current' } });
  const reply = JSON.parse(await waitForFile(replyPath));
  assert.deepEqual(reply, { id: requestId, state: { phase: 'current' } });
  await backend.stop();
});

test('private pipe accepts only exact desktop permission messages', async t => {
  const root = mkdtempSync(join(tmpdir(), 'xueness-desktop-permission-pipe-'));
  const hostPath = join(root, 'host.cjs');
  const requestId = 'fedcba9876543210fedcba9876543210';
  writeFileSync(hostPath, `
    const { createInterface } = require('node:readline');
    const requestId = ${JSON.stringify(requestId)};
    const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
    send({ type: 'permissions', id: requestId, action: 'status' });
    send({ type: 'permissions', id: requestId, action: 'status', permission: 'screen' });
    send({ type: 'permissions', id: requestId, action: 'request', permission: 'camera' });
    send({ type: 'permissions', id: requestId, action: 'request', permission: 'screen', extra: true });
    send({ type: 'permissions', id: requestId, action: 'request', permission: 'screen' });
    send({ type: 'ready', url: 'http://127.0.0.1:4567' });
    createInterface({ input: process.stdin }).on('line', line => {
      let value; try { value = JSON.parse(line); } catch { return; }
      if (value.type === 'shutdown') process.exit(0);
    });
  `);
  const backend = new Backend({ executable: process.execPath, args: [hostPath], cwd: root,
    data: root, assets: root, node: process.execPath, playwright: '' });
  const requests = [];
  backend.on('permissions', value => requests.push(value));
  t.after(async () => {
    if (backend.child && backend.child.exitCode === null && backend.child.signalCode === null) await backend.stop();
    rmSync(root, { recursive: true, force: true });
  });

  await backend.start();
  await waitFor(() => requests.length === 2);
  assert.deepEqual(requests, [
    { type: 'permissions', id: requestId, action: 'status' },
    { type: 'permissions', id: requestId, action: 'request', permission: 'screen' },
  ]);
  await backend.stop();
});
