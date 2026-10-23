import type { ComposerDraftState } from './XuenessWorkbenchView';
import { editorAttachmentRefs, parseRemoteAttachmentEndpoint, type RemoteAttachmentEndpoint, type ComposerAttachment } from './composerAttachmentRef';

export type ComposerAttachmentOwner = { root: string; sessionId?: string; draftId: string; remote?: RemoteAttachmentEndpoint };
export function parseComposerAttachmentOwner(value: unknown): ComposerAttachmentOwner | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const owner = value as ComposerAttachmentOwner;
  if (typeof owner.root !== 'string' || typeof owner.draftId !== 'string' || !owner.draftId ||
      (owner.sessionId !== undefined && typeof owner.sessionId !== 'string')) return undefined;
  if (owner.remote !== undefined && !parseRemoteAttachmentEndpoint(owner.remote)) return undefined;
  return { ...(owner.remote ? { remote: parseRemoteAttachmentEndpoint(owner.remote) } : {}), root: owner.root, draftId: owner.draftId, ...(owner.sessionId ? { sessionId: owner.sessionId } : {}) };
}
export function attachmentOwnerMatches(owner: ComposerAttachmentOwner | undefined, root?: string, sessionId?: string, remote?: RemoteAttachmentEndpoint): boolean {
  return !owner || (owner.root === root && owner.sessionId === sessionId && JSON.stringify(owner.remote ?? null) === JSON.stringify(remote ?? null));
}
/** Every live draft, frozen submission and recovery snapshot is a reference owner. */
export function composerReferenceIsOwned(drafts: Iterable<ComposerDraftState>, id: string): boolean {
  for (const draft of drafts) {
    if (draft.attachments.some(item => item.ref?.id === id) ||
      draft.pendingSubmission?.draft.attachments.some(item => item.ref?.id === id) ||
      draft.recoverableDrafts?.some(item => item.attachments.some(attachment => attachment.ref?.id === id))) return true;
  }
  return false;
}
/** A retained upload can complete while its editor is unmounted or in recovery. */
export function reconcileComposerUploads(draft: ComposerDraftState, draftId: string,
  attachments: ComposerAttachment[], unfinished: boolean): ComposerDraftState {
  const reconcile = <T extends { draftId?: string; attachments: ComposerAttachment[]; hadAttachments?: boolean }>(item: T): T => {
    if (item.draftId !== draftId) return item;
    if (JSON.stringify(item.attachments) === JSON.stringify(attachments) && Boolean(item.hadAttachments) === unfinished) return item;
    return { ...item, attachments, hadAttachments: unfinished, ...(!attachments.length && !unfinished ? { attachmentOwner: undefined } : {}) };
  };
  const current = reconcile(draft);
  const recoverableDrafts = draft.recoverableDrafts?.map(reconcile);
  const pending = draft.pendingSubmission;
  const pendingDraft = pending ? reconcile(pending.draft) : undefined;
  if (current === draft && recoverableDrafts?.every((item, i) => item === draft.recoverableDrafts?.[i]) !== false &&
      pendingDraft === pending?.draft) return draft;
  return { ...current, recoverableDrafts, pendingSubmission: pending && pendingDraft ? { ...pending, draft: pendingDraft } : undefined,
    revision: draft.revision + 1 };
}

export function replacementComposerDraftIdentity(hasContext: boolean): Pick<ComposerDraftState, 'draftId' | 'attachmentOwner' | 'hadAttachments'> {
  return { draftId: crypto.randomUUID(), attachmentOwner: undefined, hadAttachments: hasContext };
}
export function composerDraftIdentityIsOwned(drafts: Iterable<ComposerDraftState>, id: string): boolean {
  for (const draft of drafts) {
    if (draft.draftId === id || draft.pendingSubmission?.draft.draftId === id || draft.recoverableDrafts?.some(item => item.draftId === id)) return true;
  }
  return false;
}

/** Legacy references have no authoritative upload scope after historical promotion. */
export function hasUnscopedComposerAttachments(draft: Pick<ComposerDraftState, 'attachments' | 'attachmentOwner'>): boolean {
  return !draft.attachmentOwner && editorAttachmentRefs(draft.attachments).length > 0;
}
