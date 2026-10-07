const { app, BrowserWindow, Menu, dialog, shell, net, ipcMain, Tray, screen, systemPreferences } = require('electron');
const { join, resolve } = require('node:path');
const { existsSync, mkdirSync, writeFileSync } = require('node:fs');
const { Backend } = require('./backend.cjs');
const { isOwnedUrl, isExternalUrl, installPermissionPolicy } = require('./security.cjs');
const { getWindowChromeOptions, installWindowThemeSync } = require('./window-chrome.cjs');
const { createDesktopBackground, handleSecondInstance } = require('./desktop-background.cjs');
const { UpdateCoordinator } = require('./update-coordinator.cjs');
const { createElectronAssetRequest } = require('./electron-net-asset.cjs');
const { createPermissionsHandler } = require('./permissions.cjs');
const { buildApplicationMenu, getNativeLabels } = require('./native-labels.cjs');
const { autoUpdater } = require('electron-updater');

let window, backend, updater, background, quitting = false;
let updatePolicy = false, autoDownloadUpdates = true;
let desktopLocale = 'zh', applicationMenuReady = false;
app.setName('Xueness');
if (process.env.XUENESS_DESKTOP_DATA) app.setPath('userData', resolve(process.env.XUENESS_DESKTOP_DATA));
if (!app.requestSingleInstanceLock()) app.quit();
else if (process.argv.includes('--quit')) app.quit();
else {
  ipcMain.on('xueness:desktop-locale', (event, locale) => {
    if (!window || window.isDestroyed() || event.sender !== window.webContents
        || event.senderFrame !== window.webContents.mainFrame
        || !isOwnedUrl(event.senderFrame?.url, backend?.origin)
        || !['zh', 'en'].includes(locale) || locale === desktopLocale) return;
    desktopLocale = locale;
    if (applicationMenuReady) installApplicationMenu();
  });
  app.on('second-instance', (_event, argv) => handleSecondInstance(argv, {
    quit: () => app.quit(), show: showMainWindow,
  }));
  app.on('before-quit', event => {
    background?.dispose();
    void updater?.dispose();
    if (!quitting && backend) {
      event.preventDefault(); quitting = true;
      void backend.stop().finally(() => app.quit());
    }
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  // macOS convention: closing the last window keeps the app alive in the dock;
  // clicking the dock icon reopens the main window.
  app.on('activate', () => {
    if (process.platform !== 'darwin') return;
    showMainWindow();
  });
  app.whenReady().then(start).catch(async error => {
    if (process.env.XUENESS_DESKTOP_SMOKE_FILE) {
      writeFileSync(process.env.XUENESS_DESKTOP_SMOKE_FILE, JSON.stringify({ error: 'desktop startup failed', reason: error.message }));
      if (backend) await backend.stop(); app.exit(1); return;
    }
    const labels = getNativeLabels(desktopLocale);
    dialog.showErrorBox(labels.startupErrorTitle, labels.startupErrorMessage);
    app.quit();
  });
}

function createMainWindow() {
  const root = resolve(__dirname, '../..');
  const iconPath = app.isPackaged ? join(process.resourcesPath, 'webapp/favicon.ico') : join(root, 'webapp/public/favicon.ico');
  const created = new BrowserWindow({ width: 1280, height: 840, minWidth: 760, minHeight: 540,
    title: 'Xueness', icon: iconPath, backgroundColor: '#171717', show: false,
    ...getWindowChromeOptions(process.platform),
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false,
      preload: join(__dirname, 'window-theme-preload.cjs'),
      webSecurity: true, spellcheck: false, webviewTag: false } });
  installWindowThemeSync({ ipcMain, window: created, getOrigin: () => backend.origin });
  background = createDesktopBackground({ app, window: created, Tray, Menu, ipcMain, iconPath,
    getOrigin: () => backend.origin, getLocale: () => desktopLocale, isQuitting: () => quitting,
    BrowserWindow, screen, getBackend: () => backend, shell });
  created.once('ready-to-show', () => created.show());
  return created;
}

function showMainWindow() {
  if (quitting) return;
  if (window && !window.isDestroyed()) {
    if (window.isMinimized()) window.restore();
    window.show(); window.focus(); return;
  }
  // Startup may not have completed yet.
  if (!backend || !backend.origin) return;
  const target = createMainWindow();
  window = target;
  attachWindowSecurity(target, backend.origin);
  void target.loadURL(`${backend.origin}/?xuenessDesktop=1`).catch(() => {
    // A failed reopen otherwise leaves a blank window while the app appears live.
    if (quitting || window !== target || target.isDestroyed()) return;
    const labels = getNativeLabels(desktopLocale);
    dialog.showErrorBox(labels.startupErrorTitle, labels.reopenErrorMessage);
    app.quit();
  });
}

function installApplicationMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildApplicationMenu(desktopLocale, process.platform)));
  applicationMenuReady = true;
}

// Per-window security wiring: desktop token injection and navigation guards.
// Re-applied whenever the main window is recreated (macOS dock reopen).
function attachWindowSecurity(target, origin) {
  const session = target.webContents.session;
  installPermissionPolicy(session, target.webContents, origin);
  session.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders };
    if (isOwnedUrl(details.url, origin)) headers['X-Xueness-Desktop-Token'] = backend.token;
    callback({ requestHeaders: headers });
  });
  const external = url => { if (isExternalUrl(url)) void shell.openExternal(url).catch(() => {}); };
  target.webContents.on('will-navigate', (event, url) => {
    if (!isOwnedUrl(url, origin)) { event.preventDefault(); external(url); }
  });
  target.webContents.on('will-redirect', (event, url) => { if (!isOwnedUrl(url, origin)) event.preventDefault(); });
  target.webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: 'deny' }; });
  target.webContents.on('will-attach-webview', event => event.preventDefault());
  target.webContents.on('will-prevent-unload', event => event.preventDefault());
}

async function start() {
  const root = resolve(__dirname, '../..');
  const data = app.getPath('userData'); mkdirSync(data, { recursive: true, mode: 0o700 });
  const executable = app.isPackaged
    ? join(process.resourcesPath, 'backend', process.platform === 'win32' ? 'xueness-backend.exe' : 'xueness-backend')
    : process.env.XUENESS_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  if (app.isPackaged && !existsSync(executable)) throw new Error('Missing bundled backend');
  backend = new Backend({ executable, args: app.isPackaged ? [] : [join(root, 'desktop/entrypoint.py')],
    cwd: app.isPackaged ? data : root, data, node: process.execPath,
    playwright: app.isPackaged ? join(process.resourcesPath, 'browser-runtime/node_modules/playwright/index.mjs') : join(root, 'webapp/node_modules/playwright/index.mjs'),
    assets: app.isPackaged ? join(process.resourcesPath, 'webapp') : join(root, 'webapp/dist') });
  const handlePermissionRequest = createPermissionsHandler({
    platform: process.platform,
    systemPreferences,
    shell,
    getOwnerWindow: () => window,
    getBackend: () => backend,
  });
  const sendPermissionReply = message => {
    try { if (message) backend.reply(message); } catch { /* The parent pipe may close during shutdown. */ }
  };
  backend.on('permissions', message => {
    void handlePermissionRequest(message)
      .then(sendPermissionReply, () => sendPermissionReply({ id: message.id, error: 'unavailable' }));
  });
  updater = new UpdateCoordinator({ app, autoUpdater, shell, signedMac: false,
    assetRequestImpl: createElectronAssetRequest(net),
    isEnabled: () => updatePolicy,
    autoDownload: () => autoDownloadUpdates,
    beforeInstall: async () => {
      const labels = getNativeLabels(desktopLocale);
      if (!backend.origin || !updatePolicy) return { ok: false, reason: labels.updateNotReady };
      const headers = { 'X-Xueness-Desktop-Token': backend.token };
      const csrfResponse = await fetch(backend.origin + '/api/csrf', { headers, redirect: 'error', signal: AbortSignal.timeout(5000) });
      if (!csrfResponse.ok) return { ok: false, reason: labels.updatePermission };
      const csrf = await csrfResponse.json();
      const prepared = await fetch(backend.origin + '/api/updates/prepare-install', { method: 'POST', redirect: 'error',
        headers: { ...headers, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf.csrfToken },
        body: JSON.stringify(updater.installMode === 'open-dmg' ? { checkOnly: true } : {}), signal: AbortSignal.timeout(5000) });
      const result = await prepared.json();
      if (!prepared.ok || result.ok !== true) return { ok: false, reason: result.reason || labels.updateBusy };
      if (updater.installMode === 'open-dmg') return { ok: true };
      return { ok: true, afterReply: async () => { quitting = true; await backend.stop(); } };
    },
  });
  backend.on('update-policy', policy => {
    updatePolicy = policy.enabled;
    autoDownloadUpdates = policy.autoDownload !== false;
    void updater.setEnabled(updatePolicy);
  });
  backend.on('update', message => { void updater.handleRequest(message, result => backend.reply(result)); });
  window = createMainWindow();
  await window.loadFile(join(__dirname, 'loading.html'));
  const origin = await backend.start();
  // The user can close the startup window while the backend is still starting.
  // macOS keeps the app alive in that case, so restore a live window before
  // attaching security handlers or loading the workbench.
  if (!window || window.isDestroyed()) {
    window = createMainWindow();
    await window.loadFile(join(__dirname, 'loading.html'));
  }
  attachWindowSecurity(window, origin);
  let choosing = false;
  backend.on('dialog', async message => {
    if (choosing || !window || window.isDestroyed()) { backend.reply({ id: message.id, error: 'unavailable' }); return; }
    choosing = true;
    try {
      const result = await dialog.showOpenDialog(window, { title: getNativeLabels(desktopLocale).projectFolderTitle,
        properties: ['openDirectory', 'createDirectory'],
        ...(typeof message.initialRoot === 'string' ? { defaultPath: message.initialRoot } : {}) });
      backend.reply({ id: message.id, path: result.canceled ? null : result.filePaths[0] || null });
    } catch { backend.reply({ id: message.id, error: 'unavailable' }); }
    finally { choosing = false; }
  });
  backend.on('failure', () => {
    if (!quitting) {
      const labels = getNativeLabels(desktopLocale);
      dialog.showErrorBox(labels.backendStoppedTitle, labels.backendStoppedMessage); app.quit();
    }
  });
  installApplicationMenu();
  const desktopChrome = process.platform === 'darwin' || process.platform === 'win32';
  let smokePermissionPostRequests = 0;
  if (process.env.XUENESS_DESKTOP_SMOKE_FILE) {
    window.webContents.session.webRequest.onBeforeRequest({ urls: [`${origin}/*`] }, (details, callback) => {
      if (details.requestMethod === 'POST' && new URL(details.url).pathname === '/api/desktop/permissions/request') {
        smokePermissionPostRequests += 1;
      }
      callback({});
    });
  }
  await window.loadURL(desktopChrome || process.env.XUENESS_DESKTOP_SMOKE_FILE
    ? `${origin}/?xuenessDesktop=1` : origin);
  if (process.env.XUENESS_DESKTOP_SMOKE_FILE) {
    const result = await window.webContents.executeJavaScript(String.raw`(async () => {
      const waitFor = async selector => {
        for (let n=0;n<100;n++) { const element=document.querySelector(selector); if (element) return element;
          await new Promise(resolve => setTimeout(resolve,100)); }
        throw new Error('UI did not render: '+selector);
      };
      for (let n=0;n<100 && !document.querySelector('[data-testid=xn-shell] [data-testid=xn-sidebar-action-new-task]');n++)
        await new Promise(resolve => setTimeout(resolve,100));
      const workbenchReady = !!document.querySelector('[data-testid=xn-shell] [data-testid=xn-sidebar-action-new-task]');
      if (!workbenchReady) throw new Error('Workbench did not render');
      const response = await fetch('/api/plugins'); const catalog = await response.json();
      const permissionOnboarding = await waitFor('[data-testid=desktop-permission-onboarding]');
      const onboardingSeen = !!permissionOnboarding;
      (await waitFor('[data-testid=desktop-permission-onboarding-skip-all]')).click();
      for (let n=0;n<100 && document.querySelector('[data-testid=desktop-permission-onboarding]');n++)
        await new Promise(resolve => setTimeout(resolve,100));
      const onboardingClosed = !document.querySelector('[data-testid=desktop-permission-onboarding]');
      if (!onboardingClosed) throw new Error('Permission guide did not close after skipping');
      const onboardingResponse = await fetch('/api/onboarding/desktop');
      const onboardingState = await onboardingResponse.json();
      const permissionResponse = await fetch('/api/desktop/permissions');
      const permissionSnapshot = await permissionResponse.json();
      const allowedPermissionStatuses = new Set(['granted','not-determined','denied','restricted','unknown','unsupported']);
      const permissionSnapshotValid = permissionResponse.ok && typeof permissionSnapshot.platform === 'string'
        && Array.isArray(permissionSnapshot.permissions) && permissionSnapshot.permissions.length === 4
        && ['accessibility','screen','fullDisk','microphone'].every(id => {
          const row = permissionSnapshot.permissions.find(item => item.id === id);
          return !!row && allowedPermissionStatuses.has(row.status) && typeof row.canRequest === 'boolean';
        });
      const permissionRows = Array.isArray(permissionSnapshot.permissions) ? permissionSnapshot.permissions : [];
      const fullDisk = permissionRows.find(item => item.id === 'fullDisk');
      const screen = permissionRows.find(item => item.id === 'screen');
      const permissionStatusHonest = permissionSnapshot.platform === 'darwin' ? fullDisk?.status === 'unknown'
        : permissionSnapshot.platform === 'win32' ? fullDisk?.status === 'unsupported' && screen?.status === 'unsupported'
          : permissionRows.every(item => item.status === 'unsupported') && permissionRows.length === 4;
      const settingsButton = document.querySelector('.xn-sidebar-footer__action[data-sidebar-navigate="true"]');
      if (!settingsButton) throw new Error('Settings action did not render');
      settingsButton.click();
      (await waitFor('[data-testid=xn-settings-nav-plugins]')).click();
      await waitFor('[data-testid=xn-installed-plugin-desktop]');
      const installedCards = document.querySelectorAll('[data-testid^="xn-installed-plugin-"]').length;
      document.querySelector('.xn-settings-view__extensions > summary').click();
      (await waitFor('[data-testid=xn-settings-nav-about]')).click();
      const dataDirectoryNode = await waitFor('[data-testid=desktop-data-directory]');
      const about = dataDirectoryNode.closest('[data-testid=desktop-about]');
      const versionText = about?.querySelector('header span')?.textContent || '';
      const version = versionText.match(/\d+\.\d+\.\d+(?:[-+][\w.-]+)?/)?.[0] || '';
      const aboutDataDirectory = dataDirectoryNode.textContent?.trim() || '';
      const oldDesktopNavAbsent = !document.querySelector('[data-testid=xn-settings-nav-desktop]');
      const clipWrite = await navigator.permissions.query({ name: 'clipboard-write' });
      const clipRead = await navigator.permissions.query({ name: 'clipboard-read' });
      const titlebar = document.querySelector('[data-testid=xn-desktop-titlebar]');
      const titlebarBrand = titlebar?.querySelector('.xn-desktop-titlebar__brand');
      const titlebarActions = titlebar?.querySelector('.xn-desktop-titlebar__actions');
      const titlebarInsets = titlebar && titlebarBrand && titlebarActions ? {
        brandLeft: Math.round(titlebarBrand.getBoundingClientRect().left),
        actionsRight: Math.round(window.innerWidth - titlebarActions.getBoundingClientRect().right),
      } : null;
      const windowBgToken = getComputedStyle(document.documentElement).getPropertyValue('--bg-window').trim();
      return { title: document.title, plugins: catalog.plugins.length,
        features: catalog.plugins.reduce((n,p) => n+p.features.length,0),
        onboardingSeen, onboardingClosed,
        onboardingCompleted: onboardingResponse.ok && onboardingState.completed === true,
        permissionSnapshotValid, permissionStatusHonest, permissionPlatform: permissionSnapshot.platform,
        permissionSnapshot,
        installedCards, aboutReady: !!about && !!version && !!aboutDataDirectory,
        aboutVersion: version, aboutDataDirectory, oldDesktopNavAbsent,
        titlebarPlatform: titlebar?.dataset.platform || null, titlebarInsets, windowBgToken,
        nodeAccess: typeof window.require !== 'undefined', workbenchReady, body: document.body.textContent.length,
        clipWriteGranted: clipWrite.state === 'granted', clipReadDenied: clipRead.state === 'denied' };
    })()`);
    let dockTaskPopupReady = null;
    if (process.platform === 'darwin') {
      const tasks = app.dock?.getMenu?.()?.items?.find(item => ['任务与项目', 'Tasks and projects'].includes(item.label));
      if (tasks && BrowserWindow.getAllWindows) {
        tasks.click();
        dockTaskPopupReady = false;
        for (let attempt = 0; attempt < 100 && !dockTaskPopupReady; attempt++) {
          const popup = BrowserWindow.getAllWindows().find(candidate => candidate !== window && !candidate.isDestroyed()
            && candidate.webContents.getURL().startsWith(origin + '/api/desktop/tray'));
          if (popup) {
            try { dockTaskPopupReady = await popup.webContents.executeJavaScript("!!document.querySelector('.xn-tray-menu button[role=menuitem]')"); }
            catch { /* The popup may still be loading its production entry. */ }
          }
          if (!dockTaskPopupReady) await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
    }
    writeFileSync(process.env.XUENESS_DESKTOP_SMOKE_FILE, JSON.stringify({ ...result,
      dockTaskPopupReady,
      nativeBackground: window.getBackgroundColor?.() || null,
      nativeMenuLabels: Menu.getApplicationMenu?.()?.items?.map(item => item.label) || [],
      dockMenuLabels: app.dock?.getMenu?.()?.items?.map(item => item.label) || [],
      permissionPostRequests: smokePermissionPostRequests, noPermissionRequests: smokePermissionPostRequests === 0,
      updates: updater.status() }));
    app.quit();
  }
}
