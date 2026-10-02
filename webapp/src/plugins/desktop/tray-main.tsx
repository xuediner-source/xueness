import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { DesktopTrayMenu, type TraySnapshot, type TrayApi } from './DesktopTrayMenu';

const api = (window as Window & { xuenessTray?: TrayApi }).xuenessTray;
function TrayApp() {
  const [snapshot, setSnapshot] = useState<TraySnapshot>({ sessions: [], sessionsEnabled: false, busy: true, activeId: null,
    locale: 'zh', dark: false, loading: true, failed: false });
  useEffect(() => {
    if (!api) { setSnapshot(value => ({ ...value, loading: false, failed: true })); return; }
    const unsubscribe = api.subscribe(setSnapshot); api.ready(); return unsubscribe;
  }, []);
  return <DesktopTrayMenu snapshot={snapshot} api={api} />;
}
createRoot(document.getElementById('root')!).render(<TrayApp />);
