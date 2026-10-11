import type { ComposerDraftState } from './XuenessWorkbenchView';

export type RecoverableComposerDraft = Omit<ComposerDraftState, 'recoverableDrafts' | 'pendingSubmission'>;

// A late acknowledgement can arrive after the composer remounts. Subscribers
// share the parent-owned store, so its new consumer sees the same settlement.
const draftListeners = new WeakMap<object, Set<() => void>>();
export function subscribeComposerDrafts(store: object, listener: () => void): () => void {
  const listeners = draftListeners.get(store) ?? new Set();
  listeners.add(listener); draftListeners.set(store, listeners);
  return () => { listeners.delete(listener); if (!listeners.size) draftListeners.delete(store); };
}
export function notifyComposerDrafts(store: object): void { draftListeners.get(store)?.forEach(listener => listener()); }

export function hasComposerDraftContent(draft: RecoverableComposerDraft): boolean {
  return Boolean(draft.text.trim() || draft.attachments?.length || draft.hadAttachments || draft.goal || draft.selectedCapabilities?.length
    || Object.values(draft.selectedContext).some(items => items?.length));
}

export function composerDraftContent(draft: ComposerDraftState): RecoverableComposerDraft {
  const { recoverableDrafts: _recoverableDrafts, pendingSubmission: _pending, ...content } = draft;
  return content;
}

/** Keep a failed send beside newer input; late failures never replace current edits. */
export function retainRejectedComposerDraft(current: ComposerDraftState, submitted: ComposerDraftState, error: string, deliveryUnconfirmed = false): ComposerDraftState {
  return { ...current, recoverableDrafts: [...(current.recoverableDrafts ?? []),
    { ...composerDraftContent(submitted), submissionError: error, deliveryUnconfirmed }], revision: current.revision + 1 };
}

/** Restoring swaps a nonempty editor into recovery so neither draft is discarded. */
export function recoverComposerDraft(current: ComposerDraftState, index: number): ComposerDraftState {
  const recovered = current.recoverableDrafts?.[index];
  if (!recovered) return current;
  const remaining = current.recoverableDrafts!.filter((_, position) => position !== index);
  if (hasComposerDraftContent(current)) remaining.push(composerDraftContent(current));
  return { ...recovered, pendingSubmission: current.pendingSubmission, recoverableDrafts: remaining, revision: current.revision + 1 };
}
