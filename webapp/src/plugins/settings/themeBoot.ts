/** The same theme resolver runs in the document head and the React settings host. */
export type ThemePreference = 'light' | 'dark' | 'system';
export function normalizeTheme(value: unknown): ThemePreference {
  return value === 'light' || value === 'dark' ? value : 'system';
}
export function resolveTheme(value: unknown, systemDark: boolean): 'light' | 'dark' {
  const theme = normalizeTheme(value);
  return theme === 'system' ? (systemDark ? 'dark' : 'light') : theme;
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
  if (meta) meta.content = theme === 'dark' ? '#161616' : '#fafafa';
  if (cache) {
    try { localStorage.setItem('xueness.theme', preference); } catch { /* Private browsing: use the in-memory theme. */ }
  }
}
// Compiled into a small classic script in <head>, before styles and React load.
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  let cached: unknown = 'system';
  try {
    cached = localStorage.getItem('xueness.theme');
    document.documentElement.lang = localStorage.getItem('xueness.language') === 'en' ? 'en' : 'zh-CN';
  } catch { /* System appearance remains available. */ }
  applyDocumentTheme(cached, false);
}
