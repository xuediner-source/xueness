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

/* Runtime appearance changes are revealed, never cut: light/dark grows as a
 * circle from the last pointer press (the picker the user just clicked) and a
 * palette swap cross-fades. Boot-time applies (cache=false) and reduced motion
 * apply instantly. This file is also compiled standalone into <head>, so the
 * helper stays local instead of importing a shared module. */
let lastPointer: { x: number; y: number } | null = null;
if (typeof window !== 'undefined') {
  window.addEventListener('pointerdown', event => { lastPointer = { x: event.clientX, y: event.clientY }; }, { capture: true, passive: true });
}
type RevealDocument = Document & { startViewTransition?: (update: () => void) => { finished: Promise<unknown> } };
function revealAppearanceChange(kind: 'theme' | 'palette', animate: boolean, update: () => void): void {
  const doc = document as RevealDocument;
  const root = doc.documentElement;
  const reduced = root.dataset.xnMotion === 'reduced' || (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);
  if (!animate || reduced || typeof doc.startViewTransition !== 'function' || doc.visibilityState !== 'visible') { update(); return; }
  const x = lastPointer?.x ?? window.innerWidth - 48, y = lastPointer?.y ?? 24;
  root.style.setProperty('--xn-reveal-x', `${Math.round(x)}px`);
  root.style.setProperty('--xn-reveal-y', `${Math.round(y)}px`);
  root.style.setProperty('--xn-reveal-r', `${Math.ceil(Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y)))}px`);
  root.dataset.xnVt = kind;
  const clear = () => { if (root.dataset.xnVt === kind) delete root.dataset.xnVt; };
  try { doc.startViewTransition(update).finished.then(clear, clear); } catch { clear(); update(); }
}

export function applyDocumentTheme(value: unknown, cache = true): void {
  if (typeof document === 'undefined') return;
  const preference = normalizeTheme(value);
  const theme = resolveTheme(preference, window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false);
  const root = document.documentElement;
  revealAppearanceChange('theme', cache && root.dataset.xnTheme !== undefined && root.dataset.xnTheme !== theme, () => {
    root.classList.toggle('dark', theme === 'dark');
    root.style.colorScheme = theme;
    root.dataset.xnTheme = theme;
    syncDocumentThemeColor();
  });
  if (cache) {
    try { localStorage.setItem('xueness.theme', preference); } catch { /* Private browsing: use the in-memory theme. */ }
  }
}

/** In-app motion preference. "reduced" stops every decorative animation
 * (styles/motion.css) even when the OS does not ask for it; the OS setting
 * still wins when it does. Cached so the head script applies it before paint. */
export function applyDocumentMotion(reduced: unknown, cache = true): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.xnMotion = reduced === true ? 'reduced' : 'standard';
  if (cache) {
    try { localStorage.setItem('xueness.motion', reduced === true ? 'reduced' : 'standard'); } catch { /* Private browsing. */ }
  }
}

let pendingAppearance: HTMLLinkElement | null = null;
export function applyDocumentColorPalette(value: unknown, cache = true): void {
  if (typeof document === 'undefined') return;
  const palette = normalizeColorPalette(value);
  const root = document.documentElement;
  const apply = () => {
    if (palette === 'xueness') delete root.dataset.xnPalette;
    else root.dataset.xnPalette = palette;
    syncDocumentThemeColor();
    if (cache) {
      try { localStorage.setItem('xueness.colorPalette', palette); } catch { /* Private browsing. */ }
    }
  };
  if (pendingAppearance) { pendingAppearance.onload = null; pendingAppearance.remove(); pendingAppearance = null; }
  const current = document.getElementById('xn-appearance') as HTMLLinkElement | null;
  const href = document.querySelector<HTMLMetaElement>(`meta[name="xn-appearance-${palette}"]`)?.content;
  if (!current || !href || current.getAttribute('href') === href) { apply(); return; }
  const next = document.createElement('link');
  next.rel = 'stylesheet';
  next.href = href;
  pendingAppearance = next;
  next.onload = () => revealAppearanceChange('palette', cache, () => {
    current.remove();
    next.id = 'xn-appearance';
    pendingAppearance = null;
    apply();
  });
  next.onerror = () => { next.remove(); pendingAppearance = null; };
  document.head.append(next);
}

// Compiled into a small classic script in <head>, before styles and React load.
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  let cachedTheme: unknown = 'system';
  let cachedPalette: unknown = 'xueness';
  try {
    cachedTheme = localStorage.getItem('xueness.theme');
    cachedPalette = localStorage.getItem('xueness.colorPalette');
    applyDocumentMotion(localStorage.getItem('xueness.motion') === 'reduced', false);
    document.documentElement.lang = localStorage.getItem('xueness.language') === 'en' ? 'en' : 'zh-CN';
  } catch { /* System appearance remains available. */ }
  // Palette before theme so theme-color meta sees the active scheme.
  applyDocumentColorPalette(cachedPalette, false);
  applyDocumentTheme(cachedTheme, false);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', syncDocumentThemeColor, { once: true });
}
