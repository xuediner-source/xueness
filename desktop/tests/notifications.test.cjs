const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createDesktopNotifications, normalizeNotifyRequest, LABELS } = require('../src/notifications.cjs');

function fixture({ packaged = false, withAumid = true, withNotification = true, origin = 'http://127.0.0.1:45678', platform = 'win32' } = {}) {
  const ipcMain = new EventEmitter();
  const makeWindow = () => {
    const value = new EventEmitter();
    value.webContents = { mainFrame: { url: `${origin}/?xuenessDesktop=1` } };
    value.webContents.send = (channel, message) => commands.push({ channel, value: message });
    value.isDestroyed = () => Boolean(value.destroyed);
    return value;
  };
  let window = makeWindow();
  const commands = [];
  const calls = { focus: 0, show: 0 };
  let showMainAction = () => {};
  const notifications = [];
  class Notification extends EventEmitter {
    constructor(options) { super(); this.options = options; notifications.push(this); }
    show() { calls.show++; }
    close() { this.closed = true; }
  }
  const app = { isPackaged: packaged, aumid: null };
  if (withAumid) app.setAppUserModelId = value => { app.aumid = value; };
  const host = createDesktopNotifications({ app, Notification: withNotification ? Notification : undefined,
    ipcMain, getWindow: () => window, getOrigin: () => origin, showMain: () => { calls.focus++; return showMainAction(); }, platform });
  const eventFor = current => ({ sender: current.webContents, senderFrame: current.webContents.mainFrame });
  const event = eventFor(window);
  const notify = (value, sender = eventFor(window)) => ipcMain.emit('xueness:desktop-notify', sender, value);
  const policy = (enabled, sender = eventFor(window)) => ipcMain.emit('xueness:desktop-background', sender, enabled);
  const trayState = (value = { sessionsEnabled: true }, sender = eventFor(window)) => ipcMain.emit('xueness:desktop-tray-state', sender, value);
  const request = (seq, kind, overrides = {}) => ({ seq, locale: 'zh',
    items: [{ kind, sessionTitle: '导入数据', sessionId: 'a'.repeat(32) }], ...overrides });
  const result = { host, app, ipcMain, event, notify, request, notifications, commands, calls, policy, trayState,
    replaceWindow(value = makeWindow()) { window = value; return value; }, makeWindow,
    setShowMainAction(value) { showMainAction = value; } };
  Object.defineProperty(result, 'window', { get: () => window });
  return result;
}

test('valid requests show localized notifications and clicking one focuses the window and selects the session', () => {
  const f = fixture();
  assert.equal(f.app.aumid, process.execPath, 'unpackaged apps bind the executable App User Model ID');
  f.policy(true); f.trayState();
  f.notify(f.request(1000, 'approval'));
  assert.equal(f.notifications.length, 1);
  assert.deepEqual(f.notifications[0].options, { title: '等待你的审批', body: '「导入数据」请求批准一个操作' });
  f.notifications[0].emit('click');
  assert.equal(f.calls.focus, 1);
  assert.deepEqual(f.commands.at(-1), { channel: 'xueness:desktop-command', value: { kind: 'session', id: 'a'.repeat(32) } });
  assert.equal(f.notifications[0].closed, true);

  f.notify({ seq: 1001, locale: 'en', items: [{ kind: 'completed', sessionTitle: '  bad\x01title  ', sessionId: 'b'.repeat(32) }] });
  assert.deepEqual(f.notifications[1].options, { title: 'Run completed', body: '"bad title" completed' });
  f.notifications[1].emit('click');
  assert.deepEqual(f.commands.at(-1).value, { kind: 'session', id: 'b'.repeat(32) });

  f.notify({ seq: 1002, locale: 'en', items: [{ kind: 'question', sessionTitle: '配置' }] });
  assert.deepEqual(f.notifications[2].options, { title: 'Answer needed', body: '"配置" asked a question' });
  f.notifications[2].emit('click');
  assert.equal(f.calls.focus, 3, 'a notification without a session id still focuses the window');
  assert.equal(f.commands.length, 2);
  f.host.dispose();
});

test('every notification kind maps to distinct bilingual copy', () => {
  for (const [kind, labels] of Object.entries(LABELS)) {
    assert.notEqual(labels.zh.title, labels.en.title);
    assert.match(labels.zh.body('任务'), /任务/);
    for (const locale of ['zh', 'en']) {
      assert.equal(typeof labels[locale].title, 'string');
      assert.equal(typeof labels[locale].body('x'), 'string');
    }
  }
  assert.deepEqual(Object.keys(LABELS).sort(), ['approval', 'completed', 'failed', 'question']);
});

test('stale replays and malformed or spoofed requests never create notifications', () => {
  const f = fixture();
  f.policy(true);
  f.notify(f.request(1000, 'approval'));
  assert.equal(f.notifications.length, 1);
  f.notify(f.request(1000, 'approval'));
  f.notify(f.request(999, 'failed'));
  const spoofed = { sender: {}, senderFrame: f.event.senderFrame };
  const foreignFrame = { sender: f.event.sender, senderFrame: { url: 'https://example.com/' } };
  for (const sender of [spoofed, foreignFrame]) f.notify(f.request(1001, 'failed'), sender);
  for (const broken of [
    null, 'x', 5, {}, { seq: 1001, locale: 'fr', items: [{ kind: 'failed' }] },
    { seq: 1001, locale: 'zh', items: [] }, { seq: 1001, locale: 'zh', items: [{ kind: 'secret' }] },
    { seq: 1001, locale: 'zh', items: [{ kind: 'failed', sessionId: '../../etc' }] },
    { seq: 1001, locale: 'zh', items: [{ kind: 'failed', sessionTitle: 42 }] },
    { seq: 0, locale: 'zh', items: [{ kind: 'failed' }] },
    { seq: '1001', locale: 'zh', items: [{ kind: 'failed' }] },
    { locale: 'zh', items: [{ kind: 'failed' }] },
    { seq: 1001, locale: 'zh', items: Array.from({ length: 6 }, () => ({ kind: 'failed' })) },
  ]) f.notify(broken);
  f.window.isDestroyed = () => true;
  f.notify(f.request(1002, 'failed'));
  f.window.isDestroyed = () => false;
  assert.equal(f.notifications.length, 1);
  assert.equal(f.calls.focus, 0);
  f.host.dispose();
});

test('requests above the five item cap are rejected and duplicate session ids collapse', () => {
  const burst = Array.from({ length: 8 }, (_, n) => ({ kind: 'completed', sessionTitle: `t${n}`, sessionId: n === 7 ? 'a'.repeat(32) : undefined }));
  assert.equal(normalizeNotifyRequest({ seq: 5, locale: 'zh', items: burst }), null);
  const capped = normalizeNotifyRequest({ seq: 5, locale: 'zh', items: burst.slice(0, 5) });
  assert.equal(capped.items.length, 5);
  const collapsed = normalizeNotifyRequest({ seq: 5, locale: 'zh',
    items: [{ kind: 'failed', sessionTitle: 'a', sessionId: 'c'.repeat(32) }, { kind: 'failed', sessionTitle: 'b', sessionId: 'c'.repeat(32) }] });
  assert.equal(collapsed.items.length, 1);
  assert.equal(collapsed.items[0].sessionTitle, 'a');
});

test('missing Notification support keeps validation without crashing', () => {
  const f = fixture({ withNotification: false });
  f.policy(true);
  f.notify(f.request(1000, 'approval'));
  assert.equal(f.notifications.length, 0);
  f.host.dispose();
  f.notify(f.request(1001, 'approval'));
  assert.equal(f.notifications.length, 0);
});

test('dispose stops the channel and macOS hosts do not touch the App User Model ID', () => {
  const f = fixture({ packaged: true });
  assert.equal(f.app.aumid, 'app.xueness.desktop');
  f.host.dispose();
  assert.equal(f.ipcMain.listenerCount('xueness:desktop-notify'), 0);
  f.notify(f.request(1000, 'approval'));
  assert.equal(f.notifications.length, 0);

  const mac = fixture({ packaged: true });
  const macHost = createDesktopNotifications({ app: mac.app, Notification: class { show() {} on() {} close() {} },
    ipcMain: mac.ipcMain, getWindow: () => mac.window, getOrigin: () => 'http://127.0.0.1:45678',
    showMain: () => {}, platform: 'darwin' });
  assert.equal(mac.app.aumid, 'app.xueness.desktop', 'an id set by another plugin is preserved on macOS');
  macHost.dispose();
  assert.equal(mac.ipcMain.listenerCount('xueness:desktop-notify'), 1, 'only the fixture host remains');
  assert.equal(mac.ipcMain.listenerCount('xueness:desktop-tray-state'), 1);
  assert.equal(mac.ipcMain.listenerCount('xueness:desktop-background'), 1);

  const guarded = fixture({ withAumid: false });
  const guardedHost = createDesktopNotifications({ app: guarded.app, Notification: class { show() {} on() {} close() {} },
    ipcMain: guarded.ipcMain, getWindow: () => guarded.window, getOrigin: () => 'http://127.0.0.1:45678',
    showMain: () => {}, platform: 'win32' });
  guardedHost.dispose();
});

test('macOS notification click waits for a recreated window to publish trusted bridge state', () => {
  const f = fixture({ platform: 'darwin' });
  f.policy(true); f.trayState();
  f.notify(f.request(1000, 'failed'));
  const closed = f.window;
  closed.destroyed = true;
  const reopened = f.makeWindow();
  f.setShowMainAction(() => f.replaceWindow(reopened));
  f.notifications[0].emit('click');
  assert.equal(f.calls.focus, 1);
  assert.equal(f.commands.length, 0, 'a destroyed window cannot receive the session command');
  f.trayState({ sessionsEnabled: true }, { sender: closed.webContents, senderFrame: closed.webContents.mainFrame });
  assert.equal(f.commands.length, 0, 'a destroyed renderer cannot claim bridge readiness');
  const fakeFrame = { url: reopened.webContents.mainFrame.url };
  f.policy(false, { sender: reopened.webContents, senderFrame: fakeFrame });
  f.trayState({ sessionsEnabled: true }, { sender: reopened.webContents, senderFrame: fakeFrame });
  assert.equal(f.commands.length, 0, 'a frame with a forged URL cannot clear or flush the pending command');
  f.trayState({ sessionsEnabled: true }, { sender: reopened.webContents, senderFrame: reopened.webContents.mainFrame });
  assert.deepEqual(f.commands.at(-1), { channel: 'xueness:desktop-command', value: { kind: 'session', id: 'a'.repeat(32) } });
  f.host.dispose();
});

test('notification click keeps focus when renderer send throws', () => {
  const f = fixture({ platform: 'darwin' });
  f.policy(true); f.trayState();
  f.notify(f.request(1000, 'question'));
  f.window.webContents.send = () => { throw new Error('renderer gone'); };
  f.notifications[0].emit('click');
  assert.equal(f.calls.focus, 1, 'a failed renderer send must not prevent focus');
  f.host.dispose();
});

test('disabling the desktop plugin clears a queued notification session', () => {
  const f = fixture({ platform: 'darwin' });
  f.policy(true); f.trayState();
  f.notify(f.request(1000, 'question'));
  const closed = f.window;
  closed.destroyed = true;
  const newWindow = f.makeWindow();
  f.setShowMainAction(() => f.replaceWindow(newWindow));
  f.notifications[0].emit('click');
  assert.equal(f.commands.length, 0);
  f.policy(false, { sender: newWindow.webContents, senderFrame: newWindow.webContents.mainFrame });
  f.trayState({ sessionsEnabled: true }, { sender: newWindow.webContents, senderFrame: newWindow.webContents.mainFrame });
  assert.equal(f.commands.length, 0, 'disable cancels a queued selection');
  f.notify(f.request(1001, 'failed'));
  assert.equal(f.notifications.length, 1, 'a stale notification message cannot show after disable');
  f.policy(true, { sender: newWindow.webContents, senderFrame: newWindow.webContents.mainFrame });
  f.notify(f.request(1001, 'failed'));
  assert.equal(f.notifications.length, 1, 'a message rejected while disabled cannot replay after re-enable');
  f.notify(f.request(1002, 'completed'));
  assert.equal(f.notifications.length, 2, 'new transitions can notify after re-enable');
  f.host.dispose();
  assert.equal(f.ipcMain.listenerCount('xueness:desktop-notify'), 0);
  assert.equal(f.ipcMain.listenerCount('xueness:desktop-tray-state'), 0);
  assert.equal(f.ipcMain.listenerCount('xueness:desktop-background'), 0);
});
