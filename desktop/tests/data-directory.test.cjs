const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { configuredDataDirectory } = require('../src/data-directory.cjs');

test('Windows and macOS direct/update relaunch retain the configured data location; explicit environment wins', () => {
  const appData = mkdtempSync(join(tmpdir(), 'xueness-launcher-config-'));
  try {
    mkdirSync(join(appData, 'Xueness'));
    const configured = join(appData, 'operator-data');
    writeFileSync(join(appData, 'Xueness/desktop-data-directory.json'), JSON.stringify({ apiVersion: 1, dataDirectory: configured }));
    assert.equal(configuredDataDirectory({ appData, platform: 'win32', env: {} }), configured);
    writeFileSync(join(appData, 'Xueness/desktop-data-directory.json'), '\uFEFF' + JSON.stringify({ apiVersion: 1, dataDirectory: configured }));
    assert.equal(configuredDataDirectory({ appData, platform: 'win32', env: {} }), configured);
    assert.equal(configuredDataDirectory({ appData, platform: 'win32', env: { XUENESS_DESKTOP_DATA: 'isolated-test' } }), resolve('isolated-test'));
    assert.equal(configuredDataDirectory({ appData, platform: 'darwin', env: {} }), configured);
    assert.equal(configuredDataDirectory({ appData, platform: 'darwin', env: { XUENESS_DESKTOP_DATA: 'isolated-test' } }), resolve('isolated-test'));
    assert.equal(configuredDataDirectory({ appData, platform: 'linux', env: {} }), null);
  } finally { assert.ok(resolve(appData).startsWith(resolve(tmpdir()))); rmSync(appData, { recursive: true, force: true }); }
});

test('missing, malformed, oversized or relative launcher preferences never change default data', () => {
  const appData = mkdtempSync(join(tmpdir(), 'xueness-launcher-invalid-'));
  try {
    for (const platform of ['win32', 'darwin']) assert.equal(configuredDataDirectory({ appData, platform, env: {} }), null);
    mkdirSync(join(appData, 'Xueness'));
    const file = join(appData, 'Xueness/desktop-data-directory.json');
    for (const text of ['{', 'x'.repeat(5000), JSON.stringify({ apiVersion: 2, dataDirectory: appData }),
                        JSON.stringify({ apiVersion: 1, dataDirectory: '../other' })]) {
      writeFileSync(file, text);
      for (const platform of ['win32', 'darwin']) assert.equal(configuredDataDirectory({ appData, platform, env: {} }), null);
    }
  } finally { assert.ok(resolve(appData).startsWith(resolve(tmpdir()))); rmSync(appData, { recursive: true, force: true }); }
});
