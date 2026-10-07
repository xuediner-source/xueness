const { isOwnedUrl } = require('./security.cjs');
const { createTrayMenuHost, normalizeTrayState } = require('./tray-menu.cjs');

function handleSecondInstance(argv, { quit, show }) {
  if (argv.includes('--quit')) quit();
  else show();
}

function createDesktopBackground({ app, window, Tray, Menu, ipcMain, iconPath, getOrigin, isQuitting,
  BrowserWindow, screen, getBackend, shell, getLocale = () => 'zh', platform = process.platform }) {
  let tray = null, dockMenu = null, disposed = false, dockEnabled = false;
  let menuHost, latestTrayState, fallbackMenu;
  const show = () => {
    menuHost?.hide();
    if (window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show(); window.focus();
  };
  const currentLocale = () => {
    if (latestTrayState?.locale === 'en' || latestTrayState?.locale === 'zh') return latestTrayState.locale;
    try { return getLocale() === 'en' ? 'en' : 'zh'; } catch { return 'zh'; }
  };
  const labels = () => currentLocale() === 'en'
    ? { open: 'Open Xueness', tasks: 'Tasks and projects', quit: 'Quit Xueness', tooltip: 'Xueness · keeps running when the window closes' }
    : { open: '打开 Xueness', tasks: '任务与项目', quit: '退出 Xueness', tooltip: 'Xueness · 关闭窗口后在后台运行' };
  const buildFallbackMenu = () => {
    const copy = labels();
    return Menu.buildFromTemplate([
      { label: copy.open, click: show },
      { type: 'separator' },
      { label: copy.quit, click: () => app.quit() },
    ]);
  };
  const makeMenuHost = isEnabled => createTrayMenuHost({ app, BrowserWindow, screen, ipcMain, mainWindow: window, getBackend, shell,
    isEnabled, showMain: show });
  const syncWindowsLabels = () => {
    if (!tray) return;
    const copy = labels();
    try { tray.setToolTip(copy.tooltip); } catch {}
    try {
      fallbackMenu = buildFallbackMenu();
      if (!menuHost) tray.setContextMenu(fallbackMenu);
    } catch {}
  };
  const dockAnchor = () => {
    if (!screen || typeof screen.getDisplayMatching !== 'function') return null;
    try {
      const point = screen.getCursorScreenPoint?.();
      if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) {
        return { x: point.x, y: point.y, width: 1, height: 1 };
      }
    } catch { /* Fall back to the live workbench window bounds. */ }
    try {
      if (window.isDestroyed() || typeof window.getBounds !== 'function') return null;
      const bounds = window.getBounds();
      if ([bounds?.x, bounds?.y, bounds?.width, bounds?.height].every(Number.isFinite)
          && bounds.width > 0 && bounds.height > 0) return bounds;
    } catch { /* A stale or unavailable window is not a usable anchor. */ }
    return null;
  };
  const clearDockMenu = () => {
    dockEnabled = false;
    menuHost?.dispose(); menuHost = undefined;
    dockMenu = null;
    try { app?.dock?.setMenu?.(null); } catch {}
  };
  const openDockTasks = () => {
    if (!dockEnabled || disposed || !menuHost || isQuitting() || window.isDestroyed()) return;
    const anchor = dockAnchor();
    if (!anchor) return;
    void menuHost.open(anchor).catch(() => {});
  };
  const buildDockMenu = () => {
    const copy = labels();
    return Menu.buildFromTemplate([
      { label: copy.open, click: show },
      { label: copy.tasks, click: openDockTasks },
      { type: 'separator' },
      { label: copy.quit, click: () => app.quit() },
    ]);
  };
  const syncDockMenu = () => {
    if (!dockEnabled || !app?.dock?.setMenu || !Menu?.buildFromTemplate) return;
    try {
      dockMenu = buildDockMenu();
      app.dock.setMenu(dockMenu);
    } catch { clearDockMenu(); }
  };
  const setEnabled = enabled => {
    if (disposed) return;
    if (platform === 'darwin') {
      const dock = app?.dock;
      if (!dock || typeof dock.setMenu !== 'function' || !screen
          || typeof screen.getDisplayMatching !== 'function' || !Menu?.buildFromTemplate
          || !BrowserWindow || !getBackend || !shell) {
        if (dockEnabled) clearDockMenu();
        return;
      }
      if (!enabled) { clearDockMenu(); return; }
      if (dockEnabled) { syncDockMenu(); return; }
      try {
        menuHost ??= makeMenuHost(() => dockEnabled && !disposed && !isQuitting());
        if (latestTrayState) menuHost.setState(latestTrayState);
        dockMenu = buildDockMenu();
        dock.setMenu(dockMenu);
        dockEnabled = true;
      } catch { clearDockMenu(); }
      return;
    }
    if (platform !== 'win32') return;
    if (!enabled) {
      menuHost?.dispose(); menuHost = undefined;
      if (tray) { tray.destroy(); tray = null; if (!isQuitting()) show(); }
      return;
    }
    if (tray) return;
    try {
      tray = new Tray(iconPath);
      fallbackMenu = buildFallbackMenu();
      tray.setToolTip(labels().tooltip);
      if (BrowserWindow && screen && getBackend && shell) {
        menuHost ??= makeMenuHost(() => Boolean(tray) && !disposed && !isQuitting());
        if (latestTrayState) menuHost.setState(latestTrayState);
        const currentTray = tray, currentHost = menuHost;
        tray.on('right-click', () => { void currentHost.open(currentTray.getBounds()).catch(() => {
          if (tray === currentTray && !disposed) currentTray.popUpContextMenu(fallbackMenu);
        }); });
      } else tray.setContextMenu(fallbackMenu);
      tray.on('click', show);
      tray.on('double-click', show);
    } catch {
      // If the OS cannot create the tray, retain the ordinary close-to-quit path.
      tray?.destroy(); tray = null;
      menuHost?.dispose(); menuHost = undefined;
    }
  };
  const close = event => {
    // Windows offers close-to-tray. macOS keeps its normal close-to-Dock behavior.
    if (platform === 'win32' && tray && !isQuitting()) { event.preventDefault(); window.hide(); }
  };
  const policy = (event, enabled) => {
    if (disposed || window.isDestroyed() || event.sender !== window.webContents
        || event.senderFrame !== window.webContents.mainFrame
        || !isOwnedUrl(event.senderFrame?.url, getOrigin()) || typeof enabled !== 'boolean') return;
    setEnabled(enabled);
  };
  const trayState = (event, value) => {
    if (disposed || window.isDestroyed() || event.sender !== window.webContents
      || event.senderFrame !== window.webContents.mainFrame || !isOwnedUrl(event.senderFrame?.url, getOrigin())) return;
    const next = normalizeTrayState(value);
    if (!next) return;
    latestTrayState = next;
    menuHost?.setState(next);
    if (platform === 'darwin') syncDockMenu();
    else if (platform === 'win32') syncWindowsLabels();
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    ipcMain.removeListener('xueness:desktop-background', policy);
    ipcMain.removeListener('xueness:desktop-tray-state', trayState);
    window.removeListener('close', close);
    tray?.destroy(); tray = null;
    if (platform === 'darwin') clearDockMenu();
    else { menuHost?.dispose(); menuHost = undefined; }
    latestTrayState = undefined;
  };
  ipcMain.on('xueness:desktop-background', policy);
  ipcMain.on('xueness:desktop-tray-state', trayState);
  window.on('close', close);
  window.once('closed', dispose);
  return { show, dispose };
}

module.exports = { createDesktopBackground, handleSecondInstance };
