import { useSyncExternalStore } from 'react';
export type Locale = 'zh' | 'en';
const listeners = new Set<() => void>();
let locale: Locale = 'zh';
try { if (typeof localStorage !== 'undefined' && localStorage.getItem('xueness.language') === 'en') locale = 'en'; } catch { /* Private browsing. */ }
export const messages: Record<string, string> = {};
let englishLoaded = false;
let englishLoad: Promise<void> | undefined;
let requestedLocale = locale;

export function installTranslations(install: (target: Record<string, string>) => void): void {
  install(messages);
  englishLoaded = true;
}

export function loadEnglish(): Promise<void> {
  if (englishLoaded) return Promise.resolve();
  return englishLoad ??= import('./i18n.en').then(({ installEnglish }) => {
    installTranslations(installEnglish);
  }).catch(error => { englishLoad = undefined; throw error; });
}

export function getLocale(): Locale { return locale; }
function applyLocale(value: Locale): void {
  locale = value;
  try { localStorage.setItem('xueness.language', value); } catch { /* In-memory preference still works. */ }
  if (typeof document !== 'undefined') document.documentElement.lang = value === 'zh' ? 'zh-CN' : 'en';
  listeners.forEach(fn => fn());
}
export function setLocale(value: Locale): void {
  requestedLocale = value;
  if (value === 'en' && !englishLoaded) {
    void loadEnglish().then(() => { if (requestedLocale === 'en') applyLocale('en'); }).catch(console.error);
    return;
  }
  applyLocale(value);
}
export function useLocale() {
  return useSyncExternalStore(fn => { listeners.add(fn); return () => { listeners.delete(fn); }; }, getLocale, () => 'zh' as Locale);
}
export function t(text: string, context?: string): string {
  if (locale !== 'en') return text;
  const key = text.trim();
  return (context ? messages[`${context}\u0004${key}`] : undefined) ?? messages[key] ?? text;
}
export function tf(text: string, values: unknown[]): string {
  return t(text).replace(/\{(\d+)\}/g, (placeholder, n) => Number(n) < values.length ? String(values[Number(n)]) : placeholder);
}
