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
const { autoUpdater } = require('electron-updater');

let window, backend, updater, background, quitting = false;
let updatePolicy = false, autoDownloadUpdates = true;
app.setName('Xueness');
if (process.env.XUENESS_DESKTOP_DATA) app.setPath('userData', resolve(process.env.XUENESS_DESKTOP_DATA));
if (!app.requestSingleInstanceLock()) app.quit();
else if (process.argv.includes('--quit')) app.quit();
else {
  app.on('second-instance', (_event, argv) => handleSecondInstance(argv, {
    quit: () => app.quit(), show: () => background?.show(),
  }));
  app.on('before-quit', event => {
    background?.dispose();
    void updater?.dispose();
    if (!quitting && backend) {
      event.preventDefault(); quitting = true;
      void backend.stop().finally(() => app.quit());
    }
  });
  app.on('window-all-closed', () => app.quit());
  app.whenReady().then(start).catch(async error => {
    if (process.env.XUENESS_DESKTOP_SMOKE_FILE) {
      writeFileSync(process.env.XUENESS_DESKTOP_SMOKE_FILE, JSON.stringify({ error: 'desktop startup failed', reason: error.message }));
      if (backend) await backend.stop(); app.exit(1); return;
    }
    dialog.showErrorBox('Xueness 启动失败', '无法启动内置后端。请确认应用文件完整，并重新打开 Xueness。你的会话与模型配置保留在应用数据目录中。');
    app.quit();
  });
}

async function start() {
  const root = resolve(__dirname, '../..');
  const iconPath = app.isPackaged ? join(process.resourcesPath, 'webapp/favicon.ico') : join(root, 'webapp/public/favicon.ico');
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
      if (!backend.origin || !updatePolicy) return { ok: false, reason: '更新服务尚未准备完成。' };
      const headers = { 'X-Xueness-Desktop-Token': backend.token };
      const csrfResponse = await fetch(backend.origin + '/api/csrf', { headers, redirect: 'error', signal: AbortSignal.timeout(5000) });
      if (!csrfResponse.ok) return { ok: false, reason: '无法确认桌面更新权限。' };
      const csrf = await csrfResponse.json();
      const prepared = await fetch(backend.origin + '/api/updates/prepare-install', { method: 'POST', redirect: 'error',
        headers: { ...headers, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf.csrfToken },
        body: JSON.stringify(updater.installMode === 'open-dmg' ? { checkOnly: true } : {}), signal: AbortSignal.timeout(5000) });
      const result = await prepared.json();
      if (!prepared.ok || result.ok !== true) return { ok: false, reason: result.reason || '请先结束当前任务，再重启更新。' };
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
  window = new BrowserWindow({ width: 1280, height: 840, minWidth: 760, minHeight: 540,
    title: 'Xueness', icon: iconPath, backgroundColor: '#171717', show: false,
    ...getWindowChromeOptions(process.platform),
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false,
      preload: join(__dirname, 'window-theme-preload.cjs'),
      webSecurity: true, spellcheck: false, webviewTag: false } });
  installWindowThemeSync({ ipcMain, window, getOrigin: () => backend.origin });
  background = createDesktopBackground({ app, window, Tray, Menu, ipcMain, iconPath,
    getOrigin: () => backend.origin, isQuitting: () => quitting, BrowserWindow, screen, getBackend: () => backend, shell });
  window.once('ready-to-show', () => window.show());
  await window.loadFile(join(__dirname, 'loading.html'));
  const origin = await backend.start();
  const session = window.webContents.session;
  installPermissionPolicy(session, window.webContents, origin);
  session.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders };
    if (isOwnedUrl(details.url, origin)) headers['X-Xueness-Desktop-Token'] = backend.token;
    callback({ requestHeaders: headers });
  });
  const external = url => { if (isExternalUrl(url)) void shell.openExternal(url).catch(() => {}); };
  window.webContents.on('will-navigate', (event, url) => {
    if (!isOwnedUrl(url, origin)) { event.preventDefault(); external(url); }
  });
  window.webContents.on('will-redirect', (event, url) => { if (!isOwnedUrl(url, origin)) event.preventDefault(); });
  window.webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: 'deny' }; });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.on('will-prevent-unload', event => event.preventDefault());
  let choosing = false;
  backend.on('dialog', async message => {
    if (choosing || !window || window.isDestroyed()) { backend.reply({ id: message.id, error: 'unavailable' }); return; }
    choosing = true;
    try {
      const result = await dialog.showOpenDialog(window, { title: '选择项目文件夹',
        properties: ['openDirectory', 'createDirectory'],
        ...(typeof message.initialRoot === 'string' ? { defaultPath: message.initialRoot } : {}) });
      backend.reply({ id: message.id, path: result.canceled ? null : result.filePaths[0] || null });
    } catch { backend.reply({ id: message.id, error: 'unavailable' }); }
    finally { choosing = false; }
  });
  backend.on('failure', () => {
    if (!quitting) { dialog.showErrorBox('Xueness 后端已停止', '请重新打开应用以恢复会话。已保存的数据不会删除。'); app.quit(); }
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' },
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: '视图', submenu: [{ role: 'reload' }, { role: 'resetZoom' }, { role: 'zoomIn' },
      { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
    { role: 'windowMenu' },
    ...(process.platform !== 'darwin' ? [{ label: '文件', submenu: [{ role: 'quit' }] }] : []),
  ]));
  const desktopChrome = process.platform === 'darwin' || process.platform === 'win32';
  let smokePermissionPostRequests = 0;
  if (process.env.XUENESS_DESKTOP_SMOKE_FILE) {
    session.webRequest.onBeforeRequest({ urls: [`${origin}/*`] }, (details, callback) => {
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
      document.querySelector('button[aria-label="打开设置"]').click();
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
      return { title: document.title, plugins: catalog.plugins.length,
        features: catalog.plugins.reduce((n,p) => n+p.features.length,0),
        onboardingSeen, onboardingClosed,
        onboardingCompleted: onboardingResponse.ok && onboardingState.completed === true,
        permissionSnapshotValid, permissionStatusHonest, permissionPlatform: permissionSnapshot.platform,
        permissionSnapshot,
        installedCards, aboutReady: !!about && !!version && !!aboutDataDirectory,
        aboutVersion: version, aboutDataDirectory, oldDesktopNavAbsent,
        nodeAccess: typeof window.require !== 'undefined', workbenchReady, body: document.body.textContent.length,
        clipWriteGranted: clipWrite.state === 'granted', clipReadDenied: clipRead.state === 'denied' };
    })()`);
    writeFileSync(process.env.XUENESS_DESKTOP_SMOKE_FILE, JSON.stringify({ ...result,
      permissionPostRequests: smokePermissionPostRequests, noPermissionRequests: smokePermissionPostRequests === 0,
      updates: updater.status() }));
    app.quit();
  }
}
