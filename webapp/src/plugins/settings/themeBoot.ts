/** The same theme resolver runs in the document head and the React settings host. */
export type ThemePreference = 'light' | 'dark' | 'system';
/** Optional UI color palette. Default Xueness is neutral; Claude 风格 is warm. */
export type ColorPalettePreference = 'xueness' | 'claude';

export function normalizeTheme(value: unknown): ThemePreference {
  return value === 'light' || value === 'dark' ? value : 'system';
}
export function resolveTheme(value: unknown, systemDark: boolean): 'light' | 'dark' {
  const theme = normalizeTheme(value);
  return theme === 'system' ? (systemDark ? 'dark' : 'light') : theme;
}
export function normalizeColorPalette(value: unknown): ColorPalettePreference {
  return value === 'claude' ? 'claude' : 'xueness';
}

export function applyDocumentTheme(value: unknown, cache = true): void {
  if (typeof document === 'undefined') return;
  const preference = normalizeTheme(value);
  const theme = resolveTheme(preference, window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false);
  const root = document.documentElement;
  root.classList.toggle('dark', theme === 'dark');
  root.style.colorScheme = theme;
  root.dataset.xnTheme = theme;
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) {
    const palette = normalizeColorPalette(root.dataset.xnPalette);
    if (palette === 'claude') meta.content = theme === 'dark' ? '#1d1c1a' : '#f2f0e9';
    else meta.content = theme === 'dark' ? '#161616' : '#fafafa';
  }
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
  const theme = root.classList.contains('dark') ? 'dark' : 'light';
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) {
    if (palette === 'claude') meta.content = theme === 'dark' ? '#1d1c1a' : '#f2f0e9';
    else meta.content = theme === 'dark' ? '#161616' : '#fafafa';
  }
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
}
