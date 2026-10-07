const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');

function bootMain(t, { smoke = false, deferBackend = false, failReopenLoad = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'xueness-main-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const oldSmoke = process.env.XUENESS_DESKTOP_SMOKE_FILE;
  const smokeFile = join(directory, 'smoke.json');
  if (smoke) process.env.XUENESS_DESKTOP_SMOKE_FILE = smokeFile;
  else delete process.env.XUENESS_DESKTOP_SMOKE_FILE;
  t.after(() => {
    if (oldSmoke === undefined) delete process.env.XUENESS_DESKTOP_SMOKE_FILE;
    else process.env.XUENESS_DESKTOP_SMOKE_FILE = oldSmoke;
  });

  const app = new EventEmitter();
  const ipcMain = new EventEmitter();
  const session = { webRequest: {
    beforeSend: [], beforeRequest: [],
    onBeforeSendHeaders(handler) { this.beforeSend.push(handler); },
    onBeforeRequest(filter, handler) { this.beforeRequest.push({ filter, handler }); },
  } };
  const windows = [];
  const policyInstallations = [];
  const dialogs = [];
  const menus = [], openDialogs = [], backends = [];
  let quitCount = 0, exitCode;
  let releaseBackend;
  const backendReady = new Promise(resolve => { releaseBackend = resolve; });
  Object.assign(app, {
    isPackaged: false,
    setName() {}, setPath() {}, requestSingleInstanceLock: () => true,
    whenReady: () => Promise.resolve(), getPath: () => join(directory, 'data'),
    quit() { quitCount++; }, exit(code) { exitCode = code; },
  });
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.destroyed = false;
      this.showCalls = 0;
      this.focusCalls = 0;
      this.webContents = new EventEmitter();
      this.webContents.session = session;
      this.webContents.mainFrame = { url: 'about:blank' };
      this.webContents.setWindowOpenHandler = handler => { this.windowOpenHandler = handler; };
      this.webContents.executeJavaScript = async () => ({ title: 'Xueness', workbenchReady: true });
      this.loadFile = async path => { this.loadedFile = path; };
      this.loadURL = async url => {
        if (failReopenLoad && windows.length > 1) throw new Error('fixture load failure');
        this.url = url; this.webContents.mainFrame.url = url;
      };
      this.isDestroyed = () => this.destroyed;
      this.isMinimized = () => false;
      this.restore = () => {};
      this.show = () => { this.showCalls++; };
      this.focus = () => { this.focusCalls++; };
      this.destroy = () => { this.destroyed = true; this.emit('closed'); };
      windows.push(this);
    }
  }
  class Backend extends EventEmitter {
    constructor(config) { super(); this.config = config; this.token = 'a'.repeat(64); backends.push(this); }
    async start() {
      if (deferBackend) await backendReady;
      this.origin = 'http://127.0.0.1:45678';
      return this.origin;
    }
    reply() {}
    async stop() {}
  }
  class UpdateCoordinator {
    async setEnabled() {}
    async handleRequest() {}
    async dispose() {}
    status() { return { phase: 'disabled' }; }
  }
  const electron = {
    app, BrowserWindow, ipcMain, session,
    Menu: { setApplicationMenu(menu) { menus.push(menu); }, buildFromTemplate: items => items },
    dialog: { showErrorBox: (title, message) => dialogs.push({ title, message }),
      showOpenDialog: async (_window, options) => { openDialogs.push(options); return { canceled: true, filePaths: [] }; } },
    shell: { openExternal: async () => {} }, net: {}, Tray: class {}, screen: {}, systemPreferences: {},
  };
  const mocks = new Map([
    ['electron', electron],
    ['./backend.cjs', { Backend }],
    ['./security.cjs', {
      isOwnedUrl: (url, origin) => {
        try { const parsed = new URL(url); return parsed.origin === origin && !parsed.username && !parsed.password; }
        catch { return false; }
      },
      isExternalUrl: () => false,
      installPermissionPolicy: (...args) => policyInstallations.push(args),
    }],
    ['./window-chrome.cjs', {
      getWindowChromeOptions: () => ({}), installWindowThemeSync() {},
    }],
    ['./update-coordinator.cjs', { UpdateCoordinator }],
    ['./electron-net-asset.cjs', { createElectronAssetRequest: () => async () => {} }],
    ['./permissions.cjs', { createPermissionsHandler: () => async () => null }],
    ['electron-updater', { autoUpdater: {} }],
  ]);
  const mainPath = resolve(__dirname, '../src/main.cjs');
  delete require.cache[mainPath];
  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    if (parent?.filename === mainPath && mocks.has(request)) return mocks.get(request);
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    require(mainPath);
  } finally {
    Module._load = originalLoad;
  }

  return { app, directory, exitCode: () => exitCode, ipcMain, policyInstallations,
    quitCount: () => quitCount, releaseBackend, session, smokeFile, windows, dialogs, menus, openDialogs, backends };
}

async function waitFor(predicate) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const result = predicate();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('desktop main did not reach the expected lifecycle state');
}

function findMenuItem(menu, label) {
  for (const item of menu) {
    if (item.label === label) return item;
    const nested = item.submenu && findMenuItem(item.submenu, label);
    if (nested) return nested;
  }
  return null;
}

test('Windows portable ZIP keeps its established release asset name', () => {
  const config = require('../electron-builder.cjs');
  assert.equal(config.win.artifactName, 'Xueness-${version}-windows-${arch}-portable.${ext}');
  assert.equal(config.nsis.artifactName, 'Xueness-${version}-windows-${arch}-setup.${ext}');
});

test('packaged smoke instrumentation uses the main window session', async t => {
  const f = bootMain(t, { smoke: true });
  await waitFor(() => {
    try { return readFileSync(f.smokeFile, 'utf8'); } catch { return null; }
  });
  const report = JSON.parse(readFileSync(f.smokeFile, 'utf8'));
  assert.equal(report.error, undefined, JSON.stringify(report));
  assert.equal(f.exitCode(), undefined);
  assert.equal(f.session.webRequest.beforeRequest.length, 1);
  assert.equal(f.session.webRequest.beforeRequest[0].filter.urls[0], 'http://127.0.0.1:45678/*');
});

test('native menus and host messages follow only the owned main-frame locale', async t => {
  const f = bootMain(t);
  await waitFor(() => f.windows[0]?.url && f.menus.length === 1);
  const owner = f.windows[0];
  assert.equal(findMenuItem(f.menus[0], '编辑')?.label, '编辑');
  const originalMenuCount = f.menus.length;
  f.ipcMain.emit('xueness:desktop-locale', { sender: {}, senderFrame: owner.webContents.mainFrame }, 'en');
  f.ipcMain.emit('xueness:desktop-locale', { sender: owner.webContents,
    senderFrame: { url: owner.webContents.mainFrame.url } }, 'en');
  owner.webContents.mainFrame.url = 'https://example.com/';
  f.ipcMain.emit('xueness:desktop-locale', { sender: owner.webContents,
    senderFrame: owner.webContents.mainFrame }, 'en');
  owner.webContents.mainFrame.url = 'http://user@127.0.0.1:45678/';
  f.ipcMain.emit('xueness:desktop-locale', { sender: owner.webContents,
    senderFrame: owner.webContents.mainFrame }, 'en');
  owner.webContents.mainFrame.url = owner.url;
  f.ipcMain.emit('xueness:desktop-locale', { sender: owner.webContents,
    senderFrame: owner.webContents.mainFrame }, 'fr');
  assert.equal(f.menus.length, originalMenuCount);

  f.ipcMain.emit('xueness:desktop-locale', { sender: owner.webContents,
    senderFrame: owner.webContents.mainFrame }, 'en');
  assert.equal(f.menus.length, originalMenuCount + 1);
  assert.equal(findMenuItem(f.menus.at(-1), 'Edit')?.label, 'Edit');
  assert.equal(findMenuItem(f.menus.at(-1), 'Quit Xueness')?.role, 'quit');
  f.backends[0].emit('dialog', { id: 'a'.repeat(32), initialRoot: '/tmp' });
  await waitFor(() => f.openDialogs.length === 1);
  assert.equal(f.openDialogs[0].title, 'Choose project folder');
  f.backends[0].emit('failure');
  assert.equal(f.dialogs.at(-1).title, 'Xueness backend stopped');
  assert.match(f.dialogs.at(-1).message, /Saved data has not been deleted/);
});

test('macOS keeps the backend alive after last-window close and recreates a secured window on activate', {
  skip: process.platform !== 'darwin',
}, async t => {
  const f = bootMain(t);
  await waitFor(() => f.windows[0]?.url);
  assert.equal(f.windows.length, 1);
  f.windows[0].destroy();
  assert.equal(f.ipcMain.listenerCount('xueness:desktop-background'), 0);
  f.app.emit('window-all-closed');
  assert.equal(f.quitCount(), 0);
  f.app.emit('activate');
  await waitFor(() => f.windows[1]?.url);
  assert.equal(f.windows[1].url, 'http://127.0.0.1:45678/?xuenessDesktop=1');
  assert.equal(f.windows[1].webContents.listenerCount('will-navigate'), 1);
  assert.equal(typeof f.windows[1].windowOpenHandler, 'function');
  assert.equal(f.policyInstallations.length, 2);
  assert.equal(f.session.webRequest.beforeSend.length, 2);
  assert.equal(f.ipcMain.listenerCount('xueness:desktop-background'), 1);
  f.windows[1].destroy();
  assert.equal(f.ipcMain.listenerCount('xueness:desktop-background'), 0);
  assert.equal(f.ipcMain.listenerCount('xueness:desktop-tray-state'), 0);
});

test('second-instance restores the secured macOS window after the last window closed', {
  skip: process.platform !== 'darwin',
}, async t => {
  const f = bootMain(t);
  await waitFor(() => f.windows[0]?.url);
  f.windows[0].destroy();
  f.app.emit('window-all-closed');
  assert.equal(f.quitCount(), 0);
  f.app.emit('second-instance', {}, ['Xueness']);
  await waitFor(() => f.windows[1]?.url);
  assert.equal(f.windows.length, 2);
  assert.equal(f.windows[1].url, 'http://127.0.0.1:45678/?xuenessDesktop=1');
  assert.equal(f.windows[1].webContents.listenerCount('will-navigate'), 1);
  assert.equal(typeof f.windows[1].windowOpenHandler, 'function');
  assert.equal(f.ipcMain.listenerCount('xueness:desktop-background'), 1);
  f.windows[1].destroy();
});

test('activation and second-instance do not show or recreate windows during quit', {
  skip: process.platform !== 'darwin',
}, async t => {
  const f = bootMain(t);
  await waitFor(() => f.windows[0]?.url);
  const first = f.windows[0];
  let prevented = false;
  f.app.emit('before-quit', { preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  f.app.emit('activate');
  f.app.emit('second-instance', {}, ['Xueness']);
  assert.equal(first.showCalls, 0);
  assert.equal(first.focusCalls, 0);
  first.destroy();
  f.app.emit('activate');
  f.app.emit('second-instance', {}, ['Xueness']);
  assert.equal(f.windows.length, 1);
});

test('failed reopen reports the workbench load failure and requests a clean quit', async t => {
  const f = bootMain(t, { failReopenLoad: true });
  await waitFor(() => f.windows[0]?.url);
  f.windows[0].destroy();
  f.app.emit('second-instance', {}, ['Xueness']);
  await waitFor(() => f.dialogs.length > 0);
  assert.match(f.dialogs[0].message, /无法重新打开工作台/);
  assert.equal(f.quitCount(), 1);
});

test('macOS restores a startup window if it closes before the backend is ready', {
  skip: process.platform !== 'darwin',
}, async t => {
  const f = bootMain(t, { deferBackend: true });
  await waitFor(() => f.windows[0]?.loadedFile);
  f.windows[0].destroy();
  f.app.emit('window-all-closed');
  assert.equal(f.quitCount(), 0);
  f.releaseBackend();
  await waitFor(() => f.windows.some(window => !window.isDestroyed() && window.url));
  const liveWindow = f.windows.find(window => !window.isDestroyed());
  assert.equal(f.windows.length, 2);
  assert.equal(liveWindow.url, 'http://127.0.0.1:45678/?xuenessDesktop=1');
  assert.equal(liveWindow.webContents.listenerCount('will-navigate'), 1);
  f.windows[1].destroy();
});
