const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createDesktopBackground, handleSecondInstance } = require('../src/desktop-background.cjs');

function fixture({ failTray = false, platform = 'win32', customMenu = false } = {}) {
  const ipcMain = new EventEmitter(), window = new EventEmitter(), trays = [];
  let quitting = false;
  const calls = { hide: 0, show: 0, focus: 0, restore: 0, quit: 0 };
  window.webContents = { mainFrame: { url: 'http://127.0.0.1:45678/' } };
  window.isDestroyed = () => false; window.isMinimized = () => true;
  for (const method of ['hide', 'show', 'focus', 'restore']) window[method] = () => calls[method]++;
  class Tray extends EventEmitter {
    constructor(path) { super(); if (failTray) throw new Error('tray unavailable'); this.path = path; trays.push(this); }
    setToolTip(value) { this.tooltip = value; }
    setContextMenu(value) { this.menu = value; }
    destroy() { this.destroyed = true; }
    getBounds() { return { x: 1200, y: 1040, width: 20, height: 20 }; }
    popUpContextMenu(value) { this.fallback = value; }
  }
  const popups = [], snapshots = [];
  class BrowserWindow extends EventEmitter {
    constructor() {
      super(); this.webContents = new EventEmitter(); this.webContents.mainFrame = { url: 'http://127.0.0.1:45678/api/desktop/tray' };
      this.webContents.send = (_channel, value) => snapshots.push(value);
      this.webContents.setWindowOpenHandler = () => {}; popups.push(this);
    }
    isDestroyed() { return Boolean(this.destroyed); }
    async loadURL() {}
    setBounds() {} show() {} focus() {} hide() {}
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  const app = { quit: () => { calls.quit++; quitting = true; } };
  const host = createDesktopBackground({ app, window, Tray, Menu: { buildFromTemplate: items => items }, ipcMain,
    iconPath: 'icon.ico', getOrigin: () => 'http://127.0.0.1:45678', isQuitting: () => quitting, platform,
    ...(customMenu ? { BrowserWindow, screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }) },
      getBackend: () => ({ origin: 'http://127.0.0.1:45678', token: 'fixture-token' }), shell: { openExternal: async () => {} } } : {}) });
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
  const policy = (enabled, sender = event) => ipcMain.emit('xueness:desktop-background', sender, enabled);
  const close = () => { let prevented = false; window.emit('close', { preventDefault: () => { prevented = true; } }); return prevented; };
  return { host, window, trays, calls, app, ipcMain, event, policy, close, popups, snapshots };
}

test('enabled desktop creates one tray and closing hides the window without quitting', () => {
  const f = fixture(); assert.equal(f.close(), false);
  f.policy(true); f.policy(true);
  assert.equal(f.trays.length, 1); assert.equal(f.trays[0].path, 'icon.ico');
  assert.equal(f.close(), true); assert.equal(f.calls.hide, 1); assert.equal(f.calls.quit, 0);
  f.trays[0].emit('click');
  assert.equal(f.calls.restore, 1); assert.equal(f.calls.show, 1); assert.equal(f.calls.focus, 1);
  f.trays[0].menu.find(item => item.label === '退出 Xueness').click();
  assert.equal(f.calls.quit, 1); assert.equal(f.close(), false);
  f.host.dispose(); assert.equal(f.trays[0].destroyed, true);
  assert.equal(f.ipcMain.listenerCount('xueness:desktop-background'), 0);
});

test('disabling desktop removes the tray, restores the window, and restores close-to-quit', () => {
  const f = fixture(); f.policy(true); f.close(); f.policy(false);
  assert.equal(f.trays[0].destroyed, true); assert.equal(f.calls.show, 1); assert.equal(f.close(), false);
  f.host.dispose(); f.policy(true); assert.equal(f.trays.length, 1);
});

test('spoofed background requests cannot create a tray or alter close behavior', () => {
  const f = fixture(); f.policy(true, { ...f.event, sender: {} });
  f.policy(true, { ...f.event, senderFrame: { url: f.event.senderFrame.url } });
  f.window.webContents.mainFrame.url = 'https://example.com'; f.policy(true);
  f.window.webContents.mainFrame.url = 'http://127.0.0.1:45678'; f.policy('true');
  assert.equal(f.trays.length, 0); assert.equal(f.close(), false);
});

test('missing tray support and non-Windows hosts retain ordinary close behavior', () => {
  for (const options of [{ failTray: true }, { platform: 'darwin' }, { platform: 'linux' }]) {
    const f = fixture(options); f.policy(true);
    assert.equal(f.close(), false); assert.equal(f.calls.hide, 0);
  }
});

test('second launch restores a background window and an explicit quit argument shuts down the existing instance', () => {
  let shown = 0, quit = 0;
  const actions = { show: () => shown++, quit: () => quit++ };
  handleSecondInstance(['Xueness.exe'], actions); handleSecondInstance(['Xueness.exe', '--quit'], actions);
  assert.equal(shown, 1); assert.equal(quit, 1);
});

test('custom tray retains state published before enable and destroys its menu when desktop is disabled', async t => {
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ sessions: [] }) }));
  const f = fixture({ customMenu: true });
  const state = { busy: false, sessionsEnabled: true, activeId: null, locale: 'en', dark: true };
  f.ipcMain.emit('xueness:desktop-tray-state', f.event, state);
  f.ipcMain.emit('xueness:desktop-tray-state', { ...f.event, sender: {} }, { ...state, busy: true });
  f.policy(true); f.trays[0].emit('right-click'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.popups.length, 1); assert.equal(f.snapshots.at(-1).busy, false);
  assert.equal(f.snapshots.at(-1).locale, 'en'); assert.equal(f.snapshots.at(-1).dark, true);
  f.policy(false); assert.equal(f.popups[0].destroyed, true);
  assert.equal(f.ipcMain.listenerCount('xueness:tray-command'), 0);
  f.policy(true); f.trays[1].emit('right-click'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.popups.length, 2); assert.equal(f.snapshots.at(-1).sessionsEnabled, true);
  f.host.dispose(); assert.equal(f.popups[1].destroyed, true);
  assert.equal(f.ipcMain.listenerCount('xueness:desktop-tray-state'), 0);
});
