'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const fixturePath = path.resolve(__dirname, '../scripts/windows_update_fixture.cjs');
const { createFixtureBuildOptions } = require('../scripts/windows_update_fixture.cjs');
const winPath = path.win32;

function nativeWindowsRealpath(value) {
  return winPath.resolve(value).replace(/^C:\\Users\\RUNNER~1(?=\\|$)/i, 'C:\\Users\\runner');
}

test('NSIS --updated relaunch loads its isolated descriptor after Explorer drops fixture environment', async () => {
  let resolveOptions;
  const optionsCaptured = new Promise(resolve => { resolveOptions = resolve; });
  const autoUpdater = { quitAndInstall() {} };
  const fixtureRoot = 'C:\\Users\\runner\\AppData\\Local\\Temp\\xueness-nsis-update-test';
  const shortFixtureRoot = fixtureRoot.replace('C:\\Users\\runner', 'C:\\Users\\RUNNER~1');
  const appData = winPath.join(fixtureRoot, 'isolated-appdata', 'user-data');
  const report = winPath.join(fixtureRoot, 'update-report.json');
  const descriptorPath = winPath.join(fixtureRoot, 'update-smoke-config.json');
  const descriptor = JSON.stringify({
    fixtureRoot,
    appData,
    report,
    expectedVersion: '0.1.3',
  });
  let configuredUserData = null;
  const app = {
    setName() {},
    setPath(name, value) { if (name === 'userData') configuredUserData = value; },
    getPath() { throw new Error('The fixture must not fall back to app.getPath().'); },
    getVersion() { return '0.1.2'; },
    on() {},
    whenReady: () => Promise.resolve(),
    exit(code) { throw new Error(`Unexpected app exit ${code}`); },
  };
  const electronApi = { app };
  Object.defineProperty(electronApi, 'autoUpdater', {
    get() { throw new Error('The fixture accessed Electron native autoUpdater.'); },
  });
  const stubs = {
    electron: electronApi,
    'electron-updater': { autoUpdater },
    'node:path': winPath,
    'node:fs': {
      realpathSync: { native: nativeWindowsRealpath },
      mkdirSync() {},
      readFileSync(filePath) {
        assert.equal(winPath.resolve(filePath), winPath.resolve(descriptorPath));
        return descriptor;
      },
      writeFileSync() { throw new Error('Unexpected fixture file write.'); },
    },
    '../src/update-coordinator.cjs': {
      UpdateCoordinator: class {
        constructor(options) {
          this.options = options;
          resolveOptions(options);
        }
        status() { return { phase: 'checking' }; }
        setEnabled() { return Promise.resolve(); }
      },
    },
  };
  const fixtureModule = { exports: {} };
  function fixtureRequire(name) {
    if (!(name in stubs)) throw new Error(`Unexpected fixture import: ${name}`);
    return stubs[name];
  }
  fixtureRequire.main = fixtureModule;
  const fixtureProcess = {
    execPath: winPath.join(shortFixtureRoot, 'installed-app', 'Xueness.exe'),
    argv: [winPath.join(shortFixtureRoot, 'installed-app', 'Xueness.exe'), '--updated'],
    env: {},
    pid: 42,
    stderr: { write() {} },
    exitCode: 0,
  };

  vm.runInNewContext(fs.readFileSync(fixturePath, 'utf8'), {
    require: fixtureRequire,
    module: fixtureModule,
    process: fixtureProcess,
    __filename: winPath.join(fixtureRoot, 'installed-app', 'resources', 'app.asar', 'scripts', 'windows_update_fixture.cjs'),
    __dirname: winPath.join(fixtureRoot, 'installed-app', 'resources', 'app.asar', 'scripts'),
    setTimeout: () => ({}),
    clearTimeout() {},
    setInterval: () => ({}),
    clearInterval() {},
  }, { filename: fixturePath });

  let timeout;
  const options = await Promise.race([
    optionsCaptured,
    new Promise((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('Fixture did not construct its coordinator.')), 1000);
    }),
  ]);
  clearTimeout(timeout);
  assert.equal(options.app, app);
  assert.equal(options.autoUpdater, autoUpdater);
  assert.equal(options.autoDownload(), true);
  assert.equal(configuredUserData, appData);
});

test('restarted updated version verifies and reports preserved isolated data using only its descriptor', async () => {
  const fixtureRoot = 'C:\\Users\\runner\\AppData\\Local\\Temp\\xueness-nsis-update-relaunch';
  const shortFixtureRoot = fixtureRoot.replace('C:\\Users\\runner', 'C:\\Users\\RUNNER~1');
  const executable = winPath.join(shortFixtureRoot, 'installed-app', 'Xueness.exe');
  const appData = winPath.join(fixtureRoot, 'isolated-appdata', 'user-data');
  const reportPath = winPath.join(fixtureRoot, 'update-report.json');
  const descriptorPath = winPath.join(fixtureRoot, 'update-smoke-config.json');
  const configPath = winPath.join(appData, 'configs', 'desktop.json');
  const sessionPath = winPath.join(appData, 'sessions', 'fixture-session.json');
  const expectedConfig = { channel: 'stable', theme: 'dark', fixture: 'desktop-update-preserve' };
  const expectedSession = {
    id: 'windows-update-fixture-session',
    messages: [{ role: 'user', text: 'preserve this isolated session' }],
  };
  const descriptor = JSON.stringify({
    fixtureRoot,
    appData,
    report: reportPath,
    expectedVersion: '0.1.3',
  });
  let result;
  const app = {
    setName() {},
    setPath(name, value) { if (name === 'userData') assert.equal(value, appData); },
    getPath() { throw new Error('The fixture must not fall back to app.getPath().'); },
    getVersion() { return '0.1.3'; },
    on() {},
    whenReady: () => Promise.resolve(),
    exit(code) { assert.equal(code, 0); },
  };
  const electronApi = { app };
  Object.defineProperty(electronApi, 'autoUpdater', {
    get() { throw new Error('The fixture accessed Electron native autoUpdater.'); },
  });
  const stubs = {
    electron: electronApi,
    'electron-updater': { autoUpdater: { quitAndInstall() {} } },
    'node:path': winPath,
    'node:fs': {
      realpathSync: { native: nativeWindowsRealpath },
      mkdirSync() {},
      readFileSync(filePath) {
        const actual = winPath.resolve(filePath);
        if (actual === winPath.resolve(descriptorPath)) return descriptor;
        if (actual === winPath.resolve(configPath)) return JSON.stringify(expectedConfig);
        if (actual === winPath.resolve(sessionPath)) return JSON.stringify(expectedSession);
        throw new Error(`Unexpected fixture read: ${filePath}`);
      },
      writeFileSync(filePath, value) {
        assert.equal(winPath.resolve(filePath), winPath.resolve(reportPath));
        result = JSON.parse(value);
      },
    },
    '../src/update-coordinator.cjs': { UpdateCoordinator: class {} },
  };
  const fixtureModule = { exports: {} };
  function fixtureRequire(name) {
    if (!(name in stubs)) throw new Error(`Unexpected fixture import: ${name}`);
    return stubs[name];
  }
  fixtureRequire.main = fixtureModule;
  vm.runInNewContext(fs.readFileSync(fixturePath, 'utf8'), {
    require: fixtureRequire,
    module: fixtureModule,
    process: { execPath: executable, argv: [executable, '--updated'], env: {}, pid: 43, stderr: { write() {} }, exitCode: 0 },
    __filename: winPath.join(fixtureRoot, 'installed-app', 'resources', 'app.asar', 'scripts', 'windows_update_fixture.cjs'),
    __dirname: winPath.join(fixtureRoot, 'installed-app', 'resources', 'app.asar', 'scripts'),
  }, { filename: fixturePath });

  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    pid: 43,
    version: '0.1.3',
    stage: 'verified',
    preserved: true,
    config: expectedConfig,
    session: expectedSession,
  });
});

test('fixture reports startup failure and exits before loading Electron paths when descriptor is missing', () => {
  const fixtureRoot = 'C:\\Users\\runner\\AppData\\Local\\Temp\\xueness-nsis-update-missing';
  const source = fs.readFileSync(fixturePath, 'utf8');
  const fixtureModule = { exports: {} };
  const exitCodes = [];
  const stderr = [];
  const fixtureProcess = {
    execPath: path.win32.join(fixtureRoot, 'installed-app', 'Xueness.exe'),
    argv: [path.win32.join(fixtureRoot, 'installed-app', 'Xueness.exe'), '--updated'],
    env: {},
    stderr: { write(message) { stderr.push(message); } },
    exitCode: 0,
    exit(code) { exitCodes.push(code); },
  };
  function fixtureRequire(name) {
    if (name === 'node:path') return path.win32;
    if (name === 'node:fs') return {
      realpathSync: { native: nativeWindowsRealpath },
      readFileSync() {
        const error = new Error('missing descriptor');
        error.code = 'ENOENT';
        throw error;
      },
    };
    throw new Error(`Unexpected import before validating descriptor: ${name}`);
  }
  fixtureRequire.main = fixtureModule;

  vm.runInNewContext(source, {
    require: fixtureRequire,
    module: fixtureModule,
    process: fixtureProcess,
    __filename: fixturePath,
    __dirname: path.dirname(fixturePath),
  }, { filename: fixturePath });
  assert.equal(fixtureProcess.exitCode, 2);
  assert.deepEqual(exitCodes, [2]);
  assert.match(stderr.join(''), /descriptor is missing or invalid/);
});

test('fixture build writes a generic update feed without publishing artifacts', () => {
  const options = createFixtureBuildOptions(
    '/tmp/xueness-windows-fixture',
    '0.1.3',
    'http://127.0.0.1:12345/',
  );

  assert.equal(options.publish, 'never');
  assert.deepEqual(options.config.publish, [{ provider: 'generic', url: 'http://127.0.0.1:12345/' }]);
  assert.equal(options.config.extraMetadata.version, '0.1.3');
  assert.equal(options.config.extraMetadata.main, 'scripts/windows_update_fixture.cjs');
});
