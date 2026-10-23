// settings.shortcut_keymap owns workbench appearance shortcut behavior.
import { useEffect } from 'react';
export const APP_ZOOM_MIN = 0.75;
export const APP_ZOOM_MAX = 1.5;
export function normalizeAppZoom(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(APP_ZOOM_MAX, Math.max(APP_ZOOM_MIN, value)) : 1;
}
export function nextAppZoom(value: unknown, action: 'zoom-in' | 'zoom-out' | 'reset-zoom'): number {
  return action === 'reset-zoom' ? 1 : normalizeAppZoom(Math.round((normalizeAppZoom(value) + (action === 'zoom-in' ? .1 : -.1)) * 100) / 100);
}
/** CSS app zoom fallback. This deliberately does not claim to change OS scaling. */
export function useAppZoom(enabled: boolean, value: unknown): void {
  useEffect(() => {
    if (!enabled) return;
    const body = document.body;
    const previous = body.style.zoom;
    body.style.zoom = String(normalizeAppZoom(value));
    return () => { body.style.zoom = previous; };
  }, [enabled, value]);
}
export function shortcutOwner(command: string): string | null {
  if (command === 'toggle-terminal') return 'terminal';
  if (command === 'toggle-browser') return 'browser';
  if (command === 'switch-theme' || command.includes('zoom')) return 'settings';
  return null;
}
