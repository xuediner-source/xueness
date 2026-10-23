export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

declare global {
  interface Window {
    xuenessDesktopStorage?: StorageLike;
  }
}

/** Desktop state is read synchronously by the host before the workbench mounts.
 * A desktop page without its preload bridge has no usable storage; falling back
 * to its random-port localStorage would make the next launch look empty again. */
export function getWorkbenchStorage(): StorageLike | null {
  if (typeof window === 'undefined') return null;
  if (window.xuenessDesktopStorage) return window.xuenessDesktopStorage;
  if (window.top === window && new URLSearchParams(window.location.search).get('xuenessDesktop') === '1') return null;
  try { return window.localStorage; }
  catch { return null; }
}
