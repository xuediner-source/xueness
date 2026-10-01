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
