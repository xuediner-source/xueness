'use strict';

// Downloads the public Windows installer with the real NSIS network executor.
// The app adapter, cache and old version are isolated test fixtures; no installer is run.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const { spawn } = require('node:child_process');
const { createRequire } = require('node:module');
const desktopRoot = resolve(__dirname, '..');
const requireDesktop = createRequire(join(desktopRoot, 'package.json'));

async function runElectron() {
  const { app } = require('electron');
  const { NsisUpdater } = requireDesktop('electron-updater');
  const { ElectronHttpExecutor } = requireDesktop('electron-updater/out/electronHttpExecutor');
  const { UpdateCoordinator } = require('../src/update-coordinator.cjs');
  const folder = process.env.XUENESS_GITHUB_DOWNLOAD_CHECK_DIR;
  assert(folder, 'An isolated directory is required');
  app.setName('Xueness Windows Download Check');
  app.setPath('userData', folder);
  await app.whenReady();
  let coordinator;
  try {
    const publisher = require('../electron-builder.cjs').publish[0];
    assert.equal(publisher.provider, 'github');
    assert.equal(publisher.owner, 'xuediner-source');
    assert.equal(publisher.repo, 'xueness');
    const config = join(folder, 'app-update.yml');
    const yaml = requireDesktop('js-yaml');
    await fs.writeFile(config, yaml.dump({ ...publisher, updaterCacheDirName: 'isolated-cache' }));
    const adapter = {
      version: '0.0.0', name: 'xueness-isolated-download-check', isPackaged: true,
      appUpdateConfigPath: config, userDataPath: folder, baseCachePath: folder,
      whenReady: () => app.whenReady(), onQuit: () => {},
      quit: () => { throw new Error('The download check must never install'); },
      relaunch: () => { throw new Error('The download check must never relaunch'); },
    };
    const updater = new NsisUpdater(undefined, adapter);
    updater.httpExecutor = new ElectronHttpExecutor();
    updater._testOnlyOptions = { platform: 'win32' };
    updater.logger = { info: () => {}, warn: () => {}, error: () => {} };
    coordinator = new UpdateCoordinator({ app, autoUpdater: updater, packaged: true,
      platform: 'win32', arch: 'x64', portable: false, currentVersion: adapter.version,
      isEnabled: () => true, autoDownload: () => false, checkIntervalMs: 0 });
    await coordinator.setEnabled(true);
    await coordinator.checkPromise;
    const checked = coordinator.status();
    assert.equal(checked.phase, 'available', checked.reason);
    const started = performance.now();
    await coordinator.download(checked.version);
    await coordinator.updaterDownloadPromise;
    const ready = coordinator.status();
    assert.equal(ready.phase, 'ready', ready.reason);
    const installer = updater.installerPath;
    assert(installer && /\.exe$/i.test(installer));
    const report = { stage: 'verified', nativePlatform: process.platform,
      fixturePlatform: 'win32', version: ready.version,
      bytes: (await fs.stat(installer)).size, elapsedSeconds: (performance.now() - started) / 1000,
      sha512VerifiedByElectronUpdater: true, installerExecuted: false };
    await fs.writeFile(join(folder, 'report.json'), JSON.stringify(report));
    console.log(JSON.stringify(report));
  } catch (error) {
    console.error(error.stack);
    process.exitCode = 1;
  } finally {
    coordinator?.dispose();
    app.quit();
  }
}

async function launchCheck() {
  const folder = await fs.mkdtemp(join(tmpdir(), 'xueness-windows-github-download-'));
  let child;
  try {
    const env = { ...process.env, XUENESS_GITHUB_DOWNLOAD_CHECK_DIR: folder };
    delete env.ELECTRON_RUN_AS_NODE;
    child = spawn(requireDesktop('electron'), [__filename], { env, windowsHide: true, stdio: 'inherit' });
    await new Promise((resolveExit, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error('Public GitHub download timed out after five minutes')); }, 300000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); code === 0 ? resolveExit() : reject(new Error('Public GitHub download check failed')); });
    });
    const report = JSON.parse(await fs.readFile(join(folder, 'report.json'), 'utf8'));
    assert.equal(report.stage, 'verified');
    assert.equal(report.installerExecuted, false);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    await fs.rm(folder, { recursive: true, force: true });
  }
}

if (process.versions.electron && !process.env.ELECTRON_RUN_AS_NODE) void runElectron();
else launchCheck().catch(error => { console.error(error.stack); process.exitCode = 1; });
