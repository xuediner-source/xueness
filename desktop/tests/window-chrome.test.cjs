const test = require('node:test');
const assert = require('node:assert/strict');
const { getWindowChromeOptions, TITLEBAR_HEIGHT } = require('../src/window-chrome.cjs');

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
