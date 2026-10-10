const TITLEBAR_HEIGHT = 40;
// Claudex appearance uses a 44px title bar on wide windows; any other value keeps 40.
const TITLEBAR_HEIGHTS = new Set([TITLEBAR_HEIGHT, 44]);
const MAC_TRAFFIC_LIGHT_X = 14;
// Native traffic lights are about 16px tall; keep them vertically centred.
const macTrafficLightPosition = height => ({ x: MAC_TRAFFIC_LIGHT_X, y: Math.round((height - 16) / 2) });
const { isOwnedUrl } = require('./security.cjs');

function installWindowThemeSync({ ipcMain, window, getOrigin, platform = process.platform }) {
  if (platform !== 'win32' && platform !== 'darwin') return;
  const channel = 'xueness:window-colors';
  let macHeight = TITLEBAR_HEIGHT;
  const apply = (event, colors) => {
    if (window.isDestroyed() || event.sender !== window.webContents
        || event.senderFrame !== window.webContents.mainFrame
        || !isOwnedUrl(event.senderFrame?.url, getOrigin())) return;
    if (!colors || typeof colors.color !== 'string' || typeof colors.symbolColor !== 'string'
        || !/^#[0-9a-f]{6}$/i.test(colors.color)
        || !/^#[0-9a-f]{6}$/i.test(colors.symbolColor)) return;
    const height = TITLEBAR_HEIGHTS.has(colors.height) ? colors.height : TITLEBAR_HEIGHT;
    // Electron supports live overlay styling on Windows. macOS keeps its native
    // traffic lights and uses the window background behind the controls; only
    // their vertical position follows the active title bar height.
    if (platform === 'win32') {
      window.setTitleBarOverlay({ color: colors.color, symbolColor: colors.symbolColor, height });
    } else if (height !== macHeight && typeof window.setWindowButtonPosition === 'function') {
      macHeight = height;
      window.setWindowButtonPosition(macTrafficLightPosition(height));
    }
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
      trafficLightPosition: macTrafficLightPosition(TITLEBAR_HEIGHT),
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

module.exports = { getWindowChromeOptions, installWindowThemeSync, TITLEBAR_HEIGHT, macTrafficLightPosition };
