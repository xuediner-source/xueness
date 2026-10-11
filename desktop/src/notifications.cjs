// OS notifications for `desktop.notifications`. The renderer publishes bounded
// requests through `window-theme-preload.cjs`; this module validates them again
// in the main process, shows Electron notifications and focuses the main window
// when one is clicked. No Electron API is required at module load: everything
// is injected, so tests can drive the same path without Electron.
const { isOwnedUrl } = require('./security.cjs');

const SESSION_ID = /^[a-f0-9]{32}$/;
const KINDS = ['approval', 'question', 'failed', 'completed'];
const MAX_ITEMS = 5;
const TITLE_LIMIT = 180;
const clean = (value, limit) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, limit) : '';

// Labels mirror the native tray copy: zh/en dictionaries owned by the desktop
// plugin, selected by the locale published with each request.
const LABELS = {
  approval: {
    zh: { title: '等待你的审批', body: title => `「${title}」请求批准一个操作` },
    en: { title: 'Approval needed', body: title => `"${title}" is waiting for your approval` },
  },
  question: {
    zh: { title: '等待你的回答', body: title => `「${title}」提出了一个问题` },
    en: { title: 'Answer needed', body: title => `"${title}" asked a question` },
  },
  failed: {
    zh: { title: '运行失败', body: title => `「${title}」运行失败，点击查看` },
    en: { title: 'Run failed', body: title => `"${title}" failed. Click to open` },
  },
  completed: {
    zh: { title: '运行完成', body: title => `「${title}」已完成` },
    en: { title: 'Run completed', body: title => `"${title}" completed` },
  },
};

function normalizeNotifyRequest(value) {
  if (!value || typeof value !== 'object' || !['zh', 'en'].includes(value.locale)) return null;
  if (!Number.isSafeInteger(value.seq) || value.seq <= 0) return null;
  if (!Array.isArray(value.items) || value.items.length === 0 || value.items.length > MAX_ITEMS) return null;
  const items = [];
  const seen = new Set();
  for (const item of value.items) {
    if (!item || typeof item !== 'object' || !KINDS.includes(item.kind)) continue;
    const id = typeof item.sessionId === 'string' && SESSION_ID.test(item.sessionId) ? item.sessionId : null;
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    const title = clean(item.sessionTitle, TITLE_LIMIT);
    // The renderer always publishes a title (session title, task or id).
    // A request without one is out of contract and dropped whole.
    if (!title) continue;
    items.push({ kind: item.kind, sessionId: id, sessionTitle: title });
  }
  if (items.length === 0) return null;
  return { seq: value.seq, locale: value.locale, items };
}

function createDesktopNotifications({ app, Notification, ipcMain, getWindow, getOrigin, showMain, platform = process.platform }) {
  let disposed = false, lastSeq = 0;
  // Windows notifications need an App User Model ID registered with the
  // packaged app; a missing setter (test fixtures) only skips this step.
  if (platform === 'win32' && typeof app?.setAppUserModelId === 'function') {
    try { app.setAppUserModelId(app.isPackaged ? 'app.xueness.desktop' : process.execPath); } catch { /* keep the default id */ }
  }
  const show = request => {
    for (const item of request.items) {
      const label = LABELS[item.kind][request.locale];
      let notification;
      try {
        notification = new Notification({ title: label.title, body: label.body(item.sessionTitle) });
      } catch { return; }
      notification.on('click', () => {
        try { notification.close(); } catch { /* already closed */ }
        const target = item.sessionId;
        if (target) {
          const window = getWindow();
          // Reuse the tray command bridge: the workbench selects the session
          // when sessions are effective and the window is not busy elsewhere.
          if (window && !window.isDestroyed()) window.webContents.send('xueness:desktop-command', { kind: 'session', id: target });
        }
        if (typeof showMain === 'function') showMain();
      });
      notification.show();
    }
  };
  const request = (event, value) => {
    if (disposed) return;
    const window = getWindow();
    if (!window || window.isDestroyed() || event.sender !== window.webContents
        || event.senderFrame !== window.webContents.mainFrame
        || !isOwnedUrl(event.senderFrame?.url, getOrigin())) return;
    const normalized = normalizeNotifyRequest(value);
    // `seq` is the renderer's strictly increasing request stamp (ms, bumped by
    // one on collisions). Anything not newer is a stale replay.
    if (!normalized || normalized.seq <= lastSeq) return;
    if (!Notification) return;
    lastSeq = normalized.seq;
    show(normalized);
  };
  ipcMain.on('xueness:desktop-notify', request);
  return {
    dispose() {
      disposed = true;
      ipcMain.removeListener('xueness:desktop-notify', request);
    },
  };
}

module.exports = { createDesktopNotifications, normalizeNotifyRequest, LABELS };
