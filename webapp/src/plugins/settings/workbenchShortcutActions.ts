import { SHORTCUT_COMMANDS, resolveShortcutBinding, matchesShortcut, isReservedShortcut, hasGlobalShortcutConflict, type ShortcutEventLike } from '../../xuenessShortcutCommands';
import { isImeComposingEvent } from '../../xuenessShortcutDisplay';
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

export type WorkbenchGlobalKeyAction =
  | { type: "new-session" }
  | { type: "command-palette" }
  | { type: "open-settings" }
  | { type: "toggle-sidebar" }
  | { type: "refresh-session" }
  | { type: "switch-theme" | "toggle-terminal" | "toggle-browser" | "zoom-in" | "zoom-out" | "reset-zoom" }
  | null;

export function evaluateWorkbenchGlobalKey(
  event: ShortcutEventLike & { target?: unknown; defaultPrevented?: boolean },
  context: {
    bindings?: Record<string, string>;
    isPluginEffective: (id: string) => boolean;
    panel?: string;
    busy?: boolean;
    platform?: string;
  },
): WorkbenchGlobalKeyAction {
  if (event.defaultPrevented || isImeComposingEvent(event) || event.repeat) return null;
  const bindings = context.bindings ?? {};
  const command = SHORTCUT_COMMANDS.find((item) => {
    if (item.scope !== "global") return false;
    const binding = resolveShortcutBinding(item.id, bindings);
    return Boolean(binding && !binding.split("|").some(value => value.trim() === "Enter") && !isReservedShortcut(binding) && matchesShortcut(event, binding, context.platform));
  });
  if (!command || command.scope !== "global") return null;
  if (hasGlobalShortcutConflict(event, command.id, event.target, context.platform)) return null;
  if ((command.id === "new-session" || command.id === "command-palette") && !context.isPluginEffective("sessions")) return null;
  if (command.id === "open-settings" && !context.isPluginEffective("settings")) return null;
  if (command.id === "toggle-sidebar" && context.panel === "settings") return null;
  if (command.id === "refresh-session" && context.busy) return null;
  const owner = shortcutOwner(command.id);
  if (owner && (!context.isPluginEffective(owner) || !context.isPluginEffective("settings"))) return null;
  return { type: command.id };
}
