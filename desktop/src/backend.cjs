const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { createInterface } = require('node:readline');
const { EventEmitter } = require('node:events');
const { readyOrigin } = require('./security.cjs');

const POSIX_GROUP_DRAIN_MS = 3000;

function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      resolve(value);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once('exit', onExit);
  });
}

function processGroupExists(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw error;
  }
}

async function waitForProcessGroupExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (processGroupExists(pid)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await new Promise(resolve => setTimeout(resolve, Math.min(25, remaining)));
  }
  return true;
}

function killProcessGroup(pid) {
  try { process.kill(-pid, 'SIGKILL'); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}

class Backend extends EventEmitter {
  constructor({ executable, args, cwd, data, assets, node, playwright }) {
    super(); this.config = { executable, args, cwd, data, assets, node, playwright };
    this.token = randomBytes(32).toString('hex'); this.stopping = false;
  }
  start() {
    const { executable, args, cwd, data, assets, node, playwright } = this.config;
    this.child = spawn(executable, [...args, '--data', data, '--assets', assets], {
      cwd, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true,
      env: { ...process.env, XUENESS_DESKTOP_TOKEN: this.token, XUENESS_DESKTOP_HOST: '1', PYTHONUNBUFFERED: '1',
        XUENESS_DESKTOP_NODE: node, XUENESS_DESKTOP_PLAYWRIGHT: playwright },
    });
    this.child.stdin.on('error', () => {});
    this.child.stderr.on('data', () => {}); // Request/model output never enters desktop logs.
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = () => {
        if (!settled) { settled = true; clearTimeout(timer); reject(new Error('Xueness backend did not start')); }
        else if (!this.stopping) this.emit('failure');
      };
      const timer = setTimeout(() => { fail(); void this.stop(); }, 45000);
      this.child.once('error', fail); this.child.once('exit', fail);
      const lines = createInterface({ input: this.child.stdout });
      lines.on('line', line => {
        if (line.length > 65536) return;
        let message; try { message = JSON.parse(line); } catch { return; }
        if (message.type === 'ready' && !settled) {
          try {
            this.origin = readyOrigin(message.url); settled = true; clearTimeout(timer); resolve(this.origin);
          } catch { fail(); }
        } else if (message.type === 'dialog' && typeof message.id === 'string' && /^[a-f0-9]{32}$/.test(message.id)) {
          this.emit('dialog', message);
        }
      });
    });
  }
  reply(message) {
    if (this.child?.stdin.writable) this.child.stdin.write(JSON.stringify(message)+'\n');
  }
  async stop() {
    if (this.stopping) return; this.stopping = true;
    const child = this.child; if (!child) return;
    if (child.exitCode === null && child.signalCode === null) {
      this.reply({ type: 'shutdown' });
      await waitForChildExit(child, 3000);
    }
    if (process.platform === 'win32') {
      if (child.exitCode === null && child.signalCode === null) {
        if (Number.isInteger(child.pid)) {
          await new Promise(resolve => {
            const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
            killer.once('exit', resolve); killer.once('error', resolve);
          });
        }
      }
    } else {
      if (Number.isInteger(child.pid)) {
        let childExited = child.exitCode !== null || child.signalCode !== null;
        if (!childExited) {
          // Kill only the backend first. POSIX workflow supervisors share its
          // group and use parent loss to terminate command groups they own.
          try { process.kill(child.pid, 'SIGKILL'); }
          catch (error) { if (error.code !== 'ESRCH') throw error; }
          await waitForChildExit(child, 1000);
          childExited = child.exitCode !== null || child.signalCode !== null;
        }
        // Desktop workflow launchers share the backend process group, while
        // each command runs in its own group. After a graceful host exit the
        // launchers need a short window to observe owner loss and SIGKILL any
        // TERM-resistant command groups before their shared group is reaped.
        if (!childExited || !await waitForProcessGroupExit(child.pid, POSIX_GROUP_DRAIN_MS)) {
          killProcessGroup(child.pid);
        }
      }
    }
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
  }
}
module.exports = { Backend };
