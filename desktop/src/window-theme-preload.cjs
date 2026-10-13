// Read the same CSS tokens as the title bar. No Electron API is exposed to the page.
const { ipcRenderer } = require('electron');

if ((process.platform === 'win32' || process.platform === 'darwin') && window.top === window) {
  const observeTheme = () => {
    const root = document.documentElement;
    // Scheme title bar height depends on the window width (wide layout only).
    const wide = typeof window.matchMedia === 'function' ? window.matchMedia('(min-width: 901px)') : null;
    let previous = '';
    let previousPolicy;
    let previousTrayState = '';
    let previousNotifyRequest = '';
    let previousLocale;
    const sync = () => {
      const style = getComputedStyle(root);
      // A scheme may paint the wide-window title bar differently from
      // --bg-window via --xn-native-titlebar-color / -height.
      const isWide = !wide || wide.matches;
      const chromeColor = isWide ? style.getPropertyValue('--xn-native-titlebar-color').trim() : '';
      const color = /^#[0-9a-f]{6}$/i.test(chromeColor) ? chromeColor : style.getPropertyValue('--bg-window').trim();
      const symbolColor = style.getPropertyValue('--fg').trim();
      const height = isWide && style.getPropertyValue('--xn-native-titlebar-height').trim() === '44px' ? 44 : undefined;
      if (/^#[0-9a-f]{6}$/i.test(color) && /^#[0-9a-f]{6}$/i.test(symbolColor)) {
        const signature = `${color}:${symbolColor}:${height || ''}`;
        if (signature !== previous) {
          previous = signature;
          ipcRenderer.send('xueness:window-colors', height ? { color, symbolColor, height } : { color, symbolColor });
        }
      }
      const policy = root.getAttribute('data-xn-desktop-enabled');
      if ((policy === 'true' || policy === 'false') && policy !== previousPolicy) {
        previousPolicy = policy;
        ipcRenderer.send('xueness:desktop-background', policy === 'true');
      }
      const trayState = root.getAttribute('data-xn-desktop-tray-state');
      if (trayState && trayState.length < 1024 && trayState !== previousTrayState) {
        try {
          const parsed = JSON.parse(trayState);
          ipcRenderer.send('xueness:desktop-tray-state', parsed);
          if ((parsed.locale === 'zh' || parsed.locale === 'en') && parsed.locale !== previousLocale) {
            previousLocale = parsed.locale;
            ipcRenderer.send('xueness:desktop-locale', parsed.locale);
          }
          previousTrayState = trayState;
        } catch { /* Ignore incomplete state mutations. */ }
      }
      // Notification requests are one-shot values published by the desktop
      // notifications bridge. Forward them only while the desktop plugin is
      // effective (`data-xn-desktop-enabled`), so a disabled plugin also stops
      // the preload side of the trigger path.
      const notifyRequest = root.getAttribute('data-xn-desktop-notify-request');
      if (notifyRequest && notifyRequest.length < 2048 && notifyRequest !== previousNotifyRequest) {
        previousNotifyRequest = notifyRequest;
        if (root.getAttribute('data-xn-desktop-enabled') === 'true') {
          try { ipcRenderer.send('xueness:desktop-notify', JSON.parse(notifyRequest)); }
          catch { /* Ignore incomplete state mutations. */ }
        }
      }
    };
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ['class', 'style', 'data-xn-palette', 'data-xn-desktop-enabled', 'data-xn-desktop-tray-state', 'data-xn-desktop-notify-request'] });
    wide?.addEventListener?.('change', sync);
    sync();
    const command = (_event, action) => {
      if (!action || typeof action !== 'object') return;
      if (action.kind === 'new' || (action.kind === 'session' && typeof action.id === 'string' && /^[a-f0-9]{32}$/.test(action.id))) {
        window.dispatchEvent(new CustomEvent('xueness:desktop-command', { detail: action.kind === 'new' ? { kind: 'new' } : { kind: 'session', id: action.id } }));
      }
    };
    ipcRenderer.on('xueness:desktop-command', command);
    window.addEventListener('pagehide', () => {
      observer.disconnect(); wide?.removeEventListener?.('change', sync);
      ipcRenderer.removeListener('xueness:desktop-command', command);
    }, { once: true });
  };
  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', observeTheme, { once: true });
  else observeTheme();
}
