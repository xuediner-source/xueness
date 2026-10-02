const TITLEBAR_HEIGHT = 40;

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

module.exports = { getWindowChromeOptions, TITLEBAR_HEIGHT };
