const { isOwnedUrl } = require('./security.cjs');
const { createTrayMenuHost, normalizeTrayState } = require('./tray-menu.cjs');

function handleSecondInstance(argv, { quit, show }) {
  if (argv.includes('--quit')) quit();
  else show();
}

function createDesktopBackground({ app, window, Tray, Menu, ipcMain, iconPath, getOrigin, isQuitting,
  BrowserWindow, screen, getBackend, shell, platform = process.platform }) {
  let tray = null, disposed = false;
  let menuHost, latestTrayState;
  const show = () => {
    menuHost?.hide();
    if (window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show(); window.focus();
  };
  const setEnabled = enabled => {
    if (disposed || platform !== 'win32') return;
    if (!enabled) {
      menuHost?.dispose(); menuHost = undefined;
      if (tray) { tray.destroy(); tray = null; if (!isQuitting()) show(); }
      return;
    }
    if (tray) return;
    try {
      tray = new Tray(iconPath);
      tray.setToolTip('Xueness · 关闭窗口后在后台运行');
      const fallbackMenu = Menu.buildFromTemplate([
        { label: '打开 Xueness', click: show },
        { type: 'separator' },
        { label: '退出 Xueness', click: () => app.quit() },
      ]);
      if (BrowserWindow && screen && getBackend && shell) {
        menuHost ??= createTrayMenuHost({ app, BrowserWindow, screen, ipcMain, mainWindow: window, getBackend, shell,
          isEnabled: () => Boolean(tray) && !disposed && !isQuitting(), showMain: show });
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
    if (tray && !isQuitting()) { event.preventDefault(); window.hide(); }
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
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    ipcMain.removeListener('xueness:desktop-background', policy);
    ipcMain.removeListener('xueness:desktop-tray-state', trayState);
    window.removeListener('close', close);
    tray?.destroy(); tray = null;
    menuHost?.dispose();
    latestTrayState = undefined;
  };
  ipcMain.on('xueness:desktop-background', policy);
  ipcMain.on('xueness:desktop-tray-state', trayState);
  window.on('close', close);
  window.once('closed', dispose);
  return { show, dispose };
}

module.exports = { createDesktopBackground, handleSecondInstance };
