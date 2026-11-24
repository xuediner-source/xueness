import { t as tr } from '../../i18n';
import type { AttachmentRef, RemoteAttachmentEndpoint } from "./composerAttachmentRef";
import { editorAttachmentRefs } from "./composerAttachmentRef";
import { attachmentOwnerMatches, composerDraftIdentityIsOwned } from './composerAttachmentDraft';
import { retainRejectedComposerDraft, composerDraftContent, notifyComposerDrafts } from './composerRecovery';
import { DeliveryUnconfirmedError } from './submissionTransport';
import { composerInputForDraft } from './composerMaterialSummary';
import { followupDelivery, type FollowupMode, type InputDelivery } from './CurrentTurnInput';
import { ComposerProps, emptyComposerDraft } from './composerTypes';
import { persistDraft, readPromptHistoryEntries, persistPromptHistoryEntries, clearSubmittedComposerDraft, restoreSubmittedComposerDraft } from './composerDraftStore';
import { appendPromptHistoryEntry } from './composerInputHelpers';
import { attachmentPublishers } from './composerAttachmentRegistry';
import type { ComposerDraftsRef, ComposerUploadOwner, ComposerUploadStore, UpdateComposerDraftFor } from './composerHandlerTypes';
import type React from "react";

export interface ComposerSendHandlerContext {
  isSendDisabled: boolean;
  draftsRef: ComposerDraftsRef;
  scopedDraftKey: string;
  onSend: ComposerProps['onSend'];
  setSubmissionError: (message: string) => unknown;
  defaultValue: string;
  uploadStore: ComposerUploadStore;
  uploadOwner: ComposerUploadOwner;
  legacyAttachmentBusyRef: React.MutableRefObject<boolean>;
  unavailableAttachments: boolean;
  attachmentRoot?: string;
  attachmentSessionId?: string;
  attachmentRemoteOwner?: RemoteAttachmentEndpoint;
  richComposer: boolean;
  resolvedWorkspaceKey: string;
  draftKey: string;
  historyIndexRef: React.MutableRefObject<number | null>;
  running: boolean;
  queueWhenRunning: boolean;
  effectiveFollowupMode: FollowupMode;
  updateDraftFor: UpdateComposerDraftFor;
  disposeRef: (ref: AttachmentRef | undefined, owner?: ComposerUploadOwner) => void;
}

export function createComposerSendHandler(context: ComposerSendHandlerContext) {
  const {
    isSendDisabled, draftsRef, scopedDraftKey, onSend, setSubmissionError, defaultValue, uploadStore, uploadOwner,
    legacyAttachmentBusyRef, unavailableAttachments, attachmentRoot, attachmentSessionId, attachmentRemoteOwner,
    richComposer, resolvedWorkspaceKey, draftKey, historyIndexRef, running, queueWhenRunning, effectiveFollowupMode,
    updateDraftFor, disposeRef,
  } = context;
  const handleSend = async (requestedDelivery?: InputDelivery) => {
    if (isSendDisabled || draftsRef.current.get(scopedDraftKey)?.pendingSubmission || !onSend) return;
    setSubmissionError("");
    const submittedDraft = draftsRef.current.get(scopedDraftKey) ?? emptyComposerDraft(defaultValue);
    if (uploadStore.hasUnready() || legacyAttachmentBusyRef.current || submittedDraft.hadAttachments || unavailableAttachments ||
      (submittedDraft.attachments.length > 0 && !attachmentOwnerMatches(submittedDraft.attachmentOwner, attachmentRoot, attachmentSessionId, attachmentRemoteOwner))) return;
    const submittedRevision = submittedDraft.revision;
    const draft = composerInputForDraft(submittedDraft, richComposer);
    const ticket = crypto.randomUUID();
    const submittedText = submittedDraft.text.trim();
    if (submittedText) {
      const history = readPromptHistoryEntries(resolvedWorkspaceKey);
      persistPromptHistoryEntries(resolvedWorkspaceKey, appendPromptHistoryEntry(history, submittedText));
    }
    historyIndexRef.current = null;
    // Move the complete submission out of the editor before the async run can
    // promote/remount the composer. A rejection restores this frozen snapshot.
    draftsRef.current = clearSubmittedComposerDraft(draftsRef.current, scopedDraftKey, submittedRevision);
    const clearedRevision = draftsRef.current.get(scopedDraftKey)!.revision;
    draftsRef.current.set(scopedDraftKey, { ...draftsRef.current.get(scopedDraftKey)!,
      pendingSubmission: { id: ticket, draft: composerDraftContent(submittedDraft) } });
    persistDraft(resolvedWorkspaceKey, draftKey, draftsRef.current.get(scopedDraftKey)!);
    notifyComposerDrafts(draftsRef);
    let accepted = false;
    const release = () => {
      const current = draftsRef.current.get(scopedDraftKey);
      if (current?.pendingSubmission?.id !== ticket) return;
      const next = { ...current, pendingSubmission: undefined };
      draftsRef.current.set(scopedDraftKey, next);
      persistDraft(resolvedWorkspaceKey, draftKey, next);
      notifyComposerDrafts(draftsRef);
    };
    const acknowledge = () => { accepted = true; release(); };
    const restore = (error = "", deliveryUnconfirmed = false) => {
      if (accepted) return;
      // An unknown delivery stays saved beside the editor, so it cannot be
      // resent by a second Enter press before the user checks the conversation.
      const next = deliveryUnconfirmed ? draftsRef.current : restoreSubmittedComposerDraft(draftsRef.current, scopedDraftKey, clearedRevision, submittedDraft, error);
      if (next !== draftsRef.current) {
        draftsRef.current = next;
        persistDraft(resolvedWorkspaceKey, draftKey, next.get(scopedDraftKey)!);
        notifyComposerDrafts(draftsRef);
      } else {
        updateDraftFor(scopedDraftKey, current => retainRejectedComposerDraft(current, submittedDraft, error, deliveryUnconfirmed));
      }
    };
    try {
      const delivery = running && queueWhenRunning ? requestedDelivery ?? followupDelivery(effectiveFollowupMode) : undefined;
      const sent = await onSend(submittedDraft.text.trim(), draft, acknowledge, delivery);
      if (sent === false) restore();
      else {
        acknowledge();

      }
    } catch (error) {
      restore(error instanceof Error ? error.message : tr("发送失败，草稿已保留。"), error instanceof DeliveryUnconfirmedError);
    } finally {
      release();
      if (accepted) {
        for (const ref of editorAttachmentRefs(submittedDraft.attachments)) disposeRef(ref, submittedDraft.attachmentOwner ?? uploadOwner);
        if (submittedDraft.draftId && !composerDraftIdentityIsOwned(draftsRef.current.values(), submittedDraft.draftId)) {
          uploadStore.syncReadyRefs([]);
          attachmentPublishers.get(uploadStore)?.(); attachmentPublishers.delete(uploadStore);
          uploadStore.invalidate();
        }
      }
    }
  };

  return handleSend;
}
