import type { ComposerInput, ComposerCapability } from '../../xuenessComposer';
import type { ComposerMention, ComposerDraftState } from './XuenessWorkbenchView';
import { attachmentPayloadForSend, parseAttachmentRef } from './composerAttachmentRef';
import type { AttachmentUploadItem } from './composerAttachmentUploadStore';

export type ComposerMaterialState = 'included' | 'not-ready' | 'not-selected' | 'unavailable';
export type ComposerMaterial = {
  id: string;
  kind: 'attachment' | 'file' | 'session' | 'skill' | 'plugin' | 'capability';
  label: string;
  state: ComposerMaterialState;
  note?: string;
};

export type ComposerMaterialCatalog = {
  mentions: ComposerMention[];
  capabilities: ComposerCapability[];
  uploads?: readonly AttachmentUploadItem[];
  attachmentsEnabled?: boolean;
  ownerMismatch?: boolean;
};

/** This is the single composer payload builder used by both the send path and its preview. */
export function composerInputForDraft(draft: Pick<ComposerDraftState,
  'attachments' | 'selectedContext' | 'selectedCapabilities' | 'goal'>, richComposer: boolean): ComposerInput {
  const attachmentPayload = attachmentPayloadForSend(draft.attachments, richComposer);
  return {
    attachments: attachmentPayload.attachments,
    ...(attachmentPayload.attachmentRefs ? { attachmentRefs: attachmentPayload.attachmentRefs } : {}),
    files: draft.selectedContext.files,
    sessions: draft.selectedContext.sessions,
    skills: draft.selectedContext.skills,
    plugins: draft.selectedContext.plugins,
    capabilities: draft.selectedCapabilities ?? [],
    goal: draft.goal,
  };
}

export function composerMaterialsForDraft(
  draft: Pick<ComposerDraftState, 'attachments' | 'selectedContext' | 'selectedCapabilities' | 'goal' | 'hadAttachments'>,
  richComposer: boolean,
  catalog: ComposerMaterialCatalog,
): ComposerMaterial[] {
  const input = composerInputForDraft(draft, richComposer);
  const rows: ComposerMaterial[] = [];
  const includedRefs = new Set(input.attachmentRefs?.map(ref => ref.id) ?? []);
  const inline = [...input.attachments];

  for (const [index, attachment] of draft.attachments.entries()) {
    const ref = parseAttachmentRef(attachment.ref);
    let included = false;
    let note: string | undefined;
    if (ref) {
      included = includedRefs.has(ref.id);
    } else {
      const inlineIndex = inline.findIndex(item => item.name === attachment.name
        && item.mimeType === attachment.mimeType && item.data === attachment.data);
      if (inlineIndex >= 0) {
        inline.splice(inlineIndex, 1);
        included = true;
      }
    }
    let state: ComposerMaterialState = included ? 'included' : 'not-ready';
    if (catalog.ownerMismatch || catalog.attachmentsEnabled === false || (ref && !richComposer)) {
      state = 'unavailable';
      note = catalog.ownerMismatch
        ? '附件属于原工作区或会话，当前草稿无法发送。'
        : '当前输入方式无法发送此附件引用。';
    } else if (!included) {
      note = '附件尚未就绪，不会随本条消息发送。';
    }
    rows.push({ id: `attachment:${ref?.id ?? attachment.name}:${index}`, kind: 'attachment', label: attachment.name, state, note });
  }

  const representedUploadIds = new Set(draft.attachments.flatMap(item => item.ref?.id ? [item.ref.id] : []));
  for (const upload of catalog.uploads ?? []) {
    if (representedUploadIds.has(upload.ref?.id ?? '')) continue;
    const state = upload.state === 'ready'
      ? catalog.attachmentsEnabled === false ? 'unavailable' : 'not-selected'
      : 'not-ready';
    rows.push({ id: `upload:${upload.id}`, kind: 'attachment', label: upload.name, state,
      note: upload.state === 'ready'
        ? catalog.attachmentsEnabled === false ? '当前输入方式不能发送附件。' : '附件已就绪，但还没有加入本条消息。'
        : upload.state === 'failed' ? '附件上传失败，不会随本条消息发送。' : '附件尚未就绪，不会随本条消息发送。' });
  }
  if (draft.hadAttachments) rows.push({ id: 'attachment:recovery-missing', kind: 'attachment', label: '原附件', state: 'unavailable',
    note: '重开后无法恢复附件内容，请重新添加；此附件不会发送。' });

  const mentionByKey = new Map(catalog.mentions.map(item => [`${item.kind}:${item.id}`, item]));
  for (const kind of ['file', 'session', 'skill', 'plugin'] as const) {
    const field = kind === 'file' ? input.files : kind === 'session' ? input.sessions : kind === 'skill' ? input.skills : input.plugins;
    for (const id of field) {
      const mention = mentionByKey.get(`${kind}:${id}`);
      rows.push({ id: `${kind}:${id}`, kind, label: mention?.label ?? id, state: 'included',
        ...(!mention ? { note: '当前目录未找到此引用；仍会按已保存的引用提交。' } : {}) });
    }
  }

  const capabilityById = new Map(catalog.capabilities.map(item => [item.id, item]));
  for (const id of input.capabilities ?? []) {
    const capability = capabilityById.get(id);
    rows.push({ id: `capability:${id}`, kind: 'capability', label: capability?.label ?? id, state: 'included',
      ...(capability?.available === false ? { note: '此能力当前不可用，但仍保留在已选内容中。' } : !capability ? { note: '当前能力目录未找到此项；仍保留已选内容。' } : {}) });
  }
  return rows;
}
