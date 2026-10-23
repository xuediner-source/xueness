const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { Backend } = require('../src/backend.cjs');
const { frontDoorCommand } = require('../src/front-door.cjs');

const root = resolve(__dirname, '../..');
const nodeOk = Number(process.versions.node.split('.')[0]) >= 24;

function processGroupExists(pid) {
  try { process.kill(-pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; if (error.code === 'EPERM') return true; throw error; }
}

test('the desktop backend is the TypeScript host, compiled JS when packaged', () => {
  const base = { root, assets: '/assets' };
  const packaged = frontDoorCommand({ env: {}, packaged: true, resourcesPath: '/resources', ...base });
  assert.equal(packaged.executable, join('/resources/backend-ts/runtime', process.platform === 'win32' ? 'node.exe' : 'node'));
  assert.deepEqual(packaged.args, [join('/resources/backend-ts/apps/server/src/desktop-host.js'), '--assets', '/assets', '--project-root', '/resources']);
  const source = frontDoorCommand({ env: { XUENESS_FRONT_DOOR_NODE: '/opt/node' }, packaged: false, ...base });
  assert.equal(source.executable, '/opt/node');
  assert.deepEqual(source.args, [join(root, 'ts/apps/server/src/desktop-host.ts'), '--assets', '/assets', '--project-root', root]);
  assert.throws(() => frontDoorCommand({ env: {}, packaged: true, ...base }), /resources directory/);
});

test('the desktop backend answers on its own loopback origin', {
  skip: !nodeOk ? 'needs Node 24+' : false, timeout: 60000,
}, async () => {
  const data = mkdtempSync(join(tmpdir(), 'xueness-desktop-front-door-'));
  const assets = join(root, 'webapp', 'dist');
  const command = frontDoorCommand({ env: { XUENESS_FRONT_DOOR_NODE: process.execPath }, packaged: false, root, assets });
  const backend = new Backend({ ...command, cwd: root, data, assets, node: process.execPath, playwright: '' });
  try {
    const origin = await backend.start();
    assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    const headers = { 'X-Xueness-Desktop-Token': backend.token };
    const status = await (await fetch(`${origin}/api/front-door/status`, { headers })).json();
    assert.equal(status.service, 'xueness-front-door');
    assert.equal(status.backend.kind, 'ts');
    assert.equal(status.backend.mode, 'desktop');
    const desktop = await fetch(`${origin}/api/desktop/status`, { headers });
    assert.equal(desktop.status, 200);
    assert.equal((await desktop.json()).desktop, true);
    for (const path of ['/', '/api/health']) {
      const refused = await fetch(`${origin}${path}`);
      assert.equal(refused.status, 403, path);
      assert.equal((await refused.json()).code, 'desktop_auth_required');
    }
  } finally {
    await backend.stop();
    rmSync(data, { recursive: true, force: true });
  }
  assert.ok(backend.child.exitCode !== null || backend.child.signalCode !== null);
  if (process.platform !== 'win32') assert.equal(processGroupExists(backend.child.pid), false);
});
