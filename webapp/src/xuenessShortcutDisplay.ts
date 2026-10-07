/** Platform-aware shortcut display. Single source of truth (P1-4). */
export function isMacPlatform(platform?: string): boolean {
  const p = platform ?? (typeof navigator === 'undefined' ? '' : navigator.platform);
  const normalized = p.trim().toLowerCase();
  return normalized === 'darwin' || normalized.startsWith('mac');
}
/** Display each modifier/key separately for settings chips. */
export function displayBindingParts(shortcut: string, platform?: string): string[] {
  const isMac = isMacPlatform(platform);
  return shortcut.split('+').map((part) => {
    if (part === 'Mod') return isMac ? '⌘' : 'Ctrl';
    if (part === 'Ctrl') return 'Ctrl';
    if (part === 'Meta') return isMac ? '⌘' : 'Win';
    if (part === 'Alt') return isMac ? '⌥' : 'Alt';
    if (part === 'Shift') return isMac ? '⇧' : 'Shift';
    if (part.startsWith('Arrow')) return part.replace('Arrow', '');
    return part;
  });
}
/** 'Mod+Enter' -> '⌘Enter' on macOS, 'Ctrl+Enter' elsewhere. */
export function displayBinding(shortcut: string, platform?: string): string {
  const isMac = isMacPlatform(platform);
  return displayBindingParts(shortcut, platform).join(isMac ? '' : '+');
}
