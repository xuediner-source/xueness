'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const fixturePath = path.resolve(__dirname, '../scripts/windows_update_fixture.cjs');
const { createFixtureBuildOptions } = require('../scripts/windows_update_fixture.cjs');

test('fixture entry wires electron-updater into the production coordinator', async () => {
  let resolveOptions;
  const optionsCaptured = new Promise(resolve => { resolveOptions = resolve; });
  const autoUpdater = { quitAndInstall() {} };
  const app = {
    setName() {},
    setPath() {},
    getPath() { return '/isolated/user-data'; },
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
    'node:path': path,
    'node:fs': {
      mkdirSync() {},
      readFileSync() { throw new Error('Unexpected fixture file read.'); },
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
    argv: [process.execPath, fixturePath],
    env: {
      XUENESS_UPDATE_SMOKE_APPDATA: '/isolated/app-data',
      XUENESS_UPDATE_SMOKE_REPORT: '/isolated/report.json',
      XUENESS_UPDATE_SMOKE_EXPECTED_VERSION: '0.1.3',
    },
    stderr: { write() {} },
    exitCode: 0,
  };

  vm.runInNewContext(fs.readFileSync(fixturePath, 'utf8'), {
    require: fixtureRequire,
    module: fixtureModule,
    process: fixtureProcess,
    __filename: fixturePath,
    __dirname: path.dirname(fixturePath),
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
