import React from "react";
import { t as tr } from '../../i18n';
import type { AttachmentRef, RemoteAttachmentEndpoint } from "./composerAttachmentRef";
import { editorAttachmentRefs } from "./composerAttachmentRef";
import { getComposerAttachmentUploadStore } from './composerAttachmentUploadStore';
import { attachmentOwnerMatches, composerDraftIdentityIsOwned, composerReferenceIsOwned, hasUnscopedComposerAttachments } from './composerAttachmentDraft';
import { recoverComposerDraft } from './composerRecovery';
import { ComposerRecoveryPanel } from './ComposerRecoveryPanel';
import type { ComposerCapability } from "../../xuenessComposer";
import type { ComposerMention, ComposerModelRecovery, ComposerStartActions } from './composerInputHelpers';
import type { ComposerDraftState } from './composerTypes';
import { attachmentPublishers, missingAttachmentDrafts } from './composerAttachmentRegistry';
import type { ComposerDraftsRef, ComposerUploadOwner, ComposerUploadStore, UpdateComposerDraft } from './composerHandlerTypes';

export function ComposerStatusMessages({
  ownerMismatch, legacyAttachmentBusy, attachmentError, draft, uploadStore, uploadOwner, updateCurrentDraft,
  selectedCapabilities, sendDisabled, hasSendableContent, goal, modelRecovery, sendDisabledReason, startActions,
  submissionError, availableMentions, capabilities, attachmentRoot, attachmentSessionId, attachmentRemoteOwner,
  localInputRef, setAttachmentError, draftsRef, scopedDraftKey, disposeRef,
}: {
  ownerMismatch: boolean;
  legacyAttachmentBusy: boolean;
  attachmentError: string;
  draft: ComposerDraftState;
  uploadStore: ComposerUploadStore;
  uploadOwner: ComposerUploadOwner;
  updateCurrentDraft: UpdateComposerDraft;
  selectedCapabilities: string[];
  sendDisabled: boolean;
  hasSendableContent: boolean;
  goal: boolean;
  modelRecovery?: ComposerModelRecovery;
  sendDisabledReason?: string;
  startActions?: ComposerStartActions;
  submissionError: string;
  availableMentions: ComposerMention[];
  capabilities: ComposerCapability[];
  attachmentRoot?: string;
  attachmentSessionId?: string;
  attachmentRemoteOwner?: RemoteAttachmentEndpoint;
  localInputRef: React.MutableRefObject<HTMLTextAreaElement | null>;
  setAttachmentError: (message: string) => unknown;
  draftsRef: ComposerDraftsRef;
  scopedDraftKey: string;
  disposeRef: (ref: AttachmentRef | undefined, owner?: ComposerUploadOwner) => void;
}) {
  return (
    <>
      {ownerMismatch && <div className="xn-composer__error" role="alert">{tr("附件属于原草稿，请移除后重新添加。")}</div>}
      {legacyAttachmentBusy && <div className="xn-composer__status" role="status">{tr("正在读取附件...")}</div>}
      {attachmentError && <div className="xn-composer__error" role="alert">{attachmentError}</div>}
      {draft.hadAttachments && !uploadStore.hasUnready() && <button type="button" onClick={() => { missingAttachmentDrafts.delete(uploadOwner.draftId); updateCurrentDraft(current => ({ ...current, hadAttachments: false, attachmentError: '' })); }}>{tr('移除未恢复附件')}</button>}
      {selectedCapabilities.length > 0 && <div className="xn-composer__status" role="status" data-testid="composer-capability-hint">{tr('已添加能力。描述具体需求后发送，即可使用。')}</div>}
      {sendDisabled && (hasSendableContent || goal || modelRecovery) && <div className="xn-composer__status xn-composer__setup" role="status" aria-live="polite" data-testid="composer-send-unavailable">
        <span>{sendDisabledReason || tr('选择或配置模型后即可发送。')}</span>
        {modelRecovery?.kind === "loading" && <button type="button" data-testid="composer-model-recovery-loading" disabled aria-busy="true">{tr('正在加载…')}</button>}
        {modelRecovery?.kind === "error" && <button type="button" data-testid="composer-model-recovery-retry" onClick={modelRecovery.onRetry}>{tr('重试')}</button>}
        {modelRecovery?.kind === "missing" && <button type="button" data-testid="composer-model-recovery-configure" onClick={modelRecovery.onConfigure}>{tr('配置模型')}</button>}
        {!modelRecovery && startActions?.onModels && <button type="button" onClick={startActions.onModels}>{tr('配置模型')}</button>}
      </div>}
      {submissionError && <div className="xn-composer__error" role="alert">{submissionError}</div>}
      {draft.deliveryUnconfirmed && <div className="xn-composer__error" role="status">{tr('消息接收状态暂时无法确认，请先查看会话与队列再重试。')}</div>}
      {draft.pendingSubmission && <div className="xn-composer-recovery xn-composer-recovery--sending" data-testid="composer-sending" role="status">
        <span>{tr('正在发送…')}</span>
        <p className="xn-composer-recovery__preview">{draft.pendingSubmission.draft.text || tr('附件与上下文')}</p>
      </div>}
      <ComposerRecoveryPanel drafts={draft.recoverableDrafts ?? []}
        references={availableMentions}
        capabilities={capabilities}
        attachmentState={recovered => !recovered.attachmentOwner ? 'unknown-scope'
          : attachmentOwnerMatches(recovered.attachmentOwner, attachmentRoot, attachmentSessionId, attachmentRemoteOwner) ? 'available' : 'different-scope'}
        onRestore={index => { updateCurrentDraft(current => recoverComposerDraft(current, index)); localInputRef.current?.focus(); }}
        onDiscard={index => {
          const discarded = draftsRef.current.get(scopedDraftKey)?.recoverableDrafts?.[index];
          if (discarded && hasUnscopedComposerAttachments(discarded)) {
            setAttachmentError(tr('无法确认原附件的归属范围，已保留恢复草稿。'));
            return;
          }
          updateCurrentDraft(current => ({ ...current,
            recoverableDrafts: current.recoverableDrafts?.filter((_, position) => position !== index) }));
          if (!discarded) return;
          const owner = discarded.attachmentOwner;
          if (owner && !composerDraftIdentityIsOwned(draftsRef.current.values(), owner.draftId)) {
            const manager = getComposerAttachmentUploadStore({ root: owner.root, sessionId: owner.sessionId, draftKey: owner.draftId, remote: owner.remote });
            manager.setDisposalGuard(id => composerReferenceIsOwned(draftsRef.current.values(), id));
            for (const item of manager.getSnapshot()) manager.remove(item.id);
            attachmentPublishers.get(manager)?.();
            attachmentPublishers.delete(manager);
            manager.invalidate();
            for (const ref of editorAttachmentRefs(discarded.attachments)) disposeRef(ref, owner);
          }
        }} />
    </>
  );
}
