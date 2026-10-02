const { isOwnedUrl } = require('./security.cjs');

function handleSecondInstance(argv, { quit, show }) {
  if (argv.includes('--quit')) quit();
  else show();
}

function createDesktopBackground({ app, window, Tray, Menu, ipcMain, iconPath, getOrigin, isQuitting, platform = process.platform }) {
  let tray = null, disposed = false;
  const show = () => {
    if (window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show(); window.focus();
  };
  const setEnabled = enabled => {
    if (disposed || platform !== 'win32') return;
    if (!enabled) {
      if (tray) { tray.destroy(); tray = null; if (!isQuitting()) show(); }
      return;
    }
    if (tray) return;
    try {
      tray = new Tray(iconPath);
      tray.setToolTip('Xueness · 关闭窗口后在后台运行');
      tray.setContextMenu(Menu.buildFromTemplate([
        { label: '打开 Xueness', click: show },
        { type: 'separator' },
        { label: '退出 Xueness', click: () => app.quit() },
      ]));
      tray.on('click', show);
      tray.on('double-click', show);
    } catch {
      // If the OS cannot create the tray, retain the ordinary close-to-quit path.
      tray?.destroy(); tray = null;
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
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    ipcMain.removeListener('xueness:desktop-background', policy);
    window.removeListener('close', close);
    tray?.destroy(); tray = null;
  };
  ipcMain.on('xueness:desktop-background', policy);
  window.on('close', close);
  window.once('closed', dispose);
  return { show, dispose };
}

module.exports = { createDesktopBackground, handleSecondInstance };
