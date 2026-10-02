'use strict';

const { createReadStream, createWriteStream } = require('node:fs');
const fs = require('node:fs/promises');
const { createHash, randomUUID } = require('node:crypto');
const { Transform, Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { join } = require('node:path');

const OWNER = 'xuediner-source';
const REPO = 'xueness';
const RELEASES_API = 'https://api.github.com/repos/' + OWNER + '/' + REPO + '/releases/latest';
const REDIRECT_HOSTS = new Set([
  'api.github.com',
  'github.com',
  'release-assets.githubusercontent.com',
  'objects.githubusercontent.com',
]);
const AUTO_CHECK_MS = 6 * 60 * 60 * 1000;
const MAX_DMG_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_CHECKSUMS_BYTES = 64 * 1024;
const MAX_RELEASE_METADATA_BYTES = 1024 * 1024;
const REQUEST_ID = /^[a-f0-9]{32}$/;
const STABLE_VERSION = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function parseStableVersion(value) {
  if (typeof value !== 'string') return null;
  const match = STABLE_VERSION.exec(value);
  if (!match) return null;
  return match.slice(1).map(Number);
}

function compareVersions(left, right) {
  const a = parseStableVersion(left);
  const b = parseStableVersion(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] > b[index]) return 1;
    if (a[index] < b[index]) return -1;
  }
  return 0;
}

function normalizeVersion(value) {
  const parts = parseStableVersion(value);
  return parts ? parts.join('.') : null;
}

function supportsRedirect(url) {
  return url.protocol === 'https:' && REDIRECT_HOSTS.has(url.hostname)
    && !url.username && !url.password && (!url.port || url.port === '443');
}

function responseError(response, operation) {
  return new Error(operation + ' failed (' + response.status + ')');
}

class UpdateCoordinator {
  constructor(options = {}) {
    const {
      app,
      autoUpdater,
      publish = () => {},
      isEnabled = () => false,
      autoDownload = () => true,
      beforeInstall = async () => ({ ok: false, reason: '桌面后端尚未确认没有正在运行的任务。' }),
      currentVersion,
      signedMac = false,
      platform = process.platform,
      arch = process.arch,
      portable,
      packaged = app?.isPackaged === true,
      shell,
      fetchImpl = globalThis.fetch,
      createCancellationToken,
      checkIntervalMs = AUTO_CHECK_MS,
      setIntervalFn = setInterval,
      clearIntervalFn = clearInterval,
      userDataPath,
    } = options;

    this.app = app;
    this.autoUpdater = autoUpdater;
    this.publish = publish;
    this.isEnabledCallback = isEnabled;
    this.autoDownloadCallback = autoDownload;
    this.beforeInstall = beforeInstall;
    this.currentVersionSource = currentVersion;
    this.signedMac = signedMac === true;
    this.platform = platform;
    this.arch = arch;
    this.portable = portable === true
      || Boolean(process.env.PORTABLE_EXECUTABLE_DIR || process.env.PORTABLE_EXECUTABLE_FILE);
    this.packaged = packaged === true;
    this.shell = shell;
    this.fetchImpl = fetchImpl;
    this.createCancellationToken = createCancellationToken || (() => {
      const { CancellationToken } = require('electron-updater');
      return new CancellationToken();
    });
    this.checkIntervalMs = checkIntervalMs;
    this.setIntervalFn = setIntervalFn;
    this.clearIntervalFn = clearIntervalFn;
    this.userDataPath = userDataPath || (() => app?.getPath?.('userData'));

    this.enabled = false;
    this.disposed = false;
    this.installCommitted = false;
    this.policyGeneration = 0;
    this.timer = null;
    this.checkPromise = null;
    this.checkAgain = false;
    this.checkGeneration = 0;
    this.activeCheckGeneration = null;
    this.downloadGeneration = 0;
    this.updaterEventSequence = 0;
    this.downloadToken = null;
    this.updaterDownloadPromise = null;
    this.activeUpdaterDownload = null;
    this.manualDownloadController = null;
    this.manualDownloadPromise = null;
    this.manualInstallerPath = null;
    this.latestVersion = null;
    this.downloadedVersion = null;
    this.state = {
      phase: 'disabled',
      version: null,
      percent: 0,
      reason: '更新功能已关闭。',
    };
    this.updaterListeners = [];

    if (this.autoUpdater) this.configureUpdater();
  }

  get currentVersion() {
    const value = typeof this.currentVersionSource === 'function'
      ? this.currentVersionSource()
      : this.currentVersionSource;
    return String(value || this.app?.getVersion?.() || '0.0.0');
  }

  get installMode() {
    if (!this.packaged) return 'unsupported';
    if (this.platform === 'darwin' && !this.signedMac) return 'open-dmg';
    if (this.platform === 'win32' && this.portable) return 'unsupported';
    if ((this.platform === 'win32' || this.platform === 'darwin') && this.signedMac === true) return 'restart';
    if (this.platform === 'win32') return 'restart';
    return 'unsupported';
  }

  get packageSupported() {
    if (!this.packaged) return false;
    if (this.platform === 'win32') return !this.portable && Boolean(this.autoUpdater);
    if (this.platform === 'darwin') {
      return this.signedMac ? Boolean(this.autoUpdater) : Boolean(this.fetchImpl && this.shell?.openPath);
    }
    return false;
  }

  async policyEnabled() {
    if (!this.enabled || this.disposed) return false;
    let allowed = false;
    try {
      allowed = Boolean(await this.isEnabledCallback());
    } catch {}
    if (!this.enabled || this.disposed) return false;
    if (!allowed) {
      void this.setEnabled(false);
      return false;
    }
    return true;
  }

  status() {
    const mode = this.installMode;
    const active = this.enabled && !this.disposed;
    const supported = this.packageSupported;
    const ready = this.state.phase === 'ready'
      && this.downloadedVersion
      && this.downloadedVersion === this.state.version;
    const canDownload = active && supported && Boolean(this.latestVersion)
      && !['downloading', 'ready', 'installing', 'opening-installer', 'installer_opened'].includes(this.state.phase);
    const canInstall = active && supported && mode === 'restart' && Boolean(ready);
    return {
      phase: supported ? (active ? this.state.phase : 'disabled') : 'unsupported',
      version: this.state.version || this.latestVersion || null,
      currentVersion: this.currentVersion,
      percent: Number.isFinite(this.state.percent) ? this.state.percent : 0,
      reason: supported
        ? (active ? this.state.reason : '更新功能已关闭。')
        : this.unsupportedReason(),
      canInstall,
      canDownload,
      installMode: mode,
    };
  }

  unsupportedReason() {
    if (!this.packaged) return '开发或源码运行不检查更新。';
    if (this.platform === 'win32' && this.portable) return '便携版不支持应用内更新，请使用 NSIS 安装版。';
    if (this.platform === 'darwin' && !this.signedMac) {
      return '此 macOS 应用尚未签名，不能自动覆盖安装；可下载 DMG 并在 Finder 中手动替换应用。';
    }
    if (this.platform !== 'win32' && this.platform !== 'darwin') return '此平台暂不支持应用内更新。';
    return '当前安装方式暂不支持应用内更新。';
  }

  configureUpdater() {
    this.autoUpdater.autoDownload = false;
    this.autoUpdater.allowPrerelease = false;
    this.autoUpdater.allowDowngrade = false;
    this.autoUpdater.autoInstallOnAppQuit = false;
    if ('autoInstallEvent' in this.autoUpdater) this.autoUpdater.autoInstallEvent = 'manual';

    this.listen('checking-for-update', () => {
      if (!this.hasCurrentCheck()) return;
      this.setState({ phase: 'checking', version: this.latestVersion, percent: 0, reason: '正在检查稳定版更新。' });
    });
    this.listen('update-available', info => {
      if (!this.hasCurrentCheck()) return;
      if (this.acceptVersion(info?.version)) {
        this.setState({ phase: 'available', version: this.latestVersion, percent: 0, reason: '发现稳定版更新。' });
      }
    });
    this.listen('update-not-available', info => {
      if (!this.hasCurrentCheck()) return;
      const version = normalizeVersion(info?.version);
      this.latestVersion = null;
      this.downloadedVersion = null;
      if (version && compareVersions(version, this.currentVersion) === 0) {
        this.setState({ phase: 'current', version, percent: 0, reason: '当前已是最新稳定版。' });
      } else {
        this.setState({ phase: 'current', version: null, percent: 0, reason: '当前已是最新稳定版。' });
      }
    });
    this.listen('download-progress', info => {
      const active = this.activeUpdaterDownload;
      if (!this.hasCurrentUpdaterDownload()) return;
      void this.runDownloadEvent(active, () => {
        const percent = Number(info?.percent);
        this.setState({
          phase: 'downloading',
          version: active.version,
          percent: Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0,
          reason: '正在下载更新。',
        });
      });
    });
    this.listen('update-downloaded', info => {
      const active = this.activeUpdaterDownload;
      if (!this.hasCurrentUpdaterDownload()) return;
      void this.runDownloadEvent(active, () => {
        const version = normalizeVersion(info?.version || active.version);
        if (!version || version !== active.version || version !== this.latestVersion) return;
        this.downloadedVersion = version;
        this.setState({ phase: 'ready', version, percent: 100, reason: '更新已下载，可在确认后安装。' });
      });
    });
    this.listen('update-cancelled', () => {
      const active = this.activeUpdaterDownload;
      if (!this.hasCurrentUpdaterDownload()) return;
      void this.runDownloadEvent(active, () => {
        this.setState({ phase: 'cancelled', version: active.version, percent: 0, reason: '更新下载已取消。' });
      });
    });
    this.listen('error', error => {
      if (this.hasCurrentCheck()) {
        this.setState({ phase: 'error', version: this.latestVersion, percent: 0, reason: this.safeError(error) });
      }
      const active = this.activeUpdaterDownload;
      if (this.hasCurrentUpdaterDownload()) {
        void this.runDownloadEvent(active, () => {
          this.setState({ phase: 'error', version: active.version, percent: 0, reason: this.safeError(error) });
        });
      }
    });
  }

  listen(event, listener) {
    this.autoUpdater.on(event, listener);
    this.updaterListeners.push([event, listener]);
  }

  isAutoUpdaterActive() {
    return this.enabled && !this.disposed && this.packageSupported
      && !(this.platform === 'darwin' && !this.signedMac);
  }

  hasCurrentCheck() {
    return this.isAutoUpdaterActive() && this.activeCheckGeneration === this.checkGeneration;
  }

  hasCurrentUpdaterDownload() {
    const active = this.activeUpdaterDownload;
    return active !== null && this.isCurrentDownloadGeneration(active);
  }

  isCurrentDownloadGeneration(active) {
    return this.isAutoUpdaterActive()
      && active.generation === this.downloadGeneration
      && active.version === this.latestVersion
      && !active.token?.cancelled;
  }

  runDownloadEvent(active, apply) {
    const sequence = ++this.updaterEventSequence;
    if (!this.hasCurrentUpdaterDownload() || this.activeUpdaterDownload !== active) return;
    let policyResult;
    try { policyResult = this.isEnabledCallback(); } catch { policyResult = false; }
    const applyIfCurrent = allowed => {
      if (!allowed) {
        void this.setEnabled(false);
        return;
      }
      if (sequence !== this.updaterEventSequence || !this.isCurrentDownloadGeneration(active)) return;
      apply();
    };
    if (policyResult && typeof policyResult.then === 'function') {
      void Promise.resolve(policyResult).then(applyIfCurrent, () => applyIfCurrent(false));
      return;
    }
    applyIfCurrent(Boolean(policyResult));
  }

  async setEnabled(enabled) {
    const policyGeneration = ++this.policyGeneration;
    const shouldEnable = Boolean(enabled) && this.packageSupported && !this.disposed;
    if (!shouldEnable) {
      this.enabled = false;
      this.checkGeneration += 1;
      if (this.timer) this.clearIntervalFn(this.timer);
      this.timer = null;
      this.cancel();
      this.setState({ phase: 'disabled', version: this.latestVersion, percent: 0, reason: '更新功能已关闭。' });
      return this.status();
    }

    let effective = false;
    try { effective = Boolean(await this.isEnabledCallback()); } catch {}
    if (policyGeneration !== this.policyGeneration || this.disposed) return this.status();
    if (!effective) {
      this.enabled = false;
      if (this.timer) this.clearIntervalFn(this.timer);
      this.timer = null;
      this.checkGeneration += 1;
      this.cancel();
      this.setState({ phase: 'disabled', version: this.latestVersion, percent: 0, reason: '更新插件未启用。' });
      return this.status();
    }

    const wasEnabled = this.enabled;
    this.enabled = true;
    if (!this.timer && Number.isFinite(this.checkIntervalMs) && this.checkIntervalMs > 0) {
      this.timer = this.setIntervalFn(() => {
        if (this.enabled && !this.disposed) void this.check();
      }, this.checkIntervalMs);
      this.timer?.unref?.();
    }
    if (!wasEnabled) {
      this.setState({ phase: 'checking', version: this.latestVersion, percent: 0, reason: '正在检查稳定版更新。' });
      void this.check();
    }
    return this.status();
  }

  check() {
    if (this.checkPromise) {
      this.checkAgain = true;
      return this.checkPromise;
    }
    this.checkPromise = this.runCheck().finally(() => {
      this.checkPromise = null;
      const runAgain = this.checkAgain;
      this.checkAgain = false;
      if (runAgain && this.enabled && !this.disposed) void this.check();
    });
    return this.checkPromise;
  }

  async runCheck() {
    const requestedGeneration = this.checkGeneration;
    if (!(await this.policyEnabled()) || requestedGeneration !== this.checkGeneration
      || !this.enabled || this.disposed) return this.status();
    if (!this.packageSupported) return this.status();

    const generation = ++this.checkGeneration;
    this.activeCheckGeneration = generation;
    const checkController = this.platform === 'darwin' && !this.signedMac ? new AbortController() : null;
    if (checkController) this.checkAbortController = checkController;
    this.setState({ phase: 'checking', version: this.latestVersion, percent: 0, reason: '正在检查稳定版更新。' });
    try {
      const result = await (this.platform === 'darwin' && !this.signedMac
      ? this.checkMacRelease()
      : this.checkElectronRelease());
      if (generation !== this.checkGeneration || !(this.enabled && !this.disposed)) return this.status();
      if (result?.version) this.acceptVersion(result.version);
      else if (result?.current) {
        this.latestVersion = null;
        this.downloadedVersion = null;
        this.macReleaseAsset = null;
      }
      if (!this.latestVersion) {
        this.setState({
          phase: 'current',
          version: result?.current ? this.currentVersion : null,
          percent: 0,
          reason: '当前已是最新稳定版。',
        });
      } else {
        if (this.downloadedVersion === this.latestVersion
          && (this.platform !== 'darwin' || this.signedMac || this.manualInstallerPath)) {
          this.setState({
            phase: 'ready',
            version: this.latestVersion,
            percent: 100,
            reason: this.platform === 'darwin' && !this.signedMac
              ? 'DMG 已下载。选择“打开安装器”后，请在 Finder 中手动替换应用。'
              : '更新已下载，可在确认后安装。',
          });
        } else {
          this.setState({ phase: 'available', version: this.latestVersion, percent: 0, reason: '发现稳定版更新。' });
          let shouldDownload = false;
          try { shouldDownload = Boolean(await this.autoDownloadCallback()); } catch {}
          if (shouldDownload && generation === this.checkGeneration && this.enabled && !this.disposed) {
            void this.download(this.latestVersion);
          }
        }
      }
      return this.status();
    } catch (error) {
      if (generation === this.checkGeneration && this.enabled && !this.disposed) {
        this.setState({ phase: 'error', version: this.latestVersion, percent: 0, reason: this.safeError(error) });
      }
      return this.status();
    } finally {
      if (this.activeCheckGeneration === generation) this.activeCheckGeneration = null;
      if (this.checkAbortController === checkController) this.checkAbortController = null;
    }
  }

  async checkElectronRelease() {
    if (!this.autoUpdater) throw new Error('更新服务不可用。');
    const result = await this.autoUpdater.checkForUpdates();
    const info = result?.updateInfo || result?.versionInfo;
    if (result?.isUpdateAvailable === false) return { current: true };
    const version = normalizeVersion(info?.version);
    if (!version || compareVersions(version, this.currentVersion) <= 0) {
      this.latestVersion = null;
      return { current: true };
    }
    return { version };
  }

  async checkMacRelease() {
    this.macReleaseAsset = null;
    const response = await this.fetchAllowedAsset(RELEASES_API, this.checkAbortController?.signal, {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
    });
    if (!response.ok || !response.body) throw responseError(response, 'GitHub release check');
    const metadataLength = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(metadataLength) && metadataLength > MAX_RELEASE_METADATA_BYTES) {
      await response.body.cancel().catch(() => {});
      throw new Error('稳定版发布信息超过安全上限。');
    }
    const metadata = await this.readBoundedBody(response, MAX_RELEASE_METADATA_BYTES);
    let release;
    try { release = JSON.parse(metadata.toString('utf8')); }
    catch { throw new Error('稳定版发布信息无效。'); }
    if (release?.draft || release?.prerelease) return { current: true };
    const version = normalizeVersion(release?.tag_name);
    if (!version || compareVersions(version, this.currentVersion) <= 0) return { current: true };
    const name = this.macDmgName(version);
    const asset = Array.isArray(release.assets)
      ? release.assets.filter(item => item?.name === name)
      : [];
    if (asset.length !== 1 || typeof asset[0].browser_download_url !== 'string'
      || !this.isTrustedReleaseAssetUrl(asset[0].browser_download_url, release.tag_name, name)) {
      throw new Error('稳定版发布缺少此 Mac 架构的可信 DMG。');
    }
    const selected = asset[0];
    const size = Number(selected.size);
    if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_DMG_BYTES) {
      throw new Error('稳定版 DMG 大小无效或超过安全上限。');
    }
    const sha256 = await this.resolveMacAssetDigest(selected, release);
    if (!sha256) throw new Error('无法校验稳定版 DMG 的 SHA-256，已阻止打开。');
    this.macReleaseAsset = {
      version,
      tag: release.tag_name,
      name,
      url: selected.browser_download_url,
      size,
      sha256,
    };
    return { version };
  }

  macDmgName(version) {
    return 'Xueness-' + version + '-macos-' + this.arch + '.dmg';
  }

  isTrustedReleaseAssetUrl(value, tag, expectedName) {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port
        || url.username || url.password) return false;
      const pathParts = url.pathname.split('/').filter(Boolean).map(part => decodeURIComponent(part));
      return pathParts.length >= 6
        && pathParts[0] === OWNER
        && pathParts[1] === REPO
        && pathParts[2] === 'releases'
        && pathParts[3] === 'download'
        && pathParts[4] === tag
        && pathParts.slice(5).join('/') === expectedName;
    } catch {
      return false;
    }
  }

  async resolveMacAssetDigest(asset, release) {
    if (asset.digest !== undefined && asset.digest !== null) {
      const digest = /^sha256:([a-f0-9]{64})$/i.exec(String(asset.digest));
      return digest ? digest[1].toLowerCase() : null;
    }
    const checksumAssets = Array.isArray(release.assets)
      ? release.assets.filter(item => item?.name === 'SHA256SUMS.txt')
      : [];
    if (checksumAssets.length !== 1) return null;
    const checksum = checksumAssets[0];
    const checksumSize = Number(checksum.size);
    if (!Number.isSafeInteger(checksumSize) || checksumSize <= 0 || checksumSize > MAX_CHECKSUMS_BYTES
      || typeof checksum.browser_download_url !== 'string'
      || !this.isTrustedReleaseAssetUrl(checksum.browser_download_url, release.tag_name, 'SHA256SUMS.txt')) return null;
    const response = await this.fetchAllowedAsset(checksum.browser_download_url, this.checkAbortController?.signal);
    if (!response.ok || !response.body) {
      await response.body?.cancel?.().catch?.(() => {});
      return null;
    }
    const declaredSize = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declaredSize) && declaredSize > MAX_CHECKSUMS_BYTES) {
      await response.body.cancel().catch(() => {});
      return null;
    }
    const bytes = await this.readBoundedBody(response, MAX_CHECKSUMS_BYTES);
    if (bytes.length !== checksumSize) return null;
    const contents = bytes.toString('utf8');
    let selectedDigest = null;
    for (const line of contents.split(/\r?\n/)) {
      const match = /^\s*([a-f0-9]{64})\s+\*?(.+?)\s*$/i.exec(line);
      if (match && match[2] === asset.name) {
        if (selectedDigest) return null;
        selectedDigest = match[1].toLowerCase();
      }
    }
    return selectedDigest;
  }

  async readBoundedBody(response, maxBytes) {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        total += result.value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          throw new Error('校验文件超过安全上限。');
        }
        chunks.push(Buffer.from(result.value));
      }
      return Buffer.concat(chunks, total);
    } finally {
      reader.releaseLock();
    }
  }

  acceptVersion(rawVersion) {
    const version = normalizeVersion(rawVersion);
    if (!version || compareVersions(version, this.currentVersion) <= 0) {
      this.latestVersion = null;
      this.downloadedVersion = null;
      return false;
    }
    this.latestVersion = version;
    return true;
  }

  async download(version) {
    const requestedGeneration = this.downloadGeneration;
    if (!(await this.policyEnabled()) || requestedGeneration !== this.downloadGeneration
      || !this.enabled || this.disposed) return this.status();
    if (!this.packageSupported) return this.status();
    const normalized = normalizeVersion(version);
    if (!normalized || !this.latestVersion || normalized !== this.latestVersion) {
      this.setState({ phase: 'error', version: null, percent: 0, reason: '更新版本无效，请重新检查更新。' });
      return this.status();
    }
    if (this.downloadedVersion === normalized) return this.status();
    if (this.downloadToken || this.updaterDownloadPromise || this.manualDownloadController) return this.status();

    this.setState({ phase: 'downloading', version: normalized, percent: 0, reason: '正在下载更新。' });
    if (this.platform === 'darwin' && !this.signedMac) {
      this.startMacDmgDownload(normalized);
    } else {
      this.startUpdaterDownload(normalized);
    }
    return this.status();
  }

  startUpdaterDownload(version) {
    let token;
    try {
      token = this.createCancellationToken();
      this.downloadToken = token;
    } catch (error) {
      this.setState({ phase: 'error', version, percent: 0, reason: this.safeError(error) });
      return;
    }
    const generation = ++this.downloadGeneration;
    const active = { generation, version, token };
    this.activeUpdaterDownload = active;
    const task = Promise.resolve()
      .then(() => this.autoUpdater.downloadUpdate(token))
      .catch(error => {
        if (!this.hasCurrentUpdaterDownload() || active.generation !== generation || this.disposed) return;
        this.setState({ phase: 'error', version, percent: 0, reason: this.safeError(error) });
      })
      .finally(() => {
        if (this.downloadToken === token) this.downloadToken = null;
        if (this.activeUpdaterDownload === active) this.activeUpdaterDownload = null;
        if (this.updaterDownloadPromise === task) this.updaterDownloadPromise = null;
        token?.dispose?.();
      });
    this.updaterDownloadPromise = task;
  }

  startMacDmgDownload(version) {
    const generation = ++this.downloadGeneration;
    const controller = new AbortController();
    this.manualDownloadController = controller;
    this.manualDownloadPromise = this.downloadTrustedDmg(version, controller.signal, percent => {
      if (generation !== this.downloadGeneration || !this.enabled) return;
      this.setState({ phase: 'downloading', version, percent, reason: '正在下载 DMG 安装器。' });
    })
      .then(async path => {
        if (generation !== this.downloadGeneration || !this.enabled || this.disposed) {
          await fs.rm(path, { force: true }).catch(() => {});
          return;
        }
        this.manualInstallerPath = path;
        this.downloadedVersion = version;
        this.setState({
          phase: 'ready',
          version,
          percent: 100,
          reason: 'DMG 已下载。选择“打开安装器”后，请在 Finder 中手动替换应用。',
        });
      })
      .catch(error => {
        if (generation !== this.downloadGeneration || this.disposed || !this.enabled) return;
        if (controller.signal.aborted) {
          this.setState({ phase: 'cancelled', version, percent: 0, reason: 'DMG 下载已取消。' });
        } else {
          this.setState({ phase: 'error', version, percent: 0, reason: this.safeError(error) });
        }
      })
      .finally(() => {
        if (this.manualDownloadController === controller) this.manualDownloadController = null;
        this.manualDownloadPromise = null;
      });
  }

  async downloadTrustedDmg(version, signal, onProgress) {
    const release = this.macReleaseAsset;
    if (!release || release.version !== version || !this.isTrustedReleaseAssetUrl(release.url, release.tag, release.name)
      || !Number.isSafeInteger(release.size) || release.size <= 0 || release.size > MAX_DMG_BYTES
      || !/^[a-f0-9]{64}$/.test(release.sha256 || '')) {
      throw new Error('DMG 资产不属于已验证的稳定版。');
    }
    const response = await this.fetchAllowedAsset(release.url, signal);
    if (!response.ok || !response.body) {
      await response.body?.cancel?.().catch?.(() => {});
      throw responseError(response, 'DMG 下载');
    }
    const expectedLength = Number(response.headers?.get?.('content-length')) || 0;
    if (expectedLength > MAX_DMG_BYTES || (expectedLength > 0 && expectedLength !== release.size)) {
      await response.body.cancel().catch(() => {});
      throw new Error('DMG 文件大小与发布记录不符。');
    }
    const folder = join(this.userDataPath(), 'updates');
    await fs.mkdir(folder, { recursive: true, mode: 0o700 });
    const finalPath = join(folder, 'Xueness-' + version + '-macos-' + this.arch + '-' + randomUUID() + '.dmg');
    const tempPath = finalPath + '.partial';
    let transferred = 0;
    const sha256 = createHash('sha256');
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        transferred += chunk.length;
        if (transferred > release.size || transferred > MAX_DMG_BYTES) {
          callback(new Error('DMG 文件超过发布记录的大小。'));
          return;
        }
        sha256.update(chunk);
        if (expectedLength > 0) onProgress(Math.max(0, Math.min(99, transferred / expectedLength * 100)));
        callback(null, chunk);
      },
    });
    try {
      await pipeline(
        Readable.fromWeb(response.body),
        meter,
        createWriteStream(tempPath, { flags: 'wx', mode: 0o600 }),
        { signal },
      );
      if (transferred !== release.size) throw new Error('DMG 文件大小与发布记录不符。');
      if (sha256.digest('hex') !== release.sha256) throw new Error('DMG 的 SHA-256 校验失败。');
      await fs.rename(tempPath, finalPath);
      return finalPath;
    } catch (error) {
      await fs.rm(tempPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  async fetchAllowedAsset(initialUrl, signal, headers = {}) {
    let current = new URL(initialUrl);
    for (let redirects = 0; redirects <= 5; redirects += 1) {
      if (!supportsRedirect(current)) throw new Error('更新资产下载地址不可信。');
      const response = await this.fetchImpl(current, {
        redirect: 'manual',
        headers: { 'user-agent': 'Xueness-desktop-updater', ...headers },
        signal,
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      const location = response.headers?.get?.('location');
      if (!location) throw new Error('更新资产重定向无效。');
      current = new URL(location, current);
    }
    throw new Error('更新资产重定向次数过多。');
  }

  async verifyMacInstaller(version) {
    const release = this.macReleaseAsset;
    const filePath = this.manualInstallerPath;
    if (!release || release.version !== version || !filePath || !release.sha256) return false;
    try {
      const info = await fs.lstat(filePath);
      if (!info.isFile() || info.isSymbolicLink() || info.size !== release.size) return false;
      const digest = createHash('sha256');
      let size = 0;
      for await (const chunk of createReadStream(filePath)) {
        size += chunk.length;
        if (size > release.size) return false;
        digest.update(chunk);
      }
      return size === release.size && digest.digest('hex') === release.sha256;
    } catch {
      return false;
    }
  }

  async install(version, acknowledge) {
    if (!(await this.policyEnabled()) || !this.enabled || this.disposed) return this.status();
    const policyGeneration = this.policyGeneration;
    const normalized = normalizeVersion(version);
    if (!normalized || normalized !== this.latestVersion || normalized !== this.downloadedVersion
      || this.state.phase !== 'ready') {
      this.setState({ phase: 'error', version: this.latestVersion, percent: 0, reason: '请先下载当前稳定版更新。' });
      return this.status();
    }

    const isManualMac = this.platform === 'darwin' && !this.signedMac;
    if (isManualMac && !this.manualInstallerPath) return this.status();
    if (!isManualMac && (!this.packageSupported || this.installMode !== 'restart')) return this.status();
    if (isManualMac && !(await this.verifyMacInstaller(normalized))) {
      this.manualInstallerPath = null;
      this.downloadedVersion = null;
      this.setState({ phase: 'error', version: normalized, percent: 0, reason: 'DMG 完整性检查失败，已阻止打开。' });
      return this.status();
    }

    let preparation;
    try {
      preparation = await this.beforeInstall(normalized);
    } catch (error) {
      this.setState({ phase: 'ready', version: normalized, percent: 100, reason: this.safeError(error) });
      return this.status();
    }
    let stillAllowed = false;
    try { stillAllowed = Boolean(await this.isEnabledCallback()); } catch {}
    if (!stillAllowed || !this.enabled || this.disposed || policyGeneration !== this.policyGeneration) {
      if (!stillAllowed) void this.setEnabled(false);
      return this.status();
    }
    if (preparation !== true && preparation?.ok !== true) {
      this.setState({
        phase: 'ready',
        version: normalized,
        percent: 100,
        reason: this.safeError(new Error(String(preparation?.reason || '更新暂不能安装，请先结束正在运行的任务。'))),
      });
      return this.status();
    }

    const nextState = isManualMac
      ? {
          phase: 'opening-installer',
          version: normalized,
          percent: 100,
          reason: '正在打开 DMG。请在 Finder 中手动替换应用。',
        }
      : {
          phase: 'installing',
          version: normalized,
          percent: 100,
          reason: '正在退出并启动安装程序。',
        };
    this.setState(nextState);
    if (typeof acknowledge === 'function') acknowledge(this.status());

    try {
      if (typeof preparation?.afterReply === 'function') await preparation.afterReply();
      else if (typeof preparation?.afterAck === 'function') await preparation.afterAck();
      if (isManualMac) {
        const openError = await this.shell.openPath(this.manualInstallerPath);
        if (openError) {
          this.setState({ phase: 'ready', version: normalized, percent: 100, reason: '无法打开 DMG，请稍后重试。' });
        } else {
          this.setState({
            phase: 'installer_opened',
            version: normalized,
            percent: 100,
            reason: 'DMG 已在 Finder 中打开；请手动替换应用以完成更新。',
          });
        }
      } else {
        this.installCommitted = true;
        this.autoUpdater.quitAndInstall(false, true);
      }
    } catch (error) {
      this.installCommitted = false;
      this.setState({ phase: 'ready', version: normalized, percent: 100, reason: this.safeError(error) });
    }
    return this.status();
  }

  async handleRequest(message, reply) {
    if (!message || message.type !== 'update' || typeof message.id !== 'string' || !REQUEST_ID.test(message.id)) return false;
    if (!['status', 'check', 'download', 'install', 'cancel'].includes(message.action)) {
      reply({ id: message.id, state: { ...this.status(), reason: '更新请求无效。' } });
      return true;
    }

    const acknowledge = state => reply({ id: message.id, state });
    let state;
    try {
      switch (message.action) {
        case 'status':
          state = this.status();
          acknowledge(state);
          break;
        case 'check':
          state = await this.check();
          acknowledge(state);
          break;
        case 'download':
          state = await this.download(message.version);
          acknowledge(state);
          break;
        case 'install':
          {
            let acknowledged = false;
            const acknowledgeInstall = response => { acknowledged = true; acknowledge(response); };
            state = await this.install(message.version, acknowledgeInstall);
            if (!acknowledged) acknowledge(state);
          }
          break;
        case 'cancel':
          this.cancel();
          state = this.status();
          acknowledge(state);
          break;
      }
    } catch (error) {
      state = { ...this.status(), phase: 'error', reason: this.safeError(error) };
      acknowledge(state);
    }
    return true;
  }

  cancel() {
    this.checkGeneration += 1;
    this.activeCheckGeneration = null;
    this.downloadGeneration += 1;
    this.activeUpdaterDownload = null;
    if (this.checkAbortController) {
      this.checkAbortController.abort();
      this.checkAbortController = null;
    }
    if (this.downloadToken) {
      this.downloadToken.cancel?.();
      this.downloadToken = null;
    }
    if (this.manualDownloadController) {
      this.manualDownloadController.abort();
      this.manualDownloadController = null;
    }
    this.setState({ phase: this.enabled ? 'cancelled' : 'disabled', version: this.latestVersion, percent: 0,
      reason: this.enabled ? '更新下载已取消。' : '更新功能已关闭。' });
  }

  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.enabled = false;
    if (this.timer) this.clearIntervalFn(this.timer);
    this.timer = null;
    this.checkGeneration += 1;
    if (this.installCommitted) {
      this.activeCheckGeneration = null;
      this.activeUpdaterDownload = null;
      this.downloadGeneration += 1;
      if (this.checkAbortController) {
        this.checkAbortController.abort();
        this.checkAbortController = null;
      }
      if (this.manualDownloadController) {
        this.manualDownloadController.abort();
        this.manualDownloadController = null;
      }
    } else {
      this.cancel();
    }
    for (const [event, listener] of this.updaterListeners) {
      this.autoUpdater?.removeListener?.(event, listener);
    }
    this.updaterListeners = [];
  }

  setState(state) {
    if (this.disposed) return;
    this.state = { ...this.state, ...state };
    try { void Promise.resolve(this.publish(this.status())).catch(() => {}); } catch {}
  }

  safeError(error) {
    const message = typeof error?.message === 'string' ? error.message : String(error || '更新失败。');
    return message
      .replace(/https?:\/\/[^\s)]+/gi, '更新服务器')
      .replace(/["'](?:[A-Z]:\\|\/)[^"']*["']/gi, '本地路径')
      .replace(/(?:^|\s)(?:[A-Z]:\\|\/)[^\r\n]*/gi, ' 本地路径')
      .slice(0, 400);
  }
}

module.exports = {
  UpdateCoordinator,
  OWNER,
  REPO,
  RELEASES_API,
  normalizeVersion,
  compareVersions,
};
