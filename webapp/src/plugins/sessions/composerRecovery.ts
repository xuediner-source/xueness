import { editorStateHasContent } from './composerEditorState';
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

export function hasComposerDraftContent(draft: Partial<RecoverableComposerDraft>): boolean {
  return Boolean(draft.text?.trim() || editorStateHasContent(draft.editorState) || draft.attachments?.length || draft.hadAttachments || draft.goal || draft.selectedCapabilities?.length
    || Object.values(draft.selectedContext ?? {}).some(items => items?.length));
}

/** Recovery and delivery state matter even when the visible editor is empty. */
function hasStoredComposerDraft(draft: Partial<ComposerDraftState> | undefined): boolean {
  return Boolean(draft && (hasComposerDraftContent(draft) || draft.recoverableDrafts?.length
    || draft.pendingSubmission || draft.deliveryUnconfirmed || draft.submissionError || draft.attachmentError));
}

/** Copy a new-task draft to an unused workspace slot, preserving both sides of conflicts. */
export function relocateEmptyComposerDraft<T extends Partial<ComposerDraftState>>(
  store: Pick<Map<string, T>, 'get' | 'set'>,
  fromKey: string,
  toKey: string,
): boolean {
  if (fromKey === toKey) return false;
  const previous = store.get(fromKey);
  if (!previous || !hasStoredComposerDraft(previous)) return false;
  // Settlement callbacks own only the original scoped key. Copying a live send
  // would strand the new composer behind a pending ticket that never settles.
  if (previous.pendingSubmission) return false;
  // Committed attachment identities belong to their original workspace. Keep
  // the entire draft there rather than copying unusable refs into another root.
  if (previous.attachments?.some(attachment => attachment.ref)
    || previous.recoverableDrafts?.some(draft => draft.attachments?.some(attachment => attachment.ref))) return false;
  if (hasStoredComposerDraft(store.get(toKey))) return false;
  store.set(toKey, { ...previous, revision: (previous.revision || 0) + 1 });
  return true;
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
