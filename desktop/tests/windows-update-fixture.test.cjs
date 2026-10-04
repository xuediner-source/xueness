'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const fixturePath = path.resolve(__dirname, '../scripts/windows_update_fixture.cjs');
const { createFixtureBuildOptions, loadSmokeConfig } = require('../scripts/windows_update_fixture.cjs');
const winPath = path.win32;
const fixtureId = '12345678-1234-4abc-8def-1234567890ab';
const fixtureExecutableName = `xueness-update-smoke-${fixtureId}`;

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
  const isolatedAppData = winPath.join(fixtureRoot, 'isolated-appdata');
  const isolatedLocalAppData = winPath.join(fixtureRoot, 'LocalAppData');
  const report = winPath.join(fixtureRoot, 'update-report.json');
  const descriptorPath = winPath.join(fixtureRoot, 'update-smoke-config.json');
  const runtimeLogPath = winPath.join(fixtureRoot, 'fixture-runtime.jsonl');
  const descriptor = JSON.stringify({
    fixtureRoot,
    appData,
    report,
    expectedVersion: '0.1.3',
  });
  const configuredPaths = {};
  let configuredName = null;
  const runtimeLogs = [];
  const app = {
    setName(value) { configuredName = value; },
    setPath(name, value) { configuredPaths[name] = value; },
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
      appendFileSync(filePath, value) {
        assert.equal(winPath.resolve(filePath), winPath.resolve(runtimeLogPath));
        runtimeLogs.push(String(value));
      },
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
    execPath: winPath.join(shortFixtureRoot, 'installed-app', `${fixtureExecutableName}.exe`),
    argv: [winPath.join(shortFixtureRoot, 'installed-app', `${fixtureExecutableName}.exe`), '--updated'],
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
  assert.equal(configuredName, 'Xueness Update Smoke');
  assert.equal(configuredPaths.userData, appData);
  assert.equal(configuredPaths.appData, isolatedAppData);
  assert.equal(fixtureProcess.env.APPDATA, isolatedAppData);
  assert.equal(fixtureProcess.env.LOCALAPPDATA, isolatedLocalAppData);
  const startupLog = JSON.parse(runtimeLogs[0]);
  assert.equal(startupLog.event, 'startup');
  assert.equal(startupLog.executable, fixtureProcess.execPath);
  assert.deepEqual(startupLog.argv, fixtureProcess.argv);
  assert.equal(startupLog.appData, appData);
  assert.equal(typeof autoUpdater.logger.info, 'function');
});

test('restarted updated version verifies and reports preserved isolated data using only its descriptor', async () => {
  const fixtureRoot = 'C:\\Users\\runner\\AppData\\Local\\Temp\\xueness-nsis-update-relaunch';
  const shortFixtureRoot = fixtureRoot.replace('C:\\Users\\runner', 'C:\\Users\\RUNNER~1');
  const executable = winPath.join(shortFixtureRoot, 'installed-app', `${fixtureExecutableName}.exe`);
  const appData = winPath.join(fixtureRoot, 'isolated-appdata', 'user-data');
  const isolatedAppData = winPath.join(fixtureRoot, 'isolated-appdata');
  const isolatedLocalAppData = winPath.join(fixtureRoot, 'LocalAppData');
  const reportPath = winPath.join(fixtureRoot, 'update-report.json');
  const descriptorPath = winPath.join(fixtureRoot, 'update-smoke-config.json');
  const runtimeLogPath = winPath.join(fixtureRoot, 'fixture-runtime.jsonl');
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
  const runtimeLogs = [];
  const configuredPaths = {};
  const app = {
    setName() {},
    setPath(name, value) { configuredPaths[name] = value; },
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
      appendFileSync(filePath, value) {
        assert.equal(winPath.resolve(filePath), winPath.resolve(runtimeLogPath));
        runtimeLogs.push(String(value));
      },
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
  const fixtureProcess = {
    execPath: executable,
    argv: [executable, '--updated'],
    env: {},
    pid: 43,
    stderr: { write() {} },
    exitCode: 0,
  };
  function fixtureRequire(name) {
    if (!(name in stubs)) throw new Error(`Unexpected fixture import: ${name}`);
    return stubs[name];
  }
  fixtureRequire.main = fixtureModule;
  vm.runInNewContext(fs.readFileSync(fixturePath, 'utf8'), {
    require: fixtureRequire,
    module: fixtureModule,
    process: fixtureProcess,
    __filename: winPath.join(fixtureRoot, 'installed-app', 'resources', 'app.asar', 'scripts', 'windows_update_fixture.cjs'),
    __dirname: winPath.join(fixtureRoot, 'installed-app', 'resources', 'app.asar', 'scripts'),
  }, { filename: fixturePath });

  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    pid: 43,
    version: '0.1.3',
    executable,
    argv: [executable, '--updated'],
    stage: 'verified',
    preserved: true,
    config: expectedConfig,
    session: expectedSession,
  });
  assert.equal(configuredPaths.userData, appData);
  assert.equal(configuredPaths.appData, isolatedAppData);
  assert.equal(fixtureProcess.env.APPDATA, isolatedAppData);
  assert.equal(fixtureProcess.env.LOCALAPPDATA, isolatedLocalAppData);
  const startupLog = JSON.parse(runtimeLogs[0]);
  assert.equal(startupLog.event, 'startup');
  assert.equal(startupLog.executable, executable);
  assert.deepEqual(startupLog.argv, [executable, '--updated']);
});

test('fixture rejects descriptor paths that escape its isolated root', () => {
  const fixtureRoot = 'C:\\Users\\runner\\AppData\\Local\\Temp\\xueness-nsis-update-paths';
  const executablePath = winPath.join(fixtureRoot, 'installed-app', `${fixtureExecutableName}.exe`);
  const descriptorPath = winPath.join(fixtureRoot, 'update-smoke-config.json');
  const expectedAppData = winPath.join(fixtureRoot, 'isolated-appdata', 'user-data');
  const expectedReport = winPath.join(fixtureRoot, 'update-report.json');

  for (const field of ['fixtureRoot', 'appData', 'report']) {
    const descriptor = {
      fixtureRoot,
      appData: expectedAppData,
      report: expectedReport,
      expectedVersion: '0.1.3',
    };
    descriptor[field] = winPath.resolve(fixtureRoot, '..', `outside-${field}`);
    assert.throws(() => loadSmokeConfig({
      fsApi: {
        realpathSync: { native: nativeWindowsRealpath },
        readFileSync(filePath) {
          assert.equal(winPath.resolve(filePath), winPath.resolve(descriptorPath));
          return JSON.stringify(descriptor);
        },
      },
      pathApi: winPath,
      executablePath,
    }), /unsafe or invalid paths\/version/, `accepted escaping ${field}`);
  }
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
  const baseOptions = createFixtureBuildOptions(
    '/tmp/xueness-windows-fixture',
    '0.1.2',
    'http://127.0.0.1:12345/',
    fixtureId,
  );
  const updateOptions = createFixtureBuildOptions(
    '/tmp/xueness-windows-fixture-update',
    '0.1.3',
    'http://127.0.0.1:12345/',
    fixtureId,
  );

  assert.equal(baseOptions.publish, 'never');
  assert.deepEqual(baseOptions.config.publish, [{ provider: 'generic', url: 'http://127.0.0.1:12345/' }]);
  assert.equal(baseOptions.config.extraMetadata.version, '0.1.2');
  assert.equal(baseOptions.config.extraMetadata.main, 'scripts/windows_update_fixture.cjs');
  assert.equal(baseOptions.config.appId, `app.xueness.update-smoke.${fixtureId}`);
  assert.notEqual(baseOptions.config.appId, 'app.xueness.desktop');
  assert.equal(baseOptions.config.nsis.guid, fixtureId);
  assert.equal(updateOptions.config.nsis.guid, fixtureId);
  assert.equal(baseOptions.config.executableName, fixtureExecutableName);
  assert.equal(updateOptions.config.executableName, fixtureExecutableName);
  assert.equal(baseOptions.config.extraMetadata.name, fixtureExecutableName);
  assert.equal(updateOptions.config.extraMetadata.name, fixtureExecutableName);
  assert.notEqual(baseOptions.config.executableName, 'Xueness');
  assert.deepEqual(
    {
      appId: baseOptions.config.appId,
      nsisGuid: baseOptions.config.nsis.guid,
      productName: baseOptions.config.productName,
      executableName: baseOptions.config.executableName,
      packageName: baseOptions.config.extraMetadata.name,
    },
    {
      appId: updateOptions.config.appId,
      nsisGuid: updateOptions.config.nsis.guid,
      productName: updateOptions.config.productName,
      executableName: updateOptions.config.executableName,
      packageName: updateOptions.config.extraMetadata.name,
    },
  );
});

test('fixture build refuses a missing or malformed isolated NSIS GUID', () => {
  const args = ['/tmp/xueness-windows-fixture', '0.1.3', 'http://127.0.0.1:12345/'];
  assert.throws(() => createFixtureBuildOptions(...args), /unique fixture GUID/);
  assert.throws(() => createFixtureBuildOptions(...args, 'not-a-guid'), /unique fixture GUID/);
});

test('fixture build refuses the production NSIS UUID5', () => {
  assert.throws(() => createFixtureBuildOptions(
    '/tmp/xueness-windows-fixture',
    '0.1.3',
    'http://127.0.0.1:12345/',
    '0f0cf9de-33f1-5222-adc2-93f449d81860',
  ), /unique fixture GUID/);
});
