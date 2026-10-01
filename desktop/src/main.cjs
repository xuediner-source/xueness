const { app, BrowserWindow, Menu, dialog, shell } = require('electron');
const { join, resolve } = require('node:path');
const { existsSync, mkdirSync, writeFileSync } = require('node:fs');
const { Backend } = require('./backend.cjs');
const { isOwnedUrl, isExternalUrl } = require('./security.cjs');

let window, backend, quitting = false;
app.setName('Xueness');
if (process.env.XUENESS_DESKTOP_DATA) app.setPath('userData', resolve(process.env.XUENESS_DESKTOP_DATA));
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
  app.on('before-quit', event => {
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
  const data = app.getPath('userData'); mkdirSync(data, { recursive: true, mode: 0o700 });
  const executable = app.isPackaged
    ? join(process.resourcesPath, 'backend', process.platform === 'win32' ? 'xueness-backend.exe' : 'xueness-backend')
    : process.env.XUENESS_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  if (app.isPackaged && !existsSync(executable)) throw new Error('Missing bundled backend');
  backend = new Backend({ executable, args: app.isPackaged ? [] : [join(root, 'desktop/entrypoint.py')],
    cwd: app.isPackaged ? data : root, data,
    assets: app.isPackaged ? join(process.resourcesPath, 'webapp') : join(root, 'webapp/dist') });
  window = new BrowserWindow({ width: 1280, height: 840, minWidth: 760, minHeight: 540,
    title: 'Xueness', backgroundColor: '#171717', show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false,
      webSecurity: true, spellcheck: false, webviewTag: false } });
  window.once('ready-to-show', () => window.show());
  await window.loadFile(join(__dirname, 'loading.html'));
  const origin = await backend.start();
  const session = window.webContents.session;
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
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
  await window.loadURL(origin);
  if (process.env.XUENESS_DESKTOP_SMOKE_FILE) {
    const result = await window.webContents.executeJavaScript(`(async () => {
      for (let n=0;n<100 && !document.querySelector('[data-testid=xn-shell] [data-testid=xn-sidebar-action-new-task]');n++)
        await new Promise(resolve => setTimeout(resolve,100));
      if (!document.querySelector('[data-testid=xn-shell] [data-testid=xn-sidebar-action-new-task]')) throw new Error('Workbench did not render');
      const response = await fetch('/api/plugins'); const catalog = await response.json();
      return { title: document.title, plugins: catalog.plugins.length,
        features: catalog.plugins.reduce((n,p) => n+p.features.length,0),
        nodeAccess: typeof window.require !== 'undefined', workbenchReady: !!document.querySelector('[data-testid=xn-shell] [data-testid=xn-sidebar-action-new-task]'), body: document.body.textContent.length };
    })()`);
    writeFileSync(process.env.XUENESS_DESKTOP_SMOKE_FILE, JSON.stringify(result));
    app.quit();
  }
}
