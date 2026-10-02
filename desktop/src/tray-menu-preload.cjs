const { contextBridge, ipcRenderer } = require('electron');

// A dedicated menu window gets only these fixed, bounded operations.
contextBridge.exposeInMainWorld('xuenessTray', {
  subscribe: callback => {
    if (typeof callback !== 'function') return () => {};
    const receive = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on('xueness:tray-snapshot', receive);
    return () => ipcRenderer.removeListener('xueness:tray-snapshot', receive);
  },
  ready: () => ipcRenderer.send('xueness:tray-ready'),
  dismiss: () => ipcRenderer.send('xueness:tray-dismiss'),
  select: action => {
    if (!action || typeof action !== 'object') return;
    if (['new', 'feedback', 'quit'].includes(action.kind)) ipcRenderer.send('xueness:tray-command', { kind: action.kind });
    else if (action.kind === 'session' && typeof action.id === 'string' && /^[a-f0-9]{32}$/.test(action.id)) ipcRenderer.send('xueness:tray-command', { kind: 'session', id: action.id });
  },
  resize: height => { if (Number.isInteger(height) && height >= 100 && height <= 2000) ipcRenderer.send('xueness:tray-resize', height); },
});
