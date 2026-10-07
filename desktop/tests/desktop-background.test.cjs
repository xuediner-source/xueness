const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createDesktopBackground, handleSecondInstance } = require('../src/desktop-background.cjs');

function fixture({ failTray = false, platform = 'win32', customMenu = false,
  dockSupported = true, displaySupported = true, cursorSupported = true, locale = 'zh' } = {}) {
  const ipcMain = new EventEmitter(), window = new EventEmitter(), trays = [];
  let quitting = false;
  let windowDestroyed = false, dockMenu = null;
  const calls = { hide: 0, show: 0, focus: 0, restore: 0, quit: 0, feedback: 0, dockMenu: [] };
  const desktopCommands = [], displayMatches = [];
  window.webContents = { mainFrame: { url: 'http://127.0.0.1:45678/' } };
  window.isDestroyed = () => windowDestroyed; window.isMinimized = () => true;
  window.getBounds = () => ({ x: 300, y: 200, width: 800, height: 600 });
  window.webContents.send = (channel, value) => desktopCommands.push({ channel, value });
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
    constructor(options) {
      super(); this.options = options;
      this.webContents = new EventEmitter(); this.webContents.mainFrame = { url: 'http://127.0.0.1:45678/api/desktop/tray' };
      this.webContents.send = (_channel, value) => snapshots.push(value);
      this.webContents.setWindowOpenHandler = () => {}; popups.push(this);
    }
    isDestroyed() { return Boolean(this.destroyed); }
    async loadURL() {}
    setBounds() {} show() {} focus() {} hide() {}
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  const app = { quit: () => { calls.quit++; quitting = true; } };
  if (dockSupported) app.dock = { setMenu: menu => { dockMenu = menu; calls.dockMenu.push(menu); } };
  const screen = {
    ...(displaySupported ? { getDisplayMatching: bounds => {
      displayMatches.push(bounds);
      return { workArea: { x: 0, y: 0, width: 1920, height: 1040 } };
    } } : {}),
    ...(cursorSupported ? { getCursorScreenPoint: () => ({ x: 1350, y: 1020 }) } : {}),
  };
  const host = createDesktopBackground({ app, window, Tray, Menu: { buildFromTemplate: items => items }, ipcMain,
    iconPath: 'icon.ico', getOrigin: () => 'http://127.0.0.1:45678', isQuitting: () => quitting, platform,
    ...(customMenu || platform === 'darwin' ? { BrowserWindow, screen,
      getBackend: () => ({ origin: 'http://127.0.0.1:45678', token: 'fixture-token' }),
      shell: { openExternal: async () => { calls.feedback++; } } } : {}),
    getLocale: () => locale });
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
  const policy = (enabled, sender = event) => ipcMain.emit('xueness:desktop-background', sender, enabled);
  const close = () => { let prevented = false; window.emit('close', { preventDefault: () => { prevented = true; } }); return prevented; };
  const closeWindow = () => { windowDestroyed = true; window.emit('closed'); };
  return { host, window, trays, calls, app, ipcMain, event, policy, close, closeWindow, popups, snapshots,
    desktopCommands, displayMatches, screen, getDockMenu: () => dockMenu };
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

test('destroying the window disposes its tray and host listeners', () => {
  const f = fixture();
  f.policy(true);
  const tray = f.trays[0];
  assert.ok(tray);
  f.window.emit('closed');
  assert.equal(tray.destroyed, true);
  assert.equal(f.ipcMain.listenerCount('xueness:desktop-background'), 0);
  assert.equal(f.ipcMain.listenerCount('xueness:desktop-tray-state'), 0);
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

test('macOS Dock quick actions use the shared task popup, prefer published locale, and stop after disable', async t => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requests++;
    return { ok: true, json: async () => ({ sessions: [] }) };
  });
  const f = fixture({ platform: 'darwin', locale: 'en' });
  const state = { busy: false, sessionsEnabled: true, activeId: null, locale: 'zh', dark: true };
  f.ipcMain.emit('xueness:desktop-tray-state', f.event, state);
  f.policy(true);
  let menu = f.getDockMenu();
  assert.equal(menu.find(item => item.label === '打开 Xueness')?.label, '打开 Xueness');
  assert.ok(menu.some(item => item.label === '任务与项目'));
  assert.ok(menu.some(item => item.label === '退出 Xueness'));
  assert.equal(f.close(), false, 'macOS window close remains native');
  assert.equal(f.calls.hide, 0);

  menu.find(item => item.label === '任务与项目').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.displayMatches[0], { x: 1350, y: 1020, width: 1, height: 1 });
  assert.equal(f.popups.length, 1);
  assert.equal(f.snapshots.at(-1).locale, 'zh');
  assert.equal(requests, 1);
  f.ipcMain.emit('xueness:tray-command', {
    sender: f.popups[0].webContents,
    senderFrame: f.popups[0].webContents.mainFrame,
  }, { kind: 'new' });
  assert.deepEqual(f.desktopCommands.at(-1), { channel: 'xueness:desktop-command', value: { kind: 'new' } });

  f.ipcMain.emit('xueness:desktop-tray-state', f.event, { ...state, locale: 'en' });
  menu = f.getDockMenu();
  assert.ok(menu.some(item => item.label === 'Open Xueness'));
  assert.ok(menu.some(item => item.label === 'Tasks and projects'));
  assert.ok(menu.some(item => item.label === 'Quit Xueness'));
  f.policy(false);
  assert.equal(f.getDockMenu(), null);
  assert.equal(f.popups[0].destroyed, true);
  assert.equal(f.ipcMain.listenerCount('xueness:tray-command'), 0);
  menu.find(item => item.label === 'Tasks and projects').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests, 1, 'a stale Dock menu cannot start a request after disable');

  f.policy(true);
  f.getDockMenu().find(item => item.label === 'Tasks and projects').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.popups.length, 2);
  assert.equal(f.snapshots.at(-1).sessionsEnabled, true, 'state published before enable survives disable and re-enable');
  assert.equal(f.snapshots.at(-1).locale, 'en');
  assert.equal(requests, 2);
  f.policy(false);
  f.host.dispose();
});

test('macOS Dock popup safely falls back to live window bounds and window close disposes host state', async () => {
  const f = fixture({ platform: 'darwin', cursorSupported: false });
  f.ipcMain.emit('xueness:desktop-tray-state', f.event,
    { busy: false, sessionsEnabled: false, activeId: null, locale: 'en', dark: false });
  f.policy(true);
  f.getDockMenu().find(item => item.label === 'Tasks and projects').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.displayMatches[0], { x: 300, y: 200, width: 800, height: 600 });
  assert.equal(f.close(), false);
  assert.equal(f.calls.hide, 0);
  f.closeWindow();
  assert.equal(f.getDockMenu(), null);
  assert.equal(f.popups[0].destroyed, true);
  assert.equal(f.ipcMain.listenerCount('xueness:desktop-background'), 0);
  assert.equal(f.ipcMain.listenerCount('xueness:desktop-tray-state'), 0);
});

test('macOS Dock is safely unavailable without Dock or screen display support', () => {
  for (const options of [{ dockSupported: false }, { displaySupported: false }]) {
    const f = fixture({ platform: 'darwin', ...options });
    f.policy(true);
    assert.equal(f.getDockMenu(), null);
    assert.equal(f.close(), false);
    f.host.dispose();
  }
});

test('macOS Dock policy rejects external and subframe messages', () => {
  const f = fixture({ platform: 'darwin' });
  f.policy(true, { ...f.event, sender: {} });
  f.policy(true, { ...f.event, senderFrame: { url: f.event.senderFrame.url } });
  f.window.webContents.mainFrame.url = 'https://example.com';
  f.policy(true);
  assert.equal(f.getDockMenu(), null);
  assert.equal(f.calls.dockMenu.length, 0);
  f.host.dispose();
});

test('Windows fallback tray labels and tooltip follow the published locale without recreating the tray', () => {
  const f = fixture({ customMenu: true });
  f.policy(true);
  const tray = f.trays[0];
  assert.equal(tray.menu, undefined, 'the custom rich popup owns right-click when available');
  assert.match(tray.tooltip, /关闭窗口后在后台运行/);
  f.ipcMain.emit('xueness:desktop-tray-state', f.event,
    { busy: false, sessionsEnabled: true, activeId: null, locale: 'en', dark: false });
  assert.equal(f.trays[0], tray);
  assert.match(tray.tooltip, /keeps running when the window closes/);
  assert.equal(tray.menu, undefined, 'locale changes must not install a second native context menu');
  f.screen.getDisplayMatching = () => { throw new Error('popup positioning unavailable'); };
  tray.emit('right-click');
  return new Promise(resolve => setImmediate(resolve)).then(() => {
    assert.ok(tray.fallback.some(item => item.label === 'Open Xueness'));
    assert.ok(tray.fallback.some(item => item.label === 'Quit Xueness'));
    f.host.dispose();
  });
});
