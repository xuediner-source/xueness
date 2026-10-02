// Read the same CSS tokens as the title bar. No Electron API is exposed to the page.
const { ipcRenderer } = require('electron');

if (process.platform === 'win32' && window.top === window) {
  const observeTheme = () => {
    const root = document.documentElement;
    let previous = '';
    let previousPolicy;
    const sync = () => {
      const style = getComputedStyle(root);
      const color = style.getPropertyValue('--bg-window').trim();
      const symbolColor = style.getPropertyValue('--fg').trim();
      if (/^#[0-9a-f]{6}$/i.test(color) && /^#[0-9a-f]{6}$/i.test(symbolColor)) {
        const signature = `${color}:${symbolColor}`;
        if (signature !== previous) {
          previous = signature;
          ipcRenderer.send('xueness:window-colors', { color, symbolColor });
        }
      }
      const policy = root.getAttribute('data-xn-desktop-enabled');
      if ((policy === 'true' || policy === 'false') && policy !== previousPolicy) {
        previousPolicy = policy;
        ipcRenderer.send('xueness:desktop-background', policy === 'true');
      }
    };
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ['class', 'style', 'data-xn-desktop-enabled'] });
    sync();
    window.addEventListener('pagehide', () => observer.disconnect(), { once: true });
  };
  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', observeTheme, { once: true });
  else observeTheme();
}
