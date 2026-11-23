import React from "react";
import { t as tr } from '../../i18n';
import type { AttachmentOrigin, AttachmentRef, ComposerAttachment, RemoteAttachmentEndpoint } from "./composerAttachmentRef";
import { deferComposerAttachmentRelease } from './composerAttachmentCleanup';
import { composerReferenceIsOwned } from './composerAttachmentDraft';
import type { UploadTransport } from './composerAttachmentUpload';
import { composerAttachmentBytes, COMPOSER_ATTACHMENT_LIMITS, encodeComposerFile, extractFilesFromClipboard } from './composerInputHelpers';
import { emptyComposerDraft } from './composerTypes';
import type { ComposerDraftsRef, ComposerUploadOwner, ComposerUploadStore, UpdateComposerDraft, UpdateComposerDraftFor } from './composerHandlerTypes';

export interface ComposerAttachmentActionsContext {
  draftsRef: ComposerDraftsRef;
  scopedDraftKey: string;
  uploadOwner: ComposerUploadOwner;
  uploadStore: ComposerUploadStore;
  uploadEnabled: boolean;
  ownerMismatch: boolean;
  attachments: ComposerAttachment[];
  attachmentRoot?: string;
  attachmentRemoteOwner?: RemoteAttachmentEndpoint;
  attachmentTransport?: UploadTransport;
  attachmentsEnabled: boolean;
  attachmentGeneration: string | number;
  richComposer: boolean;
  disabled: boolean;
  running: boolean;
  legacyAttachmentBusyRef: React.MutableRefObject<boolean>;
  setLegacyAttachmentBusy: (busy: boolean) => void;
  setAttachmentError: (message: string) => unknown;
  setIsDraggingOver: (dragging: boolean) => void;
  updateAttachments: (next: ComposerAttachment[]) => unknown;
  updateCurrentDraft: UpdateComposerDraft;
  updateDraftFor: UpdateComposerDraftFor;
}

export function createComposerAttachmentActions(context: ComposerAttachmentActionsContext) {
  const {
    draftsRef, scopedDraftKey, uploadOwner, uploadStore, uploadEnabled, ownerMismatch, attachments, attachmentRoot,
    attachmentRemoteOwner, attachmentTransport, attachmentsEnabled, attachmentGeneration, richComposer, disabled, running,
    legacyAttachmentBusyRef, setLegacyAttachmentBusy, setAttachmentError, setIsDraggingOver, updateAttachments,
    updateCurrentDraft, updateDraftFor,
  } = context;
  const disposeRef = (ref: AttachmentRef | undefined, owner = uploadOwner) => {
    if (!ref) return;
    const refId = ref.id;
    // An id collision must never turn a restored remote reference into local cleanup.
    if (JSON.stringify(ref.remoteOwner ? { connectionId: ref.remoteOwner.connectionId, digest: ref.remoteOwner.digest, workspaceIdentity: ref.remoteOwner.workspaceIdentity } : null) !== JSON.stringify(owner.remote ?? null)) return;
    deferComposerAttachmentRelease(owner, refId, () => composerReferenceIsOwned(draftsRef.current.values(), refId), owner.remote && JSON.stringify(owner.remote) !== JSON.stringify(attachmentRemoteOwner) ? undefined : attachmentTransport);
  };
  const removeAttachment = (index: number) => {
    const removed = attachments[index];
    const item = uploadStore.getSnapshot().find(item => item.ref?.id === removed?.ref?.id);
    if (item) uploadStore.remove(item.id);
    updateAttachments(attachments.filter((_, itemIndex) => itemIndex !== index));
    disposeRef(removed?.ref);
  };
  const removeUpload = (id: string) => {
    const removed = uploadStore.getSnapshot().find(item => item.id === id);
    uploadStore.remove(id);
    disposeRef(removed?.ref);
  };
  const addAttachmentFiles = async (filesToAdd: FileList | File[], origin: AttachmentOrigin = "file") => {
    const incoming = Array.from(filesToAdd);
    if (!incoming.length || disabled || !attachmentsEnabled || running || ownerMismatch) return;
    const uploadOrigin = origin === 'workspace' ? 'file' : origin;
    if (richComposer) {
      if (!attachmentRoot) { setAttachmentError(tr('附件未能写入会话，草稿已保留。')); return; }
      updateCurrentDraft(current => ({ ...current, attachmentOwner: uploadOwner, attachmentError: '' }));
      uploadStore.setContext({ enabled: uploadEnabled, generation: attachmentGeneration });
      const result = uploadStore.enqueue(incoming, uploadOrigin);
      if (result.rejected.length) setAttachmentError(tr('最多 8 个附件；图片单个 20 MiB，总量 64 MiB；其他文件最多 4 个，PDF/视频单个 2 MiB、合计 4 MiB，文本 64 KiB。'));
      return;
    }
    // Plain composer compatibility. Transaction failures never enter this path.
    if (legacyAttachmentBusyRef.current) return;
    legacyAttachmentBusyRef.current = true; setLegacyAttachmentBusy(true);
    const scope = scopedDraftKey;
    try {
      const existing = (draftsRef.current.get(scope) ?? emptyComposerDraft()).attachments;
      const added: ComposerAttachment[] = [];
      let total = existing.reduce((sum, item) => sum + composerAttachmentBytes(item.data), 0);
      for (const file of incoming) {
        if (existing.length + added.length >= COMPOSER_ATTACHMENT_LIMITS.count || file.size > COMPOSER_ATTACHMENT_LIMITS.eachBytes || total + file.size > COMPOSER_ATTACHMENT_LIMITS.totalBytes) {
          setAttachmentError(tr('附件最多 4 个，单个不超过 2 MiB，总量不超过 4 MiB。')); continue;
        }
        const data = await encodeComposerFile(file);
        added.push({ name: file.name, mimeType: file.type || 'application/octet-stream', data }); total += file.size;
      }
      updateDraftFor(scope, current => ({ ...current, attachments: [...current.attachments, ...added], hadAttachments: false }));
    } catch { setAttachmentError(tr('读取附件失败，请重新选择。')); }
    finally { legacyAttachmentBusyRef.current = false; setLegacyAttachmentBusy(false); }
  };

  const handlePasteEvent = (event: React.ClipboardEvent) => {
    const pastedFiles = extractFilesFromClipboard(event.clipboardData);
    if (pastedFiles.length > 0) {
      event.preventDefault();
      event.stopPropagation();
      void addAttachmentFiles(pastedFiles, "paste");
    }
  };

  const handleDropEvent = (event: React.DragEvent) => {
    setIsDraggingOver(false);
    const files = extractFilesFromClipboard(event.dataTransfer);
    if (files.length > 0) {
      event.preventDefault();
      event.stopPropagation();
      void addAttachmentFiles(files, "drop");
    }
  };

  return { disposeRef, removeAttachment, removeUpload, addAttachmentFiles, handlePasteEvent, handleDropEvent };
}
