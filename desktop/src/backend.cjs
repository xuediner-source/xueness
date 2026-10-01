const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { createInterface } = require('node:readline');
const { EventEmitter } = require('node:events');
const { readyOrigin } = require('./security.cjs');

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
    const ended = new Promise(resolve => child.once('exit', resolve));
    if (child.exitCode === null && child.signalCode === null) {
      this.reply({ type: 'shutdown' });
      await Promise.race([ended, new Promise(resolve => setTimeout(resolve, 3000))]);
    }
    if (process.platform === 'win32') {
      if (child.exitCode === null && child.signalCode === null) {
        await new Promise(resolve => {
          const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          killer.once('exit', resolve); killer.once('error', resolve);
        });
      }
    } else {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
  }
}
module.exports = { Backend };
