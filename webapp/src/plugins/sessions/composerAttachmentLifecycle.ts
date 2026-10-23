import { useEffect } from 'react';

// Small eager boundary; upload managers register only when their lazy chunk loads.
let enabled = false;
let invalidate: (() => void) | null = null;
const listeners = new Set<() => void>();
export function isComposerAttachmentLifecycleEnabled(): boolean { return enabled; }
export function subscribeComposerAttachmentLifecycle(listener: () => void): () => void {
  listeners.add(listener); return () => { listeners.delete(listener); };
}
export function registerComposerAttachmentInvalidator(callback: () => void): void {
  invalidate = callback;
  if (!enabled) callback();
}
export function setComposerAttachmentLifecycleEnabled(value: boolean): void {
  enabled = value;
  if (!value) invalidate?.();
  for (const listener of listeners) listener();
}
/** Owned by the workbench shell, not the navigable conversation view. */
export function useComposerAttachmentLifecycle(value: boolean): void {
  useEffect(() => {
    setComposerAttachmentLifecycleEnabled(value);
    return () => setComposerAttachmentLifecycleEnabled(false);
  }, [value]);
}
