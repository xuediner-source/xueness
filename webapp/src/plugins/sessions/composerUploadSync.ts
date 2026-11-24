import { useEffect } from "react";
import { editorAttachmentRefs } from "./composerAttachmentRef";
import { composerReferenceIsOwned, reconcileComposerUploads } from './composerAttachmentDraft';
import { notifyComposerDrafts } from './composerRecovery';
import { persistDraft } from './composerDraftStore';
import type { ComposerDraftState } from './composerTypes';
import { attachmentPublishers, missingAttachmentDrafts } from './composerAttachmentRegistry';
import type { ComposerDraftsRef, ComposerUploadOwner, ComposerUploadStore } from './composerHandlerTypes';

export function useComposerUploadSync({ richComposer, uploadStore, draftsRef, draft, uploadOwner, resolvedWorkspaceKey, uploadEnabled, ownerMismatch, attachmentGeneration }: {
  richComposer: boolean;
  uploadStore: ComposerUploadStore;
  draftsRef: ComposerDraftsRef;
  draft: ComposerDraftState;
  uploadOwner: ComposerUploadOwner;
  resolvedWorkspaceKey: string;
  uploadEnabled: boolean;
  ownerMismatch: boolean;
  attachmentGeneration: string | number;
}) {
  useEffect(() => {
    if (!richComposer) return;
    uploadStore.setDisposalGuard(id => composerReferenceIsOwned(draftsRef.current.values(), id));
    // Initialize once. A retained manager may already contain completions from
    // an unmounted editor; never replace those with an older persisted snapshot.
    if (draft.hadAttachments && !uploadStore.hasUnready()) missingAttachmentDrafts.add(uploadOwner.draftId);
    const retainedUploads = uploadStore.getSnapshot().length > 0;
    if (!retainedUploads) uploadStore.syncReadyRefs(editorAttachmentRefs(draft.attachments));
    const publish = () => {
      for (const [key, value] of draftsRef.current) {
        const next = reconcileComposerUploads(value, uploadOwner.draftId,
          uploadStore.readyAttachments(), uploadStore.hasUnready() || missingAttachmentDrafts.has(uploadOwner.draftId));
        if (next === value) continue;
        draftsRef.current.set(key, next);
        const prefix = `${resolvedWorkspaceKey}:`;
        if (key.startsWith(prefix)) persistDraft(resolvedWorkspaceKey, key.slice(prefix.length), next);
      }
      notifyComposerDrafts(draftsRef);
    };
    // Keep persistence subscribed through remounts, until this manager is reused.
    const key = uploadStore as object;
    attachmentPublishers.get(key)?.();
    attachmentPublishers.set(key, uploadStore.subscribe(publish));
  }, [uploadStore, draftsRef, richComposer]);
  useEffect(() => {
    uploadStore.setContext({ enabled: uploadEnabled && !ownerMismatch, generation: attachmentGeneration });
  }, [uploadStore, uploadEnabled, ownerMismatch, attachmentGeneration]);
}
