'use strict';

const { join, resolve } = require('node:path');

async function buildFixture() {
  const [outputDir, version, feedUrl, fixtureId] = process.argv.slice(3);
  if (!outputDir || !/^\d+\.\d+\.\d+$/.test(version || '') || !feedUrl) {
    throw new Error('Usage: windows_update_fixture.cjs --build-fixture OUTPUT VERSION LOOPBACK_FEED_URL FIXTURE_GUID');
  }
  const { Arch, Platform, build } = require('electron-builder');
  await build({
    projectDir: resolve(__dirname, '..'),
    targets: Platform.WINDOWS.createTarget('nsis', Arch.x64),
    ...createFixtureBuildOptions(outputDir, version, feedUrl, fixtureId),
  });
}

function createFixtureBuildOptions(outputDir, version, feedUrl, fixtureId) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(fixtureId || '')) {
    throw new Error('A unique fixture GUID is required before building an NSIS test installer.');
  }
  const name = 'xueness-update-smoke-' + fixtureId;
  return {
    // CI auto-publish detection must never upload this disposable fixture.
    publish: 'never',
    config: {
      // Do not inherit the product's GitHub release publisher into this test app.
      extends: null,
      // NSIS reads HKCU/HKLM, regardless of APPDATA or /D. Both versions share
      // this run's identity, never the product's registration or process name.
      appId: 'app.xueness.update-smoke.' + fixtureId,
      productName: 'Xueness Update Smoke',
      executableName: name,
      asar: true,
      directories: { output: resolve(outputDir) },
      files: [
        'scripts/windows_update_fixture.cjs',
        'src/update-coordinator.cjs',
        'package.json',
      ],
      extraMetadata: { name, main: 'scripts/windows_update_fixture.cjs', version },
      publish: [{ provider: 'generic', url: feedUrl }],
      win: {
        target: ['nsis'],
        artifactName: 'Xueness-${version}-windows-${arch}-setup.${ext}',
      },
      nsis: {
        guid: fixtureId,
        oneClick: false,
        allowToChangeInstallationDirectory: true,
        perMachine: false,
        createDesktopShortcut: false,
        createStartMenuShortcut: false,
        deleteAppDataOnUninstall: false,
        artifactName: 'Xueness-${version}-windows-${arch}-setup.${ext}',
      },
    },
  };
}

function resolveRuntimeDependencies(electronApi, electronUpdaterApi) {
  return {
    app: electronApi.app,
    autoUpdater: electronUpdaterApi.autoUpdater,
  };
}

function loadRuntimeDependencies() {
  return resolveRuntimeDependencies(require('electron'), require('electron-updater'));
}

function canonicalExistingPath(fsApi, pathApi, value) {
  const realpath = fsApi.realpathSync?.native;
  if (typeof realpath !== 'function') throw new Error('Windows update fixture path verification is unavailable.');
  let current = pathApi.resolve(value);
  const remaining = [];
  while (true) {
    try {
      return pathApi.resolve(realpath(current), ...remaining.reverse());
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error?.code)) throw error;
      const parent = pathApi.dirname(current);
      if (parent === current) throw error;
      remaining.push(pathApi.basename(current));
      current = parent;
    }
  }
}

function comparablePath(value, pathApi) {
  let normalized = pathApi.resolve(value);
  normalized = normalized.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '');
  return normalized.replace(/[\\/]+$/, '').toLowerCase();
}

function loadSmokeConfig({
  fsApi = require('node:fs'),
  pathApi = require('node:path'),
  executablePath = process.execPath,
} = {}) {
  const fixtureRoot = canonicalExistingPath(
    fsApi,
    pathApi,
    pathApi.resolve(pathApi.dirname(pathApi.resolve(executablePath)), '..'),
  );
  const descriptorPath = pathApi.join(fixtureRoot, 'update-smoke-config.json');
  let config;
  try {
    config = JSON.parse(fsApi.readFileSync(descriptorPath, 'utf8'));
  } catch (error) {
    throw new Error('Windows update fixture descriptor is missing or invalid.');
  }

  const expectedAppData = pathApi.join(fixtureRoot, 'isolated-appdata', 'user-data');
  const expectedReport = pathApi.join(fixtureRoot, 'update-report.json');
  if (!config || typeof config !== 'object' || Array.isArray(config)
    || typeof config.fixtureRoot !== 'string'
    || typeof config.appData !== 'string'
    || typeof config.report !== 'string'
    || comparablePath(canonicalExistingPath(fsApi, pathApi, config.fixtureRoot), pathApi)
      !== comparablePath(fixtureRoot, pathApi)
    || comparablePath(canonicalExistingPath(fsApi, pathApi, config.appData), pathApi)
      !== comparablePath(expectedAppData, pathApi)
    || comparablePath(canonicalExistingPath(fsApi, pathApi, config.report), pathApi)
      !== comparablePath(expectedReport, pathApi)
    || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(config.expectedVersion || '')) {
    throw new Error('Windows update fixture descriptor contains unsafe or invalid paths/version.');
  }
  return {
    fixtureRoot,
    appData: expectedAppData,
    report: expectedReport,
    expectedVersion: config.expectedVersion,
  };
}

function runFixture() {
  const smoke = loadSmokeConfig();
  // Explorer's --updated relaunch need not inherit the launcher's environment.
  process.env.APPDATA = join(smoke.fixtureRoot, 'isolated-appdata');
  process.env.LOCALAPPDATA = join(smoke.fixtureRoot, 'LocalAppData');
  const { app, autoUpdater } = loadRuntimeDependencies();
  const { appendFileSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
  const { UpdateCoordinator } = require('../src/update-coordinator.cjs');

  app.setName('Xueness Update Smoke');
  const appData = smoke.appData;
  mkdirSync(appData, { recursive: true });
  app.setPath('userData', appData);
  app.setPath('appData', process.env.APPDATA);
  const runtimeLog = join(smoke.fixtureRoot, 'fixture-runtime.jsonl');
  const log = value => appendFileSync(runtimeLog, JSON.stringify({ time: new Date().toISOString(), pid: process.pid, ...value }) + '\n');
  log({ event: 'startup', executable: process.execPath, argv: process.argv, version: app.getVersion(), appData });
  app.on('will-quit', () => log({ event: 'will-quit' }));
  autoUpdater.logger = Object.fromEntries(['info', 'warn', 'error', 'debug'].map(level =>
    [level, (...values) => log({ event: 'updater-log', level, message: values.map(String).join(' ') })]));

  const reportPath = smoke.report;
  const expectedVersion = smoke.expectedVersion;
  const configPath = join(appData, 'configs', 'desktop.json');
  const sessionPath = join(appData, 'sessions', 'fixture-session.json');
  const configSeed = { channel: 'stable', theme: 'dark', fixture: 'desktop-update-preserve' };
  const sessionSeed = {
    id: 'windows-update-fixture-session',
    messages: [{ role: 'user', text: 'preserve this isolated session' }],
  };

  function report(value) {
    mkdirSync(require('node:path').dirname(reportPath), { recursive: true });
    const result = { pid: process.pid, version: app.getVersion(), executable: process.execPath, argv: process.argv, ...value };
    log({ event: 'report', ...result });
    writeFileSync(reportPath, JSON.stringify(result));
  }

  function finish(code, value) {
    report(value);
    app.exit(code);
  }

  function readJson(path) {
    try { return JSON.parse(readFileSync(path, 'utf8')); }
    catch { return null; }
  }

  let coordinator;
  app.on('before-quit', () => { void coordinator?.dispose(); });

  app.whenReady().then(async () => {
    if (process.argv.includes('--seed')) {
      mkdirSync(join(appData, 'configs'), { recursive: true });
      mkdirSync(join(appData, 'sessions'), { recursive: true });
      writeFileSync(configPath, JSON.stringify(configSeed));
      writeFileSync(sessionPath, JSON.stringify(sessionSeed));
      finish(0, { stage: 'seeded' });
      return;
    }

    if (app.getVersion() === expectedVersion && expectedVersion) {
      const config = readJson(configPath);
      const session = readJson(sessionPath);
      const preserved = JSON.stringify(config) === JSON.stringify(configSeed)
        && JSON.stringify(session) === JSON.stringify(sessionSeed);
      finish(preserved ? 0 : 1, { stage: 'verified', preserved, config, session });
      return;
    }

    if (!expectedVersion) {
      finish(2, { stage: 'error', reason: 'The isolated update smoke configuration is incomplete.' });
      return;
    }

    let installStarted = false;
    let completed = false;
    let poll;
    let timeout;
    const fail = reason => {
      if (completed) return;
      completed = true;
      clearInterval(poll);
      clearTimeout(timeout);
      finish(1, { stage: 'error', reason: String(reason).slice(0, 1000), state: coordinator?.status() });
    };
    timeout = setTimeout(() => fail('Timed out waiting for an update to download.'), 180000);
    poll = setInterval(() => {
      const state = coordinator.status();
      if (state.phase === 'error' || state.phase === 'unsupported') {
        fail(state.reason || 'The update coordinator rejected the fixture update.');
        return;
      }
      if (state.phase === 'ready' && !installStarted) {
        installStarted = true;
        report({ stage: 'installing', state });
        void coordinator.install(state.version).catch(error => fail(error?.message || error));
      }
    }, 100);

    try {
      coordinator = new UpdateCoordinator({
        app,
        autoUpdater,
        isEnabled: () => true,
        autoDownload: () => true,
        beforeInstall: async () => ({ ok: true }),
        publish: state => {
          if (!completed) report({ stage: 'updating', state });
        },
      });
      // CI runs headlessly. Keep the production coordinator and real updater
      // path; only request the installer's supported silent mode for this fixture.
      const realQuitAndInstall = autoUpdater.quitAndInstall.bind(autoUpdater);
      autoUpdater.quitAndInstall = (_isSilent, isForceRunAfter) => realQuitAndInstall(true, isForceRunAfter);
      await coordinator.setEnabled(true);
    } catch (error) {
      fail(error?.message || error);
    }
  }).catch(error => finish(1, { stage: 'error', reason: error?.message || String(error) }));
}

if (require.main === module) {
  if (process.argv[2] === '--build-fixture') {
    buildFixture().catch(error => {
      process.stderr.write((error?.stack || String(error)) + '\n');
      process.exitCode = 1;
    });
  } else {
    try {
      runFixture();
    } catch (error) {
      try { process.stderr.write('Windows update fixture startup failed: ' + (error?.stack || String(error)) + '\n'); } catch {}
      process.exitCode = 2;
      try { process.exit(2); } catch {}
    }
  }
}

module.exports = {
  canonicalExistingPath,
  createFixtureBuildOptions,
  loadSmokeConfig,
  resolveRuntimeDependencies,
};
