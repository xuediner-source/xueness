/** Platform-aware shortcut display. Single source of truth (P1-4). */
export function isMacPlatform(platform?: string): boolean {
  const p = platform ?? (typeof navigator === 'undefined' ? '' : navigator.platform);
  const normalized = p.trim().toLowerCase();
  return normalized === 'darwin' || normalized.startsWith('mac');
}
export type HostPlatform = 'macos' | 'windows' | 'other';
/**
 * 统一的宿主平台判定：Electron/浏览器给的 navigator.platform（MacIntel、Win32…）
 * 与 Node 的 process.platform（darwin、win32）都走这里。先判 macOS，避免
 * "darwin" 因包含 "win" 被误判成 Windows。
 */
export function resolveHostPlatform(platform?: string): HostPlatform {
  const p = platform ?? (typeof navigator === 'undefined' ? '' : navigator.platform);
  if (isMacPlatform(p)) return 'macos';
  const normalized = p.trim().toLowerCase();
  if (normalized.startsWith('win')) return 'windows';
  return 'other';
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

/**
 * 判断事件是否按下了主修饰键（Mod）：
 * macOS (darwin / MacIntel) 为 Command (metaKey) 且非 Ctrl；
 * Windows (win32 / Win32) / Linux 为 Ctrl (ctrlKey) 且非 Command。
 * 避免两键同时按下时误触发主修饰键操作。
 */
export function isModKeyPressed(
  event: { ctrlKey?: boolean; metaKey?: boolean },
  platform?: string,
): boolean {
  const isMac = isMacPlatform(platform);
  return isMac ? Boolean(event.metaKey && !event.ctrlKey) : Boolean(event.ctrlKey && !event.metaKey);
}

/**
 * 通用的 IME 输入法组合态事件判断：
 * 覆盖 isComposing / nativeEvent.isComposing / keyCode 229 / key "Process" / key "Dead" / compositionActive。
 */
export function isImeComposingEvent(event?: {
  isComposing?: boolean;
  nativeEvent?: { isComposing?: boolean; keyCode?: number };
  keyCode?: number;
  key?: string;
  compositionActive?: boolean;
} | null): boolean {
  if (!event) return false;
  return Boolean(
    event.compositionActive ||
    event.isComposing ||
    event.nativeEvent?.isComposing ||
    event.keyCode === 229 ||
    event.nativeEvent?.keyCode === 229 ||
    event.key === 'Process' ||
    event.key === 'Dead'
  );
}
