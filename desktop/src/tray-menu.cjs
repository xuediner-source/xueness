const { join } = require('node:path');
const { isOwnedUrl } = require('./security.cjs');

const FEEDBACK_URL = 'https://github.com/xuediner-source/xueness/issues/new/choose';
const SESSION_ID = /^[a-f0-9]{32}$/;
const clean = (value, limit) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, limit) : '';

function normalizeTraySessions(sessions) {
  const seen = new Set();
  return (Array.isArray(sessions) ? sessions : []).flatMap(session => {
    if (!session || typeof session.id !== 'string' || !SESSION_ID.test(session.id) || seen.has(session.id)) return [];
    seen.add(session.id);
    const root = clean(session.root, 2048).replace(/[\\/]+$/, '');
    return [{ id: session.id, title: clean(session.title || session.task, 180) || 'Untitled',
      project: root.split(/[\\/]/).pop()?.slice(0, 50) || '', status: clean(session.status, 32), pinned: session.pinned === true,
      updatedAt: typeof session.updatedAt === 'string' ? session.updatedAt : '' }];
  }).sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0)).slice(0, 100);
}

function trayPopupBounds(anchor, area, desiredHeight = 510) {
  const width = Math.min(352, area.width - 8), height = Math.min(Math.max(100, desiredHeight), area.height - 8);
  const clamp = (value, min, max) => Math.round(Math.max(min, Math.min(max, value)));
  return { width, height, x: clamp(anchor.x + anchor.width - width, area.x + 4, area.x + area.width - width - 4),
    y: clamp(anchor.y - height >= area.y ? anchor.y - height : anchor.y + anchor.height, area.y + 4, area.y + area.height - height - 4) };
}

function normalizeTrayState(value) {
  if (!value || typeof value !== 'object' || typeof value.busy !== 'boolean' || typeof value.sessionsEnabled !== 'boolean'
    || !['zh', 'en'].includes(value.locale) || typeof value.dark !== 'boolean'
    || (value.activeId !== null && (typeof value.activeId !== 'string' || !SESSION_ID.test(value.activeId)))) return null;
  return { busy: value.busy, sessionsEnabled: value.sessionsEnabled, locale: value.locale, dark: value.dark, activeId: value.activeId };
}

function createTrayMenuHost({ app, BrowserWindow, screen, ipcMain, mainWindow, getBackend, shell, isEnabled, showMain, fetchImpl = fetch }) {
  let popup, loadingPage, anchor, area, controller, revision = 0, disposed = false;
  let state = { busy: true, sessionsEnabled: false, locale: 'zh', dark: false, activeId: null };
  let snapshot = { ...state, sessions: [], loading: false, failed: false };
  const publish = () => { if (popup && !popup.isDestroyed()) popup.webContents.send('xueness:tray-snapshot', snapshot); };
  const trusted = event => {
    if (!popup || popup.isDestroyed() || event.sender !== popup.webContents || event.senderFrame !== popup.webContents.mainFrame) return false;
    try { return isOwnedUrl(event.senderFrame.url, getBackend()?.origin) && new URL(event.senderFrame.url).pathname === '/api/desktop/tray'; }
    catch { return false; }
  };
  const hide = () => {
    revision++; controller?.abort(); controller = null;
    if (popup && !popup.isDestroyed()) popup.hide();
  };
  const setState = value => {
    const next = normalizeTrayState(value);
    if (!next || disposed) return;
    const disabled = state.sessionsEnabled && !next.sessionsEnabled;
    state = next;
    snapshot = { ...snapshot, ...state, ...(disabled ? { sessions: [], loading: false, failed: false } : {}) };
    if (disabled) { controller?.abort(); revision++; }
    publish();
  };
  const ready = event => { if (trusted(event) && isEnabled()) publish(); };
  const dismiss = event => { if (trusted(event)) hide(); };
  const resize = (event, height) => {
    if (!trusted(event) || !isEnabled() || !Number.isInteger(height) || height < 100 || height > 2000 || !anchor || !area) return;
    popup.setBounds(trayPopupBounds(anchor, area, height));
  };
  const command = (event, action) => {
    if (!trusted(event) || !isEnabled() || disposed || !action || typeof action !== 'object') return;
    if (action.kind === 'quit') { hide(); app.quit(); return; }
    if (action.kind === 'feedback') { hide(); void shell.openExternal(FEEDBACK_URL).catch(() => {}); return; }
    if (action.kind === 'new') {
      if (!state.sessionsEnabled || state.busy) return;
    } else if (action.kind === 'session') {
      if (!state.sessionsEnabled || typeof action.id !== 'string' || !SESSION_ID.test(action.id) || !snapshot.sessions.some(session => session.id === action.id)
        || (state.busy && action.id !== state.activeId)) return;
    } else return;
    if (mainWindow.isDestroyed()) return;
    hide(); showMain();
    mainWindow.webContents.send('xueness:desktop-command', action.kind === 'new' ? { kind: 'new' } : { kind: 'session', id: action.id });
  };
  const listeners = [['xueness:tray-ready', ready], ['xueness:tray-resize', resize], ['xueness:tray-command', command], ['xueness:tray-dismiss', dismiss]];
  for (const [channel, callback] of listeners) ipcMain.on(channel, callback);
  const open = async bounds => {
    if (disposed || !isEnabled() || !getBackend()?.origin) return;
    controller?.abort(); controller = new AbortController();
    const request = ++revision, signal = controller.signal;
    anchor = bounds; area = screen.getDisplayMatching(bounds).workArea;
    snapshot = { ...state, sessions: [], loading: state.sessionsEnabled, failed: false };
    if (!popup || popup.isDestroyed()) {
      popup = new BrowserWindow({ ...trayPopupBounds(anchor, area), show: false, frame: false, transparent: true,
        skipTaskbar: true, resizable: false, movable: false, minimizable: false, maximizable: false, alwaysOnTop: true,
        title: 'Xueness', webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true,
          preload: join(__dirname, 'tray-menu-preload.cjs'), spellcheck: false, webviewTag: false } });
      const created = popup;
      popup.on('blur', hide);
      popup.on('closed', () => { if (popup === created) { popup = null; loadingPage = null; hide(); } });
      popup.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      for (const name of ['will-navigate', 'will-redirect', 'will-attach-webview']) popup.webContents.on(name, event => event.preventDefault());
      loadingPage = created.loadURL(getBackend().origin + '/api/desktop/tray').catch(error => {
        if (!created.isDestroyed()) created.destroy();
        throw error;
      });
    }
    await loadingPage;
    if (request !== revision || !isEnabled() || disposed) return;
    popup.setBounds(trayPopupBounds(anchor, area)); publish(); popup.show(); popup.focus();
    if (!state.sessionsEnabled) return;
    try {
      const backend = getBackend();
      const response = await fetchImpl(backend.origin + '/api/sessions', { headers: { 'X-Xueness-Desktop-Token': backend.token },
        redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(4000)]) });
      if (!response.ok) throw new Error('Session list unavailable');
      const catalog = await response.json();
      if (request !== revision || !isEnabled() || disposed) return;
      snapshot = { ...state, sessions: normalizeTraySessions(catalog.sessions), loading: false, failed: false };
    } catch {
      if (request !== revision || !isEnabled() || disposed) return;
      snapshot = { ...state, sessions: [], loading: false, failed: true };
    }
    publish();
  };
  const dispose = () => {
    if (disposed) return; disposed = true; hide();
    for (const [channel, callback] of listeners) ipcMain.removeListener(channel, callback);
    if (popup && !popup.isDestroyed()) popup.destroy();
    snapshot = { ...state, sessions: [], loading: false, failed: false };
  };
  return { open, hide, setState, dispose };
}

module.exports = { createTrayMenuHost, normalizeTraySessions, normalizeTrayState, trayPopupBounds, FEEDBACK_URL };
