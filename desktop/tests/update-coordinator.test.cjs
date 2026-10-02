'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  UpdateCoordinator,
  RELEASES_API,
  normalizeVersion,
  compareVersions,
} = require('../src/update-coordinator.cjs');

class FakeUpdater extends EventEmitter {
  constructor(result) {
    super();
    this.result = result;
    this.checks = 0;
    this.downloads = 0;
    this.installs = [];
    this.downloadToken = null;
  }

  async checkForUpdates() {
    this.checks += 1;
    return this.result;
  }

  downloadUpdate(token) {
    this.downloads += 1;
    this.downloadToken = token;
    return new Promise(resolve => { this.finishDownload = resolve; });
  }

  quitAndInstall(...args) {
    this.installs.push(args);
  }
}

function makeToken() {
  return {
    cancelled: false,
    disposed: false,
    cancel() { this.cancelled = true; },
    dispose() { this.disposed = true; },
  };
}

function makeTimerControls() {
  const timers = [];
  const cleared = [];
  return {
    timers,
    cleared,
    setIntervalFn(callback, delay) {
      const timer = { callback, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearIntervalFn(timer) { cleared.push(timer); },
  };
}

function makeCoordinator(overrides = {}) {
  const updater = overrides.autoUpdater || new FakeUpdater({
    isUpdateAvailable: true,
    updateInfo: { version: '1.2.0' },
  });
  const timers = makeTimerControls();
  const options = {
    app: { isPackaged: true, getVersion: () => '1.0.0', getPath: () => '/unused' },
    autoUpdater: updater,
    publish: overrides.publish || (() => {}),
    isEnabled: overrides.isEnabled || (() => true),
    beforeInstall: overrides.beforeInstall,
    currentVersion: '1.0.0',
    signedMac: false,
    platform: 'win32',
    arch: 'x64',
    portable: false,
    packaged: true,
    shell: { openPath: async () => '' },
    createCancellationToken: overrides.createCancellationToken || makeToken,
    fetchImpl: overrides.fetchImpl || globalThis.fetch,
    checkIntervalMs: 60_000,
    setIntervalFn: timers.setIntervalFn,
    clearIntervalFn: timers.clearIntervalFn,
    ...overrides,
  };
  return { coordinator: new UpdateCoordinator(options), updater, timers };
}

async function waitUntil(predicate, tries = 100) {
  for (let index = 0; index < tries; index += 1) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail('condition did not become true');
}

test('stable versions are normalized and compared without accepting prereleases or downgrades', () => {
  assert.equal(normalizeVersion('v1.2.3'), '1.2.3');
  assert.equal(normalizeVersion('1.2.3-beta.1'), null);
  assert.equal(normalizeVersion('01.2.3'), null);
  assert.equal(compareVersions('1.2.3', '1.2.2'), 1);
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  assert.equal(compareVersions('1.2.3', '2.0.0'), -1);
});

test('status error text does not expose update URLs or local filesystem paths', async () => {
  const { coordinator } = makeCoordinator();
  const reason = coordinator.safeError(new Error(
    'download failed https://github.com/xuediner-source/xueness/releases/a /Users/alice/Library/Application Support/Xueness/updates/installer.dmg',
  ));
  assert.equal(reason.includes('https://'), false);
  assert.equal(reason.includes('/Users/alice'), false);
  assert.match(reason, /更新服务器/);
  assert.match(reason, /本地路径/);
  await coordinator.dispose();
});

test('Windows uses a fixed stable updater configuration, downloads in background, and acknowledges before install cleanup', async () => {
  const order = [];
  const token = makeToken();
  const { coordinator, updater, timers } = makeCoordinator({
    createCancellationToken: () => token,
    beforeInstall: async version => {
      assert.equal(version, '1.2.0');
      order.push('prepare');
      return { ok: true, afterReply: async () => { order.push('backend-stop'); } };
    },
  });

  assert.equal(updater.autoDownload, false);
  assert.equal(updater.allowPrerelease, false);
  assert.equal(updater.allowDowngrade, false);
  assert.equal(updater.autoInstallOnAppQuit, false);
  await coordinator.setEnabled(true);
  await waitUntil(() => updater.downloads === 1);

  updater.emit('download-progress', { percent: 47.5 });
  await waitUntil(() => coordinator.status().percent === 47.5);
  assert.equal(coordinator.status().percent, 47.5);
  updater.emit('update-downloaded', { version: '1.2.0' });
  updater.finishDownload();
  await waitUntil(() => token.disposed);
  await waitUntil(() => coordinator.state.phase === 'ready');
  assert.equal(coordinator.status().phase, 'ready');
  assert.equal(coordinator.status().canInstall, true);

  const responses = [];
  await coordinator.handleRequest({
    type: 'update',
    id: '0123456789abcdef0123456789abcdef',
    action: 'install',
    version: '1.2.0',
  }, response => {
    order.push('pipe-ack');
    responses.push(response);
  });

  assert.deepEqual(order, ['prepare', 'pipe-ack', 'backend-stop']);
  assert.equal(responses[0].state.phase, 'installing');
  assert.equal(coordinator.status().phase, 'installing');
  assert.deepEqual(updater.installs, [[false, true]]);
  assert.equal(timers.timers.length, 1);
  await coordinator.dispose();
  assert.equal(token.disposed, true);
});

test('app quit after committed install does not cancel the updater token during its final promise turn', async () => {
  const token = makeToken();
  const { coordinator, updater } = makeCoordinator({
    createCancellationToken: () => token,
    beforeInstall: async () => ({ ok: true }),
  });
  let disposePromise;
  updater.quitAndInstall = (...args) => {
    updater.installs.push(args);
    disposePromise = coordinator.dispose();
  };

  await coordinator.setEnabled(true);
  await waitUntil(() => updater.downloads === 1);
  updater.emit('update-downloaded', { version: '1.2.0' });
  await waitUntil(() => coordinator.state.phase === 'ready');
  assert.equal(token.cancelled, false);

  await coordinator.install('1.2.0');
  await disposePromise;
  assert.deepEqual(updater.installs, [[false, true]]);
  assert.equal(token.cancelled, false);
  updater.finishDownload();
  await waitUntil(() => token.disposed);
});

test('disabling updates cancels an active download and prevents future network checks', async () => {
  const token = makeToken();
  const { coordinator, updater, timers } = makeCoordinator({ createCancellationToken: () => token });

  await coordinator.setEnabled(true);
  await waitUntil(() => updater.downloads === 1);
  await coordinator.setEnabled(false);

  assert.equal(token.cancelled, true);
  assert.equal(coordinator.status().phase, 'disabled');
  assert.equal(timers.cleared.length, 1);
  updater.emit('download-progress', { percent: 99 });
  updater.emit('update-downloaded', { version: '1.2.0' });
  assert.equal(coordinator.status().phase, 'disabled');
  assert.equal(coordinator.status().canInstall, false);
  await coordinator.check();
  assert.equal(updater.checks, 1);
  assert.equal(updater.downloads, 1);
  updater.finishDownload();
  await waitUntil(() => token.disposed);
  await coordinator.dispose();
});

test('late updater events are rejected when the live plugin policy turns off', async () => {
  let policy = true;
  const token = makeToken();
  const { coordinator, updater } = makeCoordinator({
    isEnabled: () => policy,
    createCancellationToken: () => token,
  });
  await coordinator.setEnabled(true);
  await waitUntil(() => updater.downloads === 1);

  policy = false;
  updater.emit('download-progress', { percent: 100 });
  updater.emit('update-downloaded', { version: '1.2.0' });
  await waitUntil(() => coordinator.enabled === false);

  assert.equal(coordinator.status().phase, 'disabled');
  assert.equal(coordinator.status().canInstall, false);
  assert.equal(coordinator.downloadedVersion, null);
  updater.finishDownload();
  await waitUntil(() => token.disposed);
  await coordinator.dispose();
});

test('disabled auto-download preference leaves updates available until the user requests download', async () => {
  const { coordinator, updater } = makeCoordinator({ autoDownload: () => false });
  await coordinator.setEnabled(true);
  await waitUntil(() => coordinator.state.phase === 'available');
  assert.equal(updater.downloads, 0);
  assert.equal(coordinator.status().canDownload, true);

  await coordinator.download('1.2.0');
  await waitUntil(() => updater.downloads === 1);
  updater.emit('update-downloaded', { version: '1.2.0' });
  updater.finishDownload();
  await waitUntil(() => coordinator.state.phase === 'ready');
  assert.equal(coordinator.status().canInstall, true);
  await coordinator.dispose();
});

test('install remains blocked unless main confirms the backend is idle', async () => {
  const { coordinator, updater } = makeCoordinator();
  await coordinator.setEnabled(true);
  await waitUntil(() => updater.downloads === 1);
  updater.emit('update-downloaded', { version: '1.2.0' });
  updater.finishDownload();
  await waitUntil(() => coordinator.state.phase === 'ready');

  const result = await coordinator.install('1.2.0');
  assert.equal(result.phase, 'ready');
  assert.match(result.reason, /后端尚未确认/);
  assert.deepEqual(updater.installs, []);
  await coordinator.dispose();
});

test('older and prerelease updater results never become downloadable', async () => {
  for (const version of ['0.9.0', '2.0.0-beta.1']) {
    const updater = new FakeUpdater({ isUpdateAvailable: true, updateInfo: { version } });
    const { coordinator } = makeCoordinator({ autoUpdater: updater });

    await coordinator.setEnabled(true);
    await waitUntil(() => coordinator.state.phase === 'current');
    assert.equal(coordinator.status().canDownload, false);
    assert.equal(updater.downloads, 0);
    await coordinator.dispose();
  }
});

test('unsigned macOS downloads only the fixed trusted DMG and opens it without claiming installation', async t => {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'xueness-update-test-'));
  t.after(() => fs.rm(userData, { recursive: true, force: true }));
  const opened = [];
  const calls = [];
  const assetName = 'Xueness-1.2.0-macos-arm64.dmg';
  const dmgBytes = Buffer.from('verified-dmg-bytes');
  const dmgDigest = createHash('sha256').update(dmgBytes).digest('hex');
  const release = {
    draft: false,
    prerelease: false,
    tag_name: 'v1.2.0',
    assets: [{
      name: assetName,
      size: dmgBytes.length,
      digest: 'sha256:' + dmgDigest,
      browser_download_url: 'https://github.com/xuediner-source/xueness/releases/download/v1.2.0/' + assetName,
    }],
  };
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url) === RELEASES_API) {
      return new Response(JSON.stringify(release), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(dmgBytes, {
      status: 200,
      headers: { 'content-length': String(dmgBytes.length) },
    });
  };
  const app = { isPackaged: true, getVersion: () => '1.0.0', getPath: () => userData };
  const coordinator = new UpdateCoordinator({
    app,
    currentVersion: '1.0.0',
    platform: 'darwin',
    arch: 'arm64',
    signedMac: false,
    packaged: true,
    shell: { openPath: async filePath => { opened.push(filePath); return ''; } },
    fetchImpl,
    isEnabled: () => true,
    beforeInstall: async () => ({ ok: true }),
    checkIntervalMs: 0,
  });

  await coordinator.setEnabled(true);
  await waitUntil(() => coordinator.state.phase === 'ready');
  const ready = coordinator.status();
  assert.equal(ready.version, '1.2.0');
  assert.equal(ready.installMode, 'open-dmg');
  assert.equal(ready.canDownload, false);
  assert.equal(ready.canInstall, false);
  assert.match(ready.reason, /Finder/);
  assert.equal(calls[0].url, RELEASES_API);
  assert.equal(calls[1].options.redirect, 'manual');
  assert.equal(calls.filter(call => call.url === RELEASES_API).length, 1);
  assert.equal(calls.some(call => Object.keys(call.options.headers || {}).some(name => /x-xueness-desktop-token/i.test(name))), false);

  const replies = [];
  await coordinator.handleRequest({
    type: 'update',
    id: 'fedcba9876543210fedcba9876543210',
    action: 'install',
    version: '1.2.0',
  }, response => replies.push(response));

  assert.equal(replies[0].state.phase, 'opening-installer');
  assert.equal(coordinator.status().phase, 'installer_opened');
  assert.equal(opened.length, 1);
  assert.equal(path.basename(opened[0]).startsWith('Xueness-1.2.0-macos-arm64-'), true);
  assert.deepEqual(await fs.readFile(opened[0]), dmgBytes);
  assert.equal(JSON.stringify(replies).includes(opened[0]), false);
  assert.equal(coordinator.status().phase === 'installed', false);
  await coordinator.dispose();
});

test('unsigned macOS release metadata follows only allowlisted redirects and has a bounded body', async () => {
  const calls = [];
  const redirected = makeCoordinator({
    platform: 'darwin',
    signedMac: false,
    shell: { openPath: async () => '' },
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      return new Response(null, { status: 302, headers: { location: 'https://evil.example/release.json' } });
    },
    checkIntervalMs: 0,
  }).coordinator;
  await redirected.setEnabled(true);
  await waitUntil(() => redirected.state.phase === 'error');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, RELEASES_API);
  assert.equal(calls[0].options.redirect, 'manual');
  assert.match(redirected.status().reason, /更新资产下载地址不可信/);
  await redirected.dispose();

  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'xueness-release-metadata-test-'));
  try {
    const tooLarge = makeCoordinator({
      platform: 'darwin',
      signedMac: false,
      app: { isPackaged: true, getVersion: () => '1.0.0', getPath: () => userData },
      packaged: true,
      shell: { openPath: async () => '' },
      fetchImpl: async () => new Response(Buffer.alloc(1024 * 1024 + 1), { status: 200 }),
      checkIntervalMs: 0,
    }).coordinator;
    await tooLarge.setEnabled(true);
    await waitUntil(() => tooLarge.state.phase === 'error');
    assert.match(tooLarge.status().reason, /超过安全上限/);
    await tooLarge.dispose();
  } finally {
    await fs.rm(userData, { recursive: true, force: true });
  }
});

test('unsigned macOS falls back to a bounded SHA256SUMS.txt from the pinned release', async t => {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'xueness-checksum-test-'));
  t.after(() => fs.rm(userData, { recursive: true, force: true }));
  const assetName = 'Xueness-1.2.0-macos-arm64.dmg';
  const dmgBytes = Buffer.from('verified-with-release-checksums');
  const hash = createHash('sha256').update(dmgBytes).digest('hex');
  const checksumBytes = Buffer.from(hash + '  ' + assetName + '\n');
  const release = {
    draft: false,
    prerelease: false,
    tag_name: 'v1.2.0',
    assets: [
      {
        name: assetName,
        size: dmgBytes.length,
        digest: null,
        browser_download_url: 'https://github.com/xuediner-source/xueness/releases/download/v1.2.0/' + assetName,
      },
      {
        name: 'SHA256SUMS.txt',
        size: checksumBytes.length,
        browser_download_url: 'https://github.com/xuediner-source/xueness/releases/download/v1.2.0/SHA256SUMS.txt',
      },
    ],
  };
  const calls = [];
  const fetchImpl = async url => {
    calls.push(String(url));
    if (String(url) === RELEASES_API) return new Response(JSON.stringify(release), { status: 200 });
    if (String(url).endsWith('/SHA256SUMS.txt')) {
      return new Response(checksumBytes, { status: 200, headers: { 'content-length': String(checksumBytes.length) } });
    }
    return new Response(dmgBytes, { status: 200, headers: { 'content-length': String(dmgBytes.length) } });
  };
  const coordinator = new UpdateCoordinator({
    app: { isPackaged: true, getVersion: () => '1.0.0', getPath: () => userData },
    currentVersion: '1.0.0',
    platform: 'darwin',
    arch: 'arm64',
    signedMac: false,
    packaged: true,
    shell: { openPath: async () => '' },
    fetchImpl,
    isEnabled: () => true,
    checkIntervalMs: 0,
  });

  await coordinator.setEnabled(true);
  await waitUntil(() => coordinator.state.phase === 'ready');
  assert.equal(calls[0], RELEASES_API);
  assert.equal(calls[1].endsWith('/SHA256SUMS.txt'), true);
  assert.equal(calls[2].includes(assetName), true);
  assert.equal(coordinator.status().version, '1.2.0');
  assert.equal(coordinator.status().installMode, 'open-dmg');
  await coordinator.dispose();
});

test('unsigned macOS refuses to open a DMG after a digest mismatch and removes partial files', async t => {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'xueness-digest-fail-test-'));
  t.after(() => fs.rm(userData, { recursive: true, force: true }));
  const assetName = 'Xueness-1.2.0-macos-arm64.dmg';
  const dmgBytes = Buffer.from('asset-bytes');
  const opened = [];
  const release = {
    draft: false,
    prerelease: false,
    tag_name: 'v1.2.0',
    assets: [{
      name: assetName,
      size: dmgBytes.length,
      digest: 'sha256:' + '0'.repeat(64),
      browser_download_url: 'https://github.com/xuediner-source/xueness/releases/download/v1.2.0/' + assetName,
    }],
  };
  const coordinator = new UpdateCoordinator({
    app: { isPackaged: true, getVersion: () => '1.0.0', getPath: () => userData },
    currentVersion: '1.0.0',
    platform: 'darwin',
    arch: 'arm64',
    signedMac: false,
    packaged: true,
    shell: { openPath: async pathName => { opened.push(pathName); return ''; } },
    fetchImpl: async url => String(url) === RELEASES_API
      ? new Response(JSON.stringify(release), { status: 200 })
      : new Response(dmgBytes, { status: 200, headers: { 'content-length': String(dmgBytes.length) } }),
    isEnabled: () => true,
    checkIntervalMs: 0,
  });

  await coordinator.setEnabled(true);
  await waitUntil(() => coordinator.state.phase === 'error');
  assert.match(coordinator.status().reason, /SHA-256 校验失败/);
  assert.equal(coordinator.manualInstallerPath, null);
  assert.equal(opened.length, 0);
  assert.deepEqual(await fs.readdir(path.join(userData, 'updates')), []);
  await coordinator.dispose();
});

test('unsigned macOS rechecks the downloaded DMG before opening it', async t => {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'xueness-tampered-test-'));
  t.after(() => fs.rm(userData, { recursive: true, force: true }));
  const assetName = 'Xueness-1.2.0-macos-arm64.dmg';
  const dmgBytes = Buffer.from('verified-dmg');
  const release = {
    draft: false,
    prerelease: false,
    tag_name: 'v1.2.0',
    assets: [{
      name: assetName,
      size: dmgBytes.length,
      digest: 'sha256:' + createHash('sha256').update(dmgBytes).digest('hex'),
      browser_download_url: 'https://github.com/xuediner-source/xueness/releases/download/v1.2.0/' + assetName,
    }],
  };
  const opened = [];
  let prepared = 0;
  const coordinator = new UpdateCoordinator({
    app: { isPackaged: true, getVersion: () => '1.0.0', getPath: () => userData },
    currentVersion: '1.0.0',
    platform: 'darwin',
    arch: 'arm64',
    signedMac: false,
    packaged: true,
    shell: { openPath: async filePath => { opened.push(filePath); return ''; } },
    fetchImpl: async url => String(url) === RELEASES_API
      ? new Response(JSON.stringify(release), { status: 200 })
      : new Response(dmgBytes, { status: 200, headers: { 'content-length': String(dmgBytes.length) } }),
    beforeInstall: async () => { prepared += 1; return { ok: true }; },
    isEnabled: () => true,
    checkIntervalMs: 0,
  });

  await coordinator.setEnabled(true);
  await waitUntil(() => coordinator.state.phase === 'ready');
  await fs.writeFile(coordinator.manualInstallerPath, 'changed-after-download');
  const replies = [];
  await coordinator.handleRequest({
    type: 'update',
    id: '0123456789abcdef0123456789abcdef',
    action: 'install',
    version: '1.2.0',
  }, response => replies.push(response));

  assert.equal(coordinator.status().phase, 'error');
  assert.match(coordinator.status().reason, /完整性检查失败/);
  assert.equal(prepared, 0);
  assert.equal(opened.length, 0);
  assert.equal(JSON.stringify(replies).includes(userData), false);
  await coordinator.dispose();
});

test('unsigned macOS refuses unbounded checksum manifests and unsafe redirects', async t => {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'xueness-feed-boundary-test-'));
  t.after(() => fs.rm(userData, { recursive: true, force: true }));
  const assetName = 'Xueness-1.2.0-macos-arm64.dmg';
  const bytes = Buffer.from('payload');
  const digest = 'sha256:' + createHash('sha256').update(bytes).digest('hex');
  const makeRelease = checksumSize => ({
    draft: false,
    prerelease: false,
    tag_name: 'v1.2.0',
    assets: [
      {
        name: assetName,
        size: bytes.length,
        digest: null,
        browser_download_url: 'https://github.com/xuediner-source/xueness/releases/download/v1.2.0/' + assetName,
      },
      {
        name: 'SHA256SUMS.txt',
        size: checksumSize,
        digest,
        browser_download_url: 'https://github.com/xuediner-source/xueness/releases/download/v1.2.0/SHA256SUMS.txt',
      },
    ],
  });

  const bounded = new UpdateCoordinator({
    app: { isPackaged: true, getVersion: () => '1.0.0', getPath: () => userData },
    currentVersion: '1.0.0',
    platform: 'darwin', arch: 'arm64', signedMac: false, packaged: true,
    shell: { openPath: async () => '' },
    fetchImpl: async url => String(url) === RELEASES_API
      ? new Response(JSON.stringify(makeRelease(64 * 1024 + 1)), { status: 200 })
      : new Response(bytes, { status: 200 }),
    isEnabled: () => true,
    checkIntervalMs: 0,
  });
  await bounded.setEnabled(true);
  await waitUntil(() => bounded.state.phase === 'error');
  assert.match(bounded.status().reason, /SHA-256/);
  await bounded.dispose();

  const oversizedBody = new UpdateCoordinator({
    app: { isPackaged: true, getVersion: () => '1.0.0', getPath: () => userData },
    currentVersion: '1.0.0',
    platform: 'darwin', arch: 'arm64', signedMac: false, packaged: true,
    shell: { openPath: async () => '' },
    fetchImpl: async url => String(url) === RELEASES_API
      ? new Response(JSON.stringify(makeRelease(1)), { status: 200 })
      : new Response(Buffer.alloc(64 * 1024 + 1, 0x61), { status: 200 }),
    isEnabled: () => true,
    checkIntervalMs: 0,
  });
  await oversizedBody.setEnabled(true);
  await waitUntil(() => oversizedBody.state.phase === 'error');
  assert.match(oversizedBody.status().reason, /校验文件超过安全上限/);
  await oversizedBody.dispose();

  const redirecting = new UpdateCoordinator({
    app: { isPackaged: true, getVersion: () => '1.0.0', getPath: () => userData },
    currentVersion: '1.0.0',
    platform: 'darwin', arch: 'arm64', signedMac: false, packaged: true,
    shell: { openPath: async () => '' },
    fetchImpl: async url => String(url) === RELEASES_API
      ? new Response(JSON.stringify({
          draft: false,
          prerelease: false,
          tag_name: 'v1.2.0',
          assets: [{
            name: assetName,
            size: bytes.length,
            digest,
            browser_download_url: 'https://github.com/xuediner-source/xueness/releases/download/v1.2.0/' + assetName,
          }],
        }), { status: 200 })
      : new Response(null, { status: 302, headers: { location: 'https://objects.githubusercontent.com:444/payload' } }),
    isEnabled: () => true,
    checkIntervalMs: 0,
  });
  await redirecting.setEnabled(true);
  await waitUntil(() => redirecting.state.phase === 'error');
  assert.match(redirecting.status().reason, /不可信/);
  assert.equal(redirecting.manualInstallerPath, null);
  assert.equal(JSON.stringify(redirecting.status()).includes('objects.githubusercontent.com'), false);
  await redirecting.dispose();
});

test('unsigned macOS rejects a download whose declared size differs from its pinned Release asset', async t => {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'xueness-size-fail-test-'));
  t.after(() => fs.rm(userData, { recursive: true, force: true }));
  const assetName = 'Xueness-1.2.0-macos-arm64.dmg';
  const dmgBytes = Buffer.from('expected-bytes');
  const release = {
    draft: false,
    prerelease: false,
    tag_name: 'v1.2.0',
    assets: [{
      name: assetName,
      size: dmgBytes.length,
      digest: 'sha256:' + createHash('sha256').update(dmgBytes).digest('hex'),
      browser_download_url: 'https://github.com/xuediner-source/xueness/releases/download/v1.2.0/' + assetName,
    }],
  };
  const coordinator = new UpdateCoordinator({
    app: { isPackaged: true, getVersion: () => '1.0.0', getPath: () => userData },
    currentVersion: '1.0.0',
    platform: 'darwin',
    arch: 'arm64',
    signedMac: false,
    packaged: true,
    shell: { openPath: async () => '' },
    fetchImpl: async url => String(url) === RELEASES_API
      ? new Response(JSON.stringify(release), { status: 200 })
      : new Response(dmgBytes, { status: 200, headers: { 'content-length': String(dmgBytes.length - 1) } }),
    isEnabled: () => true,
    checkIntervalMs: 0,
  });

  await coordinator.setEnabled(true);
  await waitUntil(() => coordinator.state.phase === 'error');
  assert.match(coordinator.status().reason, /大小与发布记录不符/);
  assert.equal(coordinator.manualInstallerPath, null);
  const updatesDirectoryExists = await fs.access(path.join(userData, 'updates')).then(() => true, () => false);
  assert.equal(updatesDirectoryExists, false);
  await coordinator.dispose();
});

test('unsigned macOS rejects bytes whose actual size differs when the CDN omits content-length', async t => {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'xueness-actual-size-test-'));
  t.after(() => fs.rm(userData, { recursive: true, force: true }));
  const assetName = 'Xueness-1.2.0-macos-arm64.dmg';
  const dmgBytes = Buffer.from('actual-size');
  const release = {
    draft: false,
    prerelease: false,
    tag_name: 'v1.2.0',
    assets: [{
      name: assetName,
      size: dmgBytes.length + 1,
      digest: 'sha256:' + createHash('sha256').update(dmgBytes).digest('hex'),
      browser_download_url: 'https://github.com/xuediner-source/xueness/releases/download/v1.2.0/' + assetName,
    }],
  };
  const coordinator = new UpdateCoordinator({
    app: { isPackaged: true, getVersion: () => '1.0.0', getPath: () => userData },
    currentVersion: '1.0.0',
    platform: 'darwin', arch: 'arm64', signedMac: false, packaged: true,
    shell: { openPath: async () => '' },
    fetchImpl: async url => String(url) === RELEASES_API
      ? new Response(JSON.stringify(release), { status: 200 })
      : new Response(dmgBytes, { status: 200 }),
    isEnabled: () => true,
    checkIntervalMs: 0,
  });

  await coordinator.setEnabled(true);
  await waitUntil(() => coordinator.state.phase === 'error');
  assert.match(coordinator.status().reason, /大小与发布记录不符/);
  assert.equal(coordinator.manualInstallerPath, null);
  assert.deepEqual(await fs.readdir(path.join(userData, 'updates')), []);
  await coordinator.dispose();
});

test('unsigned macOS rejects an asset URL outside the fixed Xueness release path', async () => {
  const coordinator = new UpdateCoordinator({
    app: { isPackaged: true, getVersion: () => '1.0.0', getPath: () => '/unused' },
    currentVersion: '1.0.0',
    platform: 'darwin',
    arch: 'arm64',
    signedMac: false,
    packaged: true,
    shell: { openPath: async () => '' },
    isEnabled: () => true,
    fetchImpl: async () => new Response(JSON.stringify({
      draft: false,
      prerelease: false,
      tag_name: 'v1.2.0',
      assets: [{
        name: 'Xueness-1.2.0-macos-arm64.dmg',
        browser_download_url: 'https://example.invalid/Xueness-1.2.0-macos-arm64.dmg',
      }],
    }), { status: 200 }),
    checkIntervalMs: 0,
  });

  await coordinator.setEnabled(true);
  await waitUntil(() => coordinator.state.phase === 'error');
  assert.equal(coordinator.status().version, null);
  assert.match(coordinator.status().reason, /可信 DMG/);
  await coordinator.dispose();
});

test('portable Windows and source runs stay unsupported without starting checks', async () => {
  const updater = new FakeUpdater({ isUpdateAvailable: true, updateInfo: { version: '1.2.0' } });
  const { coordinator: portable } = makeCoordinator({ autoUpdater: updater, portable: true });
  await portable.setEnabled(true);
  assert.equal(portable.status().phase, 'unsupported');
  assert.equal(portable.status().installMode, 'unsupported');
  assert.equal(portable.status().canDownload, false);
  assert.match(portable.status().reason, /NSIS/);
  assert.equal(updater.checks, 0);
  await portable.dispose();

  let fetches = 0;
  const source = new UpdateCoordinator({
    app: { isPackaged: false, getVersion: () => '1.0.0' },
    currentVersion: '1.0.0',
    platform: 'darwin',
    signedMac: false,
    packaged: false,
    shell: { openPath: async () => '' },
    fetchImpl: async () => { fetches += 1; throw new Error('must not fetch'); },
    isEnabled: () => true,
    checkIntervalMs: 0,
  });
  await source.setEnabled(true);
  assert.equal(source.status().phase, 'unsupported');
  assert.equal(source.status().installMode, 'unsupported');
  assert.equal(fetches, 0);
  await source.dispose();
});

test('pipe requests accept only the fixed action and identifier contract', async () => {
  const { coordinator } = makeCoordinator();
  const sent = [];
  assert.equal(await coordinator.handleRequest({
    type: 'update',
    id: 'not-an-id',
    action: 'check',
  }, value => sent.push(value)), false);
  assert.equal(await coordinator.handleRequest({
    type: 'update',
    id: '0123456789abcdef0123456789abcdef',
    action: 'open-url',
    url: 'https://example.invalid',
  }, value => sent.push(value)), true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].state.canDownload, false);
  assert.equal(JSON.stringify(sent).includes('https://example.invalid'), false);
  await coordinator.dispose();
});
