/** The same theme resolver runs in the document head and the React settings host. */
export type ThemePreference = 'light' | 'dark' | 'system';
/** Appearance only: it never changes the provider, tools or permission mode. */
export type ColorPalettePreference = 'xueness' | 'claudex';

export function normalizeTheme(value: unknown): ThemePreference {
  return value === 'light' || value === 'dark' ? value : 'system';
}
export function resolveTheme(value: unknown, systemDark: boolean): 'light' | 'dark' {
  const theme = normalizeTheme(value);
  return theme === 'system' ? (systemDark ? 'dark' : 'light') : theme;
}
export function normalizeColorPalette(value: unknown): ColorPalettePreference {
  // `claude` was the persisted identifier of the former Codex appearance.
  return value === 'claudex' || value === 'claude' ? 'claudex' : 'xueness';
}

/** The document and native caption buttons read the CSS palette. Before the
 * stylesheet loads we keep the existing meta value; DOMContentLoaded syncs it. */
export function syncDocumentThemeColor(): void {
  if (typeof document === 'undefined' || typeof getComputedStyle === 'undefined') return;
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  const color = getComputedStyle(document.documentElement).getPropertyValue('--bg-window').trim();
  if (meta && /^#[0-9a-f]{6}$/i.test(color)) meta.content = color;
}

export function applyDocumentTheme(value: unknown, cache = true): void {
  if (typeof document === 'undefined') return;
  const preference = normalizeTheme(value);
  const theme = resolveTheme(preference, window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false);
  const root = document.documentElement;
  root.classList.toggle('dark', theme === 'dark');
  root.style.colorScheme = theme;
  root.dataset.xnTheme = theme;
  syncDocumentThemeColor();
  if (cache) {
    try { localStorage.setItem('xueness.theme', preference); } catch { /* Private browsing: use the in-memory theme. */ }
  }
}

export function applyDocumentColorPalette(value: unknown, cache = true): void {
  if (typeof document === 'undefined') return;
  const palette = normalizeColorPalette(value);
  const root = document.documentElement;
  if (palette === 'xueness') delete root.dataset.xnPalette;
  else root.dataset.xnPalette = palette;
  syncDocumentThemeColor();
  if (cache) {
    try { localStorage.setItem('xueness.colorPalette', palette); } catch { /* Private browsing. */ }
  }
}

// Compiled into a small classic script in <head>, before styles and React load.
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  let cachedTheme: unknown = 'system';
  let cachedPalette: unknown = 'xueness';
  try {
    cachedTheme = localStorage.getItem('xueness.theme');
    cachedPalette = localStorage.getItem('xueness.colorPalette');
    document.documentElement.lang = localStorage.getItem('xueness.language') === 'en' ? 'en' : 'zh-CN';
  } catch { /* System appearance remains available. */ }
  // Palette before theme so theme-color meta sees the active scheme.
  applyDocumentColorPalette(cachedPalette, false);
  applyDocumentTheme(cachedTheme, false);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', syncDocumentThemeColor, { once: true });
}
