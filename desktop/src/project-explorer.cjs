const { stat } = require('node:fs/promises');
const { isAbsolute, resolve } = require('node:path');
const { isOwnedUrl } = require('./security.cjs');

/** Open a directory selected through the existing workspace boundary. */
function installProjectExplorer({ ipcMain, getWindow, getBackend, shell, fetchImpl = fetch, statImpl = stat }) {
  ipcMain.handle('xueness:open-project', async (event, root) => {
    const window = getWindow(), backend = getBackend();
    if (!window || window.isDestroyed() || event.sender !== window.webContents
        || event.senderFrame !== window.webContents.mainFrame
        || !isOwnedUrl(event.senderFrame?.url, backend?.origin)) return { ok: false, error: 'unavailable' };
    if (typeof root !== 'string' || !isAbsolute(root) || root.includes('\0')) return { ok: false, error: 'invalid-directory' };
    try {
      const options = { headers: { 'X-Xueness-Desktop-Token': backend.token }, redirect: 'error', signal: AbortSignal.timeout(5000) };
      const plugins = await fetchImpl(backend.origin + '/api/plugins', options);
      if (!plugins.ok) return { ok: false, error: 'unavailable' };
      const catalog = await plugins.json();
      if (!['desktop', 'files', 'sessions'].every(id => catalog.plugins?.some(plugin => plugin.id === id && plugin.effective === true))) {
        return { ok: false, error: 'plugin-disabled' };
      }
      const response = await fetchImpl(backend.origin + '/api/workspaces?path=' + encodeURIComponent(root), options);
      if (!response.ok) return { ok: false, error: 'directory-unavailable' };
      const selected = (await response.json()).picker?.path;
      const normalized = path => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
      if (typeof selected !== 'string' || normalized(selected) !== normalized(root) || !(await statImpl(selected)).isDirectory()) {
        return { ok: false, error: 'directory-unavailable' };
      }
      const error = await shell.openPath(selected);
      return error ? { ok: false, error: 'open-failed' } : { ok: true };
    } catch { return { ok: false, error: 'open-failed' }; }
  });
}

module.exports = { installProjectExplorer };
