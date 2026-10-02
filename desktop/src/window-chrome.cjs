const TITLEBAR_HEIGHT = 40;
const { isOwnedUrl } = require('./security.cjs');

function installWindowThemeSync({ ipcMain, window, getOrigin, platform = process.platform }) {
  if (platform !== 'win32') return;
  const channel = 'xueness:window-colors';
  const apply = (event, colors) => {
    if (window.isDestroyed() || event.sender !== window.webContents
        || event.senderFrame !== window.webContents.mainFrame
        || !isOwnedUrl(event.senderFrame?.url, getOrigin())) return;
    if (!colors || typeof colors.color !== 'string' || typeof colors.symbolColor !== 'string'
        || !/^#[0-9a-f]{6}$/i.test(colors.color)
        || !/^#[0-9a-f]{6}$/i.test(colors.symbolColor)) return;
    window.setTitleBarOverlay({ color: colors.color, symbolColor: colors.symbolColor, height: TITLEBAR_HEIGHT });
    window.setBackgroundColor(colors.color);
  };
  ipcMain.on(channel, apply);
  window.once('closed', () => ipcMain.removeListener(channel, apply));
}

function getWindowChromeOptions(platform) {
  if (platform === 'darwin') {
    return {
      titleBarStyle: 'hidden',
      titleBarOverlay: true,
      trafficLightPosition: { x: 14, y: 12 },
    };
  }

  if (platform === 'win32') {
    return {
      titleBarStyle: 'hidden',
      titleBarOverlay: {
        color: '#171717',
        symbolColor: '#f4f4f5',
        height: TITLEBAR_HEIGHT,
      },
      autoHideMenuBar: true,
    };
  }

  return {};
}

module.exports = { getWindowChromeOptions, installWindowThemeSync, TITLEBAR_HEIGHT };
