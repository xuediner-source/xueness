const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');
const { getWindowChromeOptions, installWindowThemeSync, TITLEBAR_HEIGHT } = require('../src/window-chrome.cjs');

test('macOS keeps native traffic lights and reserves their native area', () => {
  assert.deepEqual(getWindowChromeOptions('darwin'), {
    titleBarStyle: 'hidden',
    titleBarOverlay: true,
    trafficLightPosition: { x: 14, y: 12 },
  });
});

test('Windows overlays native controls on the integrated workbench title bar', () => {
  assert.deepEqual(getWindowChromeOptions('win32'), {
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#171717',
      symbolColor: '#f4f4f5',
      height: TITLEBAR_HEIGHT,
    },
    autoHideMenuBar: true,
  });
});

test('other platforms keep Electron default window chrome', () => {
  assert.deepEqual(getWindowChromeOptions('linux'), {});
});

function themeHost() {
  const ipcMain = new EventEmitter();
  const window = new EventEmitter();
  window.webContents = { mainFrame: { url: 'http://127.0.0.1:45678/?xuenessDesktop=1' } };
  window.isDestroyed = () => false;
  const overlays = [], backgrounds = [];
  window.setTitleBarOverlay = value => overlays.push(value);
  window.setBackgroundColor = value => backgrounds.push(value);
  installWindowThemeSync({ ipcMain, window, getOrigin: () => 'http://127.0.0.1:45678', platform: 'win32' });
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
  const send = (colors, sender = event) => ipcMain.emit('xueness:window-colors', sender, colors);
  return { ipcMain, window, overlays, backgrounds, event, send };
}

test('window controls follow light and dark colors while keeping their native height', () => {
  const host = themeHost();
  host.send({ color: '#ececee', symbolColor: '#262626', height: 999 });
  host.send({ color: '#2b2b2b', symbolColor: '#d4d4d4' });
  assert.deepEqual(host.overlays, [
    { color: '#ececee', symbolColor: '#262626', height: TITLEBAR_HEIGHT },
    { color: '#2b2b2b', symbolColor: '#d4d4d4', height: TITLEBAR_HEIGHT },
  ]);
  assert.deepEqual(host.backgrounds, ['#ececee', '#2b2b2b']);
  host.window.emit('closed');
  host.send({ color: '#000000', symbolColor: '#ffffff' });
  assert.equal(host.overlays.length, 2);
  assert.equal(host.ipcMain.listenerCount('xueness:window-colors'), 0);
});

test('theme messages reject foreign windows, child frames, remote pages and invalid colors', () => {
  const host = themeHost(), palette = { color: '#ececee', symbolColor: '#262626' };
  host.send(palette, { ...host.event, sender: {} });
  host.send(palette, { ...host.event, senderFrame: { url: host.event.senderFrame.url } });
  for (const url of ['file:///loading.html', 'https://example.com', 'http://127.0.0.1:9999', 'http://user@127.0.0.1:45678']) {
    host.window.webContents.mainFrame.url = url;
    host.send(palette);
  }
  host.window.webContents.mainFrame.url = 'http://127.0.0.1:45678/';
  for (const colors of [null, {}, { ...palette, color: 'transparent' }, { ...palette, symbolColor: '#fff' }, { ...palette, color: ['#ececee'] }]) host.send(colors);
  host.window.isDestroyed = () => true;
  host.send(palette);
  assert.deepEqual(host.overlays, []);
});

test('non-Windows hosts do not install an unsupported overlay listener', () => {
  const ipcMain = new EventEmitter();
  installWindowThemeSync({ ipcMain, window: {}, getOrigin: () => '', platform: 'darwin' });
  assert.equal(ipcMain.listenerCount('xueness:window-colors'), 0);
});

test('isolated preload follows theme mutations, deduplicates unrelated changes and cleans up', () => {
  const callbacks = new Map(), sent = [];
  let policy = null;
  const root = { getAttribute: name => name === 'data-xn-desktop-enabled' ? policy : null };
  let color = '#ececee', symbolColor = '#262626', observed, disconnected = false, sync;
  const page = { addEventListener: (name, callback) => callbacks.set(name, callback) };
  page.top = page;
  runInNewContext(readFileSync(join(__dirname, '../src/window-theme-preload.cjs'), 'utf8'), {
    require: name => { assert.equal(name, 'electron'); return { ipcRenderer: { send: (...args) => sent.push(args) } }; },
    process: { platform: 'win32' }, // Sandboxed preloads expose a reduced process object.
    document: { readyState: 'loading', documentElement: root },
    window: page,
    getComputedStyle: element => {
      assert.equal(element, root);
      return { getPropertyValue: name => name === '--bg-window' ? color : symbolColor };
    },
    MutationObserver: class {
      constructor(callback) { sync = callback; }
      observe(element, options) { observed = { element, options }; }
      disconnect() { disconnected = true; }
    },
  });
  assert.equal(sent.length, 0);
  callbacks.get('DOMContentLoaded')();
  assert.equal(observed.element, root);
  assert.deepEqual(Array.from(observed.options.attributeFilter), ['class', 'style', 'data-xn-desktop-enabled']);
  sync();
  assert.equal(sent.length, 1);
  color = '#2b2b2b'; symbolColor = '#d4d4d4'; sync();
  assert.deepEqual(JSON.parse(JSON.stringify(sent)), [
    ['xueness:window-colors', { color: '#ececee', symbolColor: '#262626' }],
    ['xueness:window-colors', { color: '#2b2b2b', symbolColor: '#d4d4d4' }],
  ]);
  color = ''; sync();
  assert.equal(sent.length, 2);
  policy = 'true'; sync(); sync();
  assert.equal(sent.length, 3);
  assert.equal(sent[2][0], 'xueness:desktop-background'); assert.equal(sent[2][1], true);
  policy = 'false'; sync();
  assert.equal(sent[3][1], false);
  callbacks.get('pagehide')();
  assert.equal(disconnected, true);
});
