const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');
const { createTrayMenuHost, normalizeTraySessions, normalizeTrayState, trayPopupBounds, FEEDBACK_URL } = require('../src/tray-menu.cjs');
const id = char => char.repeat(32);
const session = (char, extra = {}) => ({ id: id(char), title: `Chat ${char}`, root: 'E:\\models', status: 'completed', updatedAt: '2026-10-02T08:00:00Z', ...extra });
const state = extra => ({ busy: false, sessionsEnabled: true, locale: 'zh', dark: false, activeId: id('a'), ...extra });

function fixture({ fetchImpl, load } = {}) {
  const ipcMain = new EventEmitter(), popups = [], sent = [], commands = [], external = [], requests = [];
  let enabled = true, shown = 0, quit = 0;
  const backend = { origin: 'http://127.0.0.1:45678', token: 'test-only-token' };
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.webContents = new EventEmitter(); this.webContents.mainFrame = { url: backend.origin + '/api/desktop/tray' };
      this.webContents.send = (channel, snapshot) => sent.push({ channel, snapshot });
      this.webContents.setWindowOpenHandler = callback => { this.openHandler = callback; }; popups.push(this);
    }
    isDestroyed() { return Boolean(this.destroyed); }
    async loadURL(url) { this.url = url; if (load) await load(); }
    setBounds(value) { this.bounds = value; }
    show() { this.visible = true; }
    focus() { this.focused = true; }
    hide() { this.visible = false; }
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  const mainWindow = { isDestroyed: () => false, webContents: { send: (channel, action) => commands.push({ channel, action }) } };
  const host = createTrayMenuHost({ app: { quit: () => quit++ }, BrowserWindow, ipcMain, mainWindow, getBackend: () => backend,
    screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }) },
    shell: { openExternal: async url => { external.push(url); } }, isEnabled: () => enabled, showMain: () => shown++,
    fetchImpl: async (url, options) => { requests.push({ url, options }); return fetchImpl ? fetchImpl(url, options) : { ok: true, json: async () => ({ sessions: [session('a'), session('b')] }) }; } });
  host.setState(state());
  const open = () => host.open({ x: 1600, y: 1040, width: 20, height: 20 });
  const event = () => ({ sender: popups[0].webContents, senderFrame: popups[0].webContents.mainFrame });
  const command = action => ipcMain.emit('xueness:tray-command', event(), action);
  return { host, open, event, command, ipcMain, popups, sent, commands, requests, external, backend, mainWindow,
    disable: () => { enabled = false; }, shown: () => shown, quit: () => quit };
}

test('session metadata is bounded, sorted, sanitized and carries a basename only', () => {
  const result = normalizeTraySessions([session('a', { title: 'A\nB', root: 'E:\\models\\', updatedAt: '2020-01-01' }),
    session('b', { task: 'Fallback', title: '', root: '/home/user/project', pinned: true }), session('a'), { id: '../escape' }, null]);
  assert.deepEqual(result.map(row => row.id), [id('b'), id('a')]);
  assert.equal(result[0].title, 'Fallback'); assert.equal(result[0].project, 'project');
  assert.equal(result[1].title, 'A B'); assert.equal(result[1].project, 'models');
  assert.equal('root' in result[1], false);
  const many = Array.from({ length: 120 }, (_, n) => ({ ...session('a'), id: n.toString(16).padStart(32, '0') }));
  assert.equal(normalizeTraySessions(many).length, 100);
  assert.equal(normalizeTrayState(state({ busy: 'false' })), null);
  assert.equal(normalizeTrayState(state({ activeId: '../file' })), null);
  assert.deepEqual(normalizeTrayState({ ...state(), arbitrary: 'discard' }), state());
});

test('popup placement respects negative coordinates, screen edges and available work area', () => {
  for (const [anchor, area] of [
    [{ x: 1800, y: 1040, width: 20, height: 20 }, { x: 0, y: 0, width: 1920, height: 1040 }],
    [{ x: -1800, y: 0, width: 20, height: 20 }, { x: -1920, y: 0, width: 1920, height: 1040 }],
    [{ x: 0, y: 0, width: 20, height: 20 }, { x: 0, y: 0, width: 300, height: 240 }],
  ]) {
    const bounds = trayPopupBounds(anchor, area, 1900);
    assert.ok(bounds.x >= area.x && bounds.y >= area.y);
    assert.ok(bounds.x + bounds.width <= area.x + area.width && bounds.y + bounds.height <= area.y + area.height);
  }
});

test('owned menu fetches authenticated sessions and permits only catalog IDs and fixed commands', async () => {
  const f = fixture(); await f.open(); const popup = f.popups[0];
  assert.equal(popup.url, f.backend.origin + '/api/desktop/tray'); assert.equal(popup.visible, true);
  assert.equal(popup.options.webPreferences.nodeIntegration, false); assert.equal(popup.options.webPreferences.sandbox, true);
  assert.deepEqual(popup.openHandler(), { action: 'deny' });
  assert.equal(f.requests[0].options.headers['X-Xueness-Desktop-Token'], f.backend.token);
  assert.equal(f.sent.at(-1).snapshot.sessions.length, 2);
  for (const name of ['will-navigate', 'will-redirect', 'will-attach-webview']) {
    let prevented = false; popup.webContents.emit(name, { preventDefault: () => { prevented = true; } }); assert.ok(prevented);
  }
  f.command({ kind: 'session', id: id('f') }); f.command({ kind: 'session', id: '../escape' });
  f.ipcMain.emit('xueness:tray-command', { ...f.event(), sender: {} }, { kind: 'quit' });
  f.ipcMain.emit('xueness:tray-command', { ...f.event(), senderFrame: { url: popup.url } }, { kind: 'quit' });
  popup.webContents.mainFrame.url = f.backend.origin + '/'; f.command({ kind: 'quit' });
  popup.webContents.mainFrame.url = popup.url;
  assert.equal(f.commands.length, 0); assert.equal(f.quit(), 0);
  f.command({ kind: 'session', id: id('b'), secret: 'drop' });
  assert.deepEqual(f.commands[0], { channel: 'xueness:desktop-command', action: { kind: 'session', id: id('b') } });
  assert.equal(f.shown(), 1); assert.equal(popup.visible, false);
  await f.open(); f.command({ kind: 'new' }); assert.equal(f.commands[1].action.kind, 'new');
  f.command({ kind: 'feedback', url: 'https://example.com' }); assert.deepEqual(f.external, [FEEDBACK_URL]);
  f.command({ kind: 'quit' }); assert.equal(f.quit(), 1); f.host.dispose();
});

test('busy and plugin-disabled states prevent switching and new chats; current chat remains accessible', async () => {
  const f = fixture(); f.host.setState(state({ busy: true })); await f.open();
  f.command({ kind: 'new' }); f.command({ kind: 'session', id: id('b') }); assert.equal(f.commands.length, 0);
  f.command({ kind: 'session', id: id('a') }); assert.equal(f.commands.length, 1);
  f.host.setState(state({ sessionsEnabled: false })); await f.open();
  assert.equal(f.requests.length, 1); assert.deepEqual(f.sent.at(-1).snapshot.sessions, []);
  f.command({ kind: 'new' }); f.command({ kind: 'session', id: id('a') }); assert.equal(f.commands.length, 1);
  f.disable(); f.command({ kind: 'feedback' }); assert.equal(f.external.length, 0); f.host.dispose();
});

test('blur cancels a pending list and stale results cannot refill or reopen a hidden menu', async () => {
  let finish; const f = fixture({ fetchImpl: () => new Promise(resolve => { finish = resolve; }) });
  const opening = f.open(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.popups[0].visible, true); f.popups[0].emit('blur');
  assert.equal(f.requests[0].options.signal.aborted, true);
  finish({ ok: true, json: async () => ({ sessions: [session('a')] }) }); await opening;
  assert.equal(f.popups[0].visible, false); assert.equal(f.sent.at(-1).snapshot.sessions.length, 0); f.host.dispose();
});

test('simultaneous opens share page loading; disabled host destroys the popup and unregisters IPC', async () => {
  let loaded; const f = fixture({ load: () => new Promise(resolve => { loaded = resolve; }) });
  const first = f.open(), second = f.open(); assert.equal(f.popups.length, 1); assert.equal(f.popups[0].visible, undefined);
  loaded(); await Promise.all([first, second]); assert.equal(f.requests.length, 1);
  f.host.dispose(); assert.equal(f.popups[0].destroyed, true);
  for (const channel of ['xueness:tray-ready', 'xueness:tray-command', 'xueness:tray-resize', 'xueness:tray-dismiss']) assert.equal(f.ipcMain.listenerCount(channel), 0);
  await f.open(); assert.equal(f.popups.length, 1);
});

test('list failures produce an empty recoverable menu, and failed page loading rejects for native fallback', async () => {
  const f = fixture({ fetchImpl: async () => ({ ok: false }) }); await f.open();
  assert.equal(f.sent.at(-1).snapshot.failed, true); assert.deepEqual(f.sent.at(-1).snapshot.sessions, []); f.host.dispose();
  const broken = fixture({ load: async () => { throw new Error('missing tray page'); } });
  await assert.rejects(broken.open(), /missing tray page/); assert.equal(broken.popups[0].destroyed, true); broken.host.dispose();
});

test('tray preload exposes only bounded fixed operations and removes snapshot listeners', () => {
  const ipcRenderer = new EventEmitter(), sent = []; let api;
  ipcRenderer.send = (...args) => sent.push(args);
  runInNewContext(readFileSync(join(__dirname, '../src/tray-menu-preload.cjs'), 'utf8'), {
    require: name => { assert.equal(name, 'electron'); return { ipcRenderer, contextBridge: { exposeInMainWorld: (name, value) => { assert.equal(name, 'xuenessTray'); api = value; } } }; },
  });
  assert.deepEqual(Object.keys(api).sort(), ['dismiss', 'ready', 'resize', 'select', 'subscribe']);
  let snapshot; const unsubscribe = api.subscribe(value => { snapshot = value; });
  ipcRenderer.emit('xueness:tray-snapshot', {}, { busy: true }); assert.equal(snapshot.busy, true); unsubscribe();
  assert.equal(ipcRenderer.listenerCount('xueness:tray-snapshot'), 0); api.subscribe(null)();
  for (const action of [null, {}, { kind: 'session', id: '../file' }, { kind: 'open', url: 'https://example.com' }]) api.select(action);
  for (const height of [99, 2001, NaN, '400', 400.5]) api.resize(height);
  assert.equal(sent.length, 0);
  api.select({ kind: 'session', id: id('a'), url: 'discard' }); api.select({ kind: 'feedback', url: 'discard' }); api.resize(400); api.ready(); api.dismiss();
  assert.deepEqual(JSON.parse(JSON.stringify(sent)), [
    ['xueness:tray-command', { kind: 'session', id: id('a') }], ['xueness:tray-command', { kind: 'feedback' }],
    ['xueness:tray-resize', 400], ['xueness:tray-ready'], ['xueness:tray-dismiss'],
  ]);
});
