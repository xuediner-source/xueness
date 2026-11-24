import React from "react";
import { t as tr, tf } from '../../i18n';
import { IconX } from "../../ui/icons";
import type { ComposerCapability } from "../../xuenessComposer";
import { attachmentsFromRefs, type ComposerAttachment } from "./composerAttachmentRef";
import { capabilityLabel } from './ComposerCapabilityMenu';
import type { ComposerMention } from './composerInputHelpers';
import type { ComposerDraftState } from './composerTypes';
import type { ComposerUploadOwner, ComposerUploadStore, UpdateComposerDraft } from './composerHandlerTypes';

// Chip shell stays in this module. Preview kind, button and dialog load on demand.
const ComposerAttachmentChips = React.lazy(() => import('./composerAttachmentPreview'));

export function ComposerContextChips({
  selectedCapabilities, capabilities, updateCurrentDraft, goal, setGoal, selectedContext, selectedMention, toggleContext,
  richComposer, uploadItems, uploadEnabled, uploadOwner, removeUpload, uploadStore, ownerMismatch, attachments,
  attachmentRoot, attachmentSessionId, removeAttachment,
}: {
  selectedCapabilities: string[];
  capabilities: ComposerCapability[];
  updateCurrentDraft: UpdateComposerDraft;
  goal: boolean;
  setGoal: (value: boolean | ((previous: boolean) => boolean)) => unknown;
  selectedContext: ComposerDraftState['selectedContext'];
  selectedMention: (kind: ComposerMention["kind"], id: string) => ComposerMention;
  toggleContext: (mention: ComposerMention) => void;
  richComposer: boolean;
  uploadItems: ReturnType<ComposerUploadStore['getSnapshot']>;
  uploadEnabled: boolean;
  uploadOwner: ComposerUploadOwner;
  removeUpload: (id: string) => void;
  uploadStore: ComposerUploadStore;
  ownerMismatch: boolean;
  attachments: ComposerAttachment[];
  attachmentRoot?: string;
  attachmentSessionId?: string;
  removeAttachment: (index: number) => void;
}) {
  const attachmentChipShell = attachments.map((attachment, index) => (
    <span className="xn-composer__context-chip" key={(attachment.ref?.id ?? attachment.name) + ":" + index}
      data-testid="composer-attachment-chip" data-attachment-origin={attachment.ref?.origin}>
      <span>{attachment.name}</span>
      <button type="button" aria-label={tf("移除附件：{0}", [attachment.name])} onClick={() => removeAttachment(index)}>
        <IconX size={12} />
      </button>
    </span>
  ));
  const previewChips = Boolean(richComposer && attachmentRoot && attachments.length > 0);
  return (
        <div className="xn-composer__chips" aria-label={tr("已添加的上下文")} data-testid="composer-selected-context" aria-live="polite" aria-relevant="additions removals">
          {selectedCapabilities.map(id => {
            const capability = capabilities.find(item => item.id === id);
            return <span className="xn-composer__context-chip" key={id} data-testid={`composer-capability-chip-${id}`}>
              <span>{capability ? capabilityLabel(capability) : id}</span>
              <button type="button" aria-label={tr("移除能力")} onClick={() => updateCurrentDraft(current => ({ ...current,
                selectedCapabilities: (current.selectedCapabilities ?? []).filter(value => value !== id) }))}><IconX size={12} /></button>
            </span>;
          })}
          {goal && (
            <span className="xn-composer__context-chip" data-testid="composer-goal-chip">
              {tr("目标")}
              <button type="button" aria-label={tr("移除目标标记")} onClick={() => setGoal(false)}><IconX size={12} /></button>
            </span>
          )}
          {(["files", "sessions", "skills", "plugins"] as const).flatMap((field) => {
            const kind = field === "files" ? "file" : field === "sessions" ? "session" : field === "skills" ? "skill" : "plugin";
            return selectedContext[field].map((id) => {
              const mention = selectedMention(kind, id);
              return (
                <span className="xn-composer__context-chip" key={kind + ":" + id} data-testid={"composer-context-" + kind}>
                  <span>{mention.label}</span>
                  <button type="button" aria-label={tf("移除上下文：{0}", [mention.label])} onClick={() => toggleContext(mention)}><IconX size={12} /></button>
                </span>
              );
            });
          })}
          {richComposer && uploadItems.length > 0 ? uploadItems.map(item => (
            <span className="xn-composer__context-chip" key={item.id} data-testid="composer-upload-chip" data-upload-state={item.state} title={item.error}>
              {item.state === 'ready' && item.ref ? <React.Suspense fallback={<span>{item.name}</span>}>
                <ComposerAttachmentChips attachments={attachmentsFromRefs([item.ref])} enabled={uploadEnabled}
                  root={uploadOwner.root} sessionId={uploadOwner.sessionId} onRemove={() => removeUpload(item.id)} />
              </React.Suspense> : <span>{item.name}</span>}
              <span role="status">{item.state === 'queued' ? tr('附件排队中') : item.state === 'uploading' ? `${tr('附件上传中')} ${Math.round(item.progress)}%` : item.state === 'failed' ? tr('附件上传失败') : tr('附件已就绪')}</span>
              {item.state === 'uploading' && <progress max={item.size || 1} value={item.uploadedBytes} aria-label={item.name} />}
              {item.state === 'failed' && <button type="button" disabled={!uploadEnabled || ownerMismatch} onClick={() => uploadStore.retry(item.id)}>{tr('重试附件')}</button>}
              {item.state !== 'ready' && <button type="button" aria-label={tf('移除附件：{0}', [item.name])} onClick={() => removeUpload(item.id)}>{item.state === 'uploading' || item.state === 'queued' ? tr('取消') : <IconX size={12} />}</button>}
            </span>
          )) : previewChips ? (
            <React.Suspense fallback={attachmentChipShell}>
              <ComposerAttachmentChips
                attachments={attachments}
                enabled={richComposer}
                root={attachmentRoot}
                sessionId={attachmentSessionId}
                onRemove={removeAttachment}
              />
            </React.Suspense>
          ) : attachmentChipShell}
        </div>
  );
}
