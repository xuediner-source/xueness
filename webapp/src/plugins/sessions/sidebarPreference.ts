import { useCallback, useEffect, useState, type SetStateAction } from 'react';
import { getWorkbenchStorage } from '../desktop/desktopStorage';

export const SIDEBAR_COLLAPSED_STORAGE_KEY = 'xueness.sidebar-collapsed.v1';
type Preferences = { standard?: boolean; lightweight?: boolean };

function readPreferences(): Preferences {
  try {
    const value = JSON.parse(getWorkbenchStorage()?.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) ?? '{}');
    return { standard: typeof value?.standard === 'boolean' ? value.standard : undefined,
      lightweight: typeof value?.lightweight === 'boolean' ? value.lightweight : undefined };
  } catch { return {}; }
}

/** Each layout remembers the user's wide-window choice; mobile drawers stay transient. */
export function useSidebarPreference(initialCollapsed: boolean, enabled: boolean) {
  const [preferences, setPreferences] = useState<Preferences>(() => enabled ? readPreferences() : {});
  const mode = initialCollapsed ? 'lightweight' : 'standard';
  useEffect(() => { if (enabled) setPreferences(readPreferences()); }, [enabled]);
  const setCollapsed = useCallback((action: SetStateAction<boolean>) => {
    setPreferences(current => {
      const previous = current[mode] ?? initialCollapsed;
      const next = { ...current, [mode]: typeof action === 'function' ? action(previous) : action };
      if (enabled) try { getWorkbenchStorage()?.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, JSON.stringify(next)); } catch { /* The current window still follows the user's choice. */ }
      return next;
    });
  }, [mode, initialCollapsed, enabled]);
  return [preferences[mode] ?? initialCollapsed, setCollapsed] as const;
}
