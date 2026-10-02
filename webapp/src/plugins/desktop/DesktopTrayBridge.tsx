import { useEffect } from 'react';

type TrayCommand = { kind: 'new' } | { kind: 'session'; id: string };
type Actions = { enabled: boolean; sessionsEnabled: boolean; busy: boolean; activeId: string | null;
  onNew: () => void; onSession: (id: string) => void };

export function applyDesktopTrayCommand(action: unknown, actions: Actions) {
  if (!actions.enabled || !actions.sessionsEnabled || !action || typeof action !== 'object') return;
  const command = action as TrayCommand;
  if (command.kind === 'new') { if (!actions.busy) actions.onNew(); }
  else if (command.kind === 'session' && typeof command.id === 'string' && /^[a-f0-9]{32}$/.test(command.id) && (!actions.busy || command.id === actions.activeId)) actions.onSession(command.id);
}

export function DesktopTrayBridge({ locale, dark, ...actions }: Actions & { locale: 'zh' | 'en'; dark: boolean }) {
  useEffect(() => {
    if (window.top !== window || new URLSearchParams(window.location.search).get('xuenessDesktop') !== '1') return;
    return () => document.documentElement.setAttribute('data-xn-desktop-tray-state', JSON.stringify({ sessionsEnabled: false, busy: true, activeId: null, locale: 'zh', dark: false }));
  }, []);
  useEffect(() => {
    if (window.top !== window || new URLSearchParams(window.location.search).get('xuenessDesktop') !== '1') return;
    document.documentElement.setAttribute('data-xn-desktop-tray-state', JSON.stringify({
      sessionsEnabled: actions.enabled && actions.sessionsEnabled, busy: actions.busy, activeId: actions.activeId, locale, dark,
    }));
    const receive = (event: Event) => applyDesktopTrayCommand((event as CustomEvent).detail, actions);
    if (actions.enabled) window.addEventListener('xueness:desktop-command', receive);
    return () => window.removeEventListener('xueness:desktop-command', receive);
  }, [actions.enabled, actions.sessionsEnabled, actions.busy, actions.activeId, actions.onNew, actions.onSession, locale, dark]);
  return null;
}
