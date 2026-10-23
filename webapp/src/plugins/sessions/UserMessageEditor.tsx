import type { AttachmentPreviewTransport } from './composerAttachmentPreviewModel';
import React from 'react';
import { t as tr } from '../../i18n';
import { deferCompositionEnd } from '../../xuenessShortcutDisplay';
import type { TimelineRow } from '../../xuenessWorkbench';
import type { ZCodeConversationProps, evaluateUserMessageEditKey } from './ZCodeConversation';
import { ComposerAttachmentChip } from './composerAttachmentPreview';
import { deferComposerAttachmentAbort } from './composerAttachmentCleanup';
import { isComposerAttachmentLifecycleEnabled } from './composerAttachmentLifecycle';
import { uploadComposerAttachment } from './composerAttachmentUpload';
import { attachmentMime, attachmentsFromRefs, COMPOSER_REF_LIMITS } from './composerAttachmentRef';
import { requestMutation } from '../../xuenessWorkbench';
import type { UploadTransport } from './composerAttachmentUpload';
import { messageEditPlainText, prepareMessageEditDraft, deferMessageEditDraftRelease, restoreMessageEditDraft, type MessageEditDraft, type MessageEditAttachmentTransport } from './messageEditAttachments';

/** Local edit draft. Cancel/unmount discards it without replacing the send draft. */
export default function UserMessageEditor({ row, sessionId, enabled, attachmentTransport, previewTransport, isSessionsEffective, onEdit, onClose, evaluateKey }: {
  row: Extract<TimelineRow, { kind: 'user' }>;
  sessionId?: string;
  previewTransport?: AttachmentPreviewTransport;
  attachmentTransport?: MessageEditAttachmentTransport;
  enabled: boolean;
  isSessionsEffective?: () => boolean;
  onEdit?: ZCodeConversationProps['onEdit'];
  onClose: () => void;
  evaluateKey: typeof evaluateUserMessageEditKey;
}) {
  const [draft, setDraft] = React.useState<MessageEditDraft>(() => ({ text: messageEditPlainText(row.text), attachments: [], unavailable: true }));
  const [restoring, setRestoring] = React.useState(enabled);
  const [uploading, setUploading] = React.useState(false);
  const attachmentEdited = React.useRef(false);
  const owned = React.useRef<MessageEditDraft>({ text: '', attachments: [] });
  const uploadAbort = React.useRef<AbortController | null>(null);
  const uploadLock = React.useRef(false);
  const prepared = React.useRef<{ key: string; token: string } | null>(null);
  const draftKey = React.useRef(`history-${crypto.randomUUID()}`);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState('');
  const compositionActive = React.useRef(false);
  const enabledRef = React.useRef(enabled);
  enabledRef.current = enabled;
  const effectiveRef = React.useRef(isSessionsEffective);
  effectiveRef.current = isSessionsEffective;
  const textEdited = React.useRef(false);
  const alive = React.useRef(true);
  React.useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  React.useEffect(() => {
    let current = true;
    const restoreAbort = new AbortController();

    const isEffective = () => enabledRef.current && effectiveRef.current?.() !== false;
    const release = (value: MessageEditDraft) => { deferMessageEditDraftRelease(value, sessionId, attachmentTransport); };
    owned.current = { text: '', attachments: [] };
    attachmentEdited.current = false; prepared.current = null;
    setDraft(previous => ({ text: previous.text, attachments: [], unavailable: true }));
    if (!enabled) { setRestoring(false); return; }
    setRestoring(true);
    void restoreMessageEditDraft({ enabled, sessionId, messageIndex: row.messageIndex, revision: row.messageRevision, text: row.text,
      transport: attachmentTransport, signal: restoreAbort.signal, isEffective: () => current && isEffective() })
      .then(value => {
        if (!current || !isEffective()) { release(value); return; }
        owned.current = value;
        setDraft(previous => ({ ...value, text: textEdited.current ? previous.text : value.text }));
        setRestoring(false);
      });
    return () => { current = false; restoreAbort.abort(); uploadAbort.current?.abort(); release(owned.current); };
  }, [enabled, sessionId, row.messageIndex, row.messageRevision, row.text, attachmentTransport]);
  const addFiles = async (files: File[]) => {
    if (!enabledRef.current || effectiveRef.current?.() === false || saving || restoring || uploadLock.current || draft.unavailable || !draft.root || !sessionId) return;
    if (attachmentTransport && (!attachmentTransport.upload || !attachmentTransport.endpoint || !attachmentTransport.draftKey)) {
      setError('Remote attachment upload unavailable'); return;
    }
    const limit = attachmentTransport?.upload?.attachmentLimits?.count ?? COMPOSER_REF_LIMITS.count;
    if (draft.attachments.length + files.length > limit || files.some(file => !attachmentMime(file.name, file.type) || file.size > COMPOSER_REF_LIMITS.imageBytes)
      || draft.attachments.reduce((sum, item) => sum + (item.ref?.size ?? 0), 0) + files.reduce((sum, file) => sum + file.size, 0) > COMPOSER_REF_LIMITS.totalBytes) {
      setError(tr('附件超出数量或大小限制，或格式不受支持。')); return;
    }
    uploadLock.current = true; setUploading(true); setError('');
    const controller = new AbortController(); uploadAbort.current = controller;
    const isCurrent = () => alive.current && !controller.signal.aborted && enabledRef.current && effectiveRef.current?.() !== false;
    const localUpload: UploadTransport = (path, body, signal) => requestMutation('POST', path, body, signal, isCurrent);
    try {
      for (const file of files) {
        let pendingId: string | undefined;
        try {
          const ref = await uploadComposerAttachment({ file, origin: 'file', uploadId: crypto.randomUUID().replaceAll('-', ''),
            owner: { root: draft.root, sessionId, draftKey: attachmentTransport?.draftKey ?? draftKey.current,
              ...(attachmentTransport?.endpoint ? { remote: attachmentTransport.endpoint } : {}) },
            signal: controller.signal, isCurrent, transport: attachmentTransport?.upload ?? localUpload,
            onProgress: progress => { pendingId = progress.ref.id; } });
          const attachments = attachmentsFromRefs([ref]);
          owned.current = { ...owned.current, attachments: [...owned.current.attachments, ...attachments] };
          attachmentEdited.current = true; prepared.current = null;
          setDraft(previous => ({ ...previous, attachments: [...previous.attachments, ...attachments] }));
        } catch (problem) {
          // An ambiguous upload never becomes sendable; abort only its original identity.
          if (pendingId) {
            const cleanup: UploadTransport = attachmentTransport?.cleanup ?? (attachmentTransport
              ? async () => { throw new Error('Remote cleanup transport unavailable'); }
              : (path, body, signal) => requestMutation('POST', path, body, signal, isComposerAttachmentLifecycleEnabled));
            deferComposerAttachmentAbort({ root: draft.root, sessionId,
              draftKey: attachmentTransport?.draftKey ?? draftKey.current,
              ...(attachmentTransport?.endpoint ? { remote: attachmentTransport.endpoint } : {}) }, pendingId, () => false, cleanup);
          }
          throw problem;
        }
      }
    } catch (problem) { if (isCurrent()) setError(problem instanceof Error ? problem.message : String(problem)); }
    finally { uploadLock.current = false; if (alive.current) setUploading(false); }
  };
  const save = async () => {
    if (!onEdit || !enabled || effectiveRef.current?.() === false || saving || uploading || restoring || draft.unavailable || !draft.text.trim()) return;
    setSaving(true); setError('');
    try {
      let replacement: { preparedToken: string } | undefined;
      if (attachmentEdited.current) {
        const key = JSON.stringify([draft.text, draft.attachments.map(item => item.ref!.id)]);
        if (prepared.current?.key !== key) prepared.current = { key, token: await prepareMessageEditDraft(draft, sessionId!,
          () => alive.current && enabledRef.current && effectiveRef.current?.() !== false, attachmentTransport) };
        replacement = { preparedToken: prepared.current.token };
      }
      const accepted = await onEdit(row, draft.text, onClose, replacement);
      if (accepted && alive.current) onClose();
    } catch (reason) {
      if (alive.current) setError(reason instanceof Error ? reason.message : tr('修改失败，输入已保留。'));
    } finally { if (alive.current) setSaving(false); }
  };
  return <form className="xn-zc-editor" data-testid="message-edit-composer" onSubmit={event => { event.preventDefault(); void save(); }}>
    <textarea aria-label={tr('编辑消息')} value={draft.text} autoFocus disabled={saving || uploading}
      onChange={event => { textEdited.current = true; setDraft(previous => ({ ...previous, text: event.target.value })); }}
      onCompositionStart={event => { compositionActive.current = true; event.currentTarget.setAttribute('data-composing', 'true'); }}
      onCompositionEnd={event => {
        const el = event.currentTarget;
        deferCompositionEnd(() => { compositionActive.current = false; el?.removeAttribute('data-composing'); });
      }}
      onKeyDown={event => {
        const action = evaluateKey({ ...event, compositionActive: compositionActive.current }, { saving });
        if (action === 'cancel') { event.preventDefault(); onClose(); }
        else if (action === 'save') { event.preventDefault(); void save(); }
      }} />
    {enabled && draft.attachments.length > 0 && <div className="xn-composer__context" data-testid="message-edit-attachments">
      {draft.attachments.map(attachment => <ComposerAttachmentChip key={attachment.ref!.id} attachment={attachment}
        enabled={enabled} onRemove={!saving && !uploading && onEdit ? () => {
          attachmentEdited.current = true; prepared.current = null;
          setDraft(previous => ({ ...previous, attachments: previous.attachments.filter(item => item.ref!.id !== attachment.ref!.id) }));
        } : undefined} previewTransport={previewTransport} root={draft.root} sessionId={sessionId} />)}
    </div>}
    {enabled && <label>{tr('添加附件')}<input type="file" multiple aria-label={tr('添加附件')}
      disabled={!onEdit || saving || uploading || restoring || draft.unavailable} onChange={event => {
        const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ''; void addFiles(files);
      }} /></label>}
    {uploading && <p role="status">{tr('正在上传附件…')}</p>}
    <p className="xn-zc-editor-note">{tr('重新发送会替换这条消息及其后续对话。工作区文件保持当前状态。')}</p>
    {enabled && !restoring && draft.unavailable && <p role="alert">{tr('附件无法完整恢复，暂不能重新发送。请取消编辑以保留原消息及附件。')}</p>}
    {error && <p role="alert">{error}</p>}
    <div><button type="button" disabled={saving} onClick={onClose}>{tr('取消')}</button>
      <button type="submit" disabled={!onEdit || !enabled || saving || uploading || restoring || draft.unavailable || !draft.text.trim()}>{tr(saving ? '正在发送…' : '发送')}</button></div>
  </form>;
}
