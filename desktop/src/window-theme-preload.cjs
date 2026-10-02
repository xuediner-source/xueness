// Read the same CSS tokens as the title bar. No Electron API is exposed to the page.
const { ipcRenderer } = require('electron');

if (process.isMainFrame && process.platform === 'win32') {
  const observeTheme = () => {
    const root = document.documentElement;
    let previous = '';
    const sync = () => {
      const style = getComputedStyle(root);
      const color = style.getPropertyValue('--bg-window').trim();
      const symbolColor = style.getPropertyValue('--fg').trim();
      if (!/^#[0-9a-f]{6}$/i.test(color) || !/^#[0-9a-f]{6}$/i.test(symbolColor)) return;
      const signature = `${color}:${symbolColor}`;
      if (signature === previous) return;
      previous = signature;
      ipcRenderer.send('xueness:window-colors', { color, symbolColor });
    };
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ['class', 'style'] });
    sync();
    window.addEventListener('pagehide', () => observer.disconnect(), { once: true });
  };
  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', observeTheme, { once: true });
  else observeTheme();
}
