const test = require('node:test');
const assert = require('node:assert/strict');
const { resolve } = require('node:path');
const { installProjectExplorer } = require('../src/project-explorer.cjs');

function fixture(overrides = {}) {
  const root = resolve('workspace'), opened = [], requests = [];
  const origin = 'http://127.0.0.1:12345', mainFrame = { url: origin + '/' };
  const webContents = { mainFrame }, window = { isDestroyed: () => false, webContents };
  let handler;
  installProjectExplorer({ ipcMain: { handle: (_name, callback) => handler = callback }, getWindow: () => window,
    getBackend: () => ({ origin, token: 'fixture' }), shell: { openPath: async path => { opened.push(path); return ''; } },
    statImpl: async () => ({ isDirectory: () => true }),
    fetchImpl: async url => { requests.push(url); return { ok: true, json: async () => url.endsWith('/api/plugins')
      ? { plugins: ['desktop', 'files', 'sessions'].map(id => ({ id, effective: id !== overrides.disabled })) }
      : { picker: { path: overrides.path ?? root } } }; }, ...overrides });
  return { root, opened, requests, handler, event: { sender: webContents, senderFrame: mainFrame } };
}

test('opens the validated workspace directory through the system shell', async () => {
  const f = fixture(); assert.deepEqual(await f.handler(f.event, f.root), { ok: true });
  assert.deepEqual(f.opened, [f.root]); assert.equal(f.requests.length, 2);
});
test('disabled plugin stops before workspace access or native open', async () => {
  const f = fixture({ disabled: 'desktop' }); assert.equal((await f.handler(f.event, f.root)).ok, false);
  assert.equal(f.requests.length, 1); assert.deepEqual(f.opened, []);
});
test('unowned frame and unvalidated directory cannot open a path', async () => {
  const f = fixture({ path: resolve('different') });
  assert.equal((await f.handler({ ...f.event, senderFrame: { url: 'https://example.com' } }, f.root)).ok, false);
  assert.equal(f.requests.length, 0);
  assert.equal((await f.handler(f.event, f.root)).ok, false); assert.deepEqual(f.opened, []);
});
test('a file or shell error is reported as a failed operation', async () => {
  const file = fixture({ statImpl: async () => ({ isDirectory: () => false }) });
  assert.equal((await file.handler(file.event, file.root)).ok, false); assert.deepEqual(file.opened, []);
  const failed = fixture({ shell: { openPath: async () => 'not available' } });
  assert.equal((await failed.handler(failed.event, failed.root)).ok, false);
});
