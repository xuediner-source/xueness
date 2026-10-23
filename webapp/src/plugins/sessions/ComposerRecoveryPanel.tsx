import React from 'react';
import { t as tr, tf } from '../../i18n';
import type { RecoverableComposerDraft } from './composerRecovery';
import type { ComposerCapability } from '../../xuenessComposer';
import type { ComposerMention } from './XuenessWorkbenchView';
import './ComposerRecovery.css';

export type RecoveryAttachmentState = 'available' | 'different-scope' | 'unknown-scope' | 'unavailable';

const referenceKindLabel = { file: '文件', session: '会话', skill: '技能', plugin: '插件' } as const;

export function ComposerRecoveryPanel({ drafts, onRestore, onDiscard, references = [], capabilities = [], attachmentState }: {
  drafts: RecoverableComposerDraft[];
  onRestore(index: number): void;
  onDiscard(index: number): void;
  references?: ComposerMention[];
  capabilities?: ComposerCapability[];
  attachmentState?: (draft: RecoverableComposerDraft) => RecoveryAttachmentState;
}) {
  if (!drafts.length) return null;
  return <details className="xn-composer-recovery" data-testid="composer-recovery">
    <summary><span role="status">{tf('已保留 {0} 条消息草稿', [drafts.length])}</span></summary>
    <p>{tr('恢复会把当前输入另存为一条草稿，不会发送消息。')}</p>
    <ul>{drafts.map((draft, index) => <li key={index}>
      <p className="xn-composer-recovery__preview">{draft.text || tr('附件与上下文')}</p>
      {(draft.attachments?.length > 0 || draft.hadAttachments || Object.values(draft.selectedContext ?? {}).some(items => items.length)
        || (draft.selectedCapabilities?.length ?? 0) > 0) && <div className="xn-composer-recovery__materials">
        <strong>{tr('将恢复的材料')}</strong>
        <ul>
          {draft.attachments?.map((attachment, attachmentIndex) => {
            const status = attachment.ref
              ? attachmentState?.(draft) ?? 'unknown-scope'
              : attachment.data ? 'available' : 'unavailable';
            const statusText = status === 'available'
              ? attachment.ref ? tr('引用已保留，发送前会检查可用性。') : tr('附件内容仍在草稿中。')
              : status === 'different-scope' ? tr('原工作区或会话不同，此附件不能在当前草稿发送。')
                : status === 'unavailable' ? tr('附件内容未保留，请重新添加。')
                  : tr('附件归属无法确认，请恢复后核对。');
            return <li key={`attachment:${attachment.ref?.id ?? attachment.name}:${attachmentIndex}`} data-testid="composer-recovery-reference">
              <span>{tr('附件')} · {attachment.name}</span><small>{statusText}</small>
            </li>;
          })}
          {draft.hadAttachments && <li data-testid="composer-recovery-reference" data-availability="unavailable">
            <span>{tr('原附件')}</span><small>{tr('附件内容无法恢复，重新添加后才能发送。')}</small>
          </li>}
          {(['files', 'sessions', 'skills', 'plugins'] as const).flatMap(field => {
            const kind = field === 'files' ? 'file' : field === 'sessions' ? 'session' : field === 'skills' ? 'skill' : 'plugin';
            return (draft.selectedContext?.[field] ?? []).map(id => {
              const found = references.find(item => item.kind === kind && item.id === id);
              return <li key={`${kind}:${id}`} data-testid="composer-recovery-reference" data-availability={found ? 'available' : 'not-listed'}>
                <span>{tr(referenceKindLabel[kind])} · {found?.label ?? id}</span>
                <small>{found ? tr('当前目录中仍可找到此引用。') : tr('当前目录未列出此引用；恢复时会保留原标识。')}</small>
              </li>;
            });
          })}
          {(draft.selectedCapabilities ?? []).map(id => {
            const found = capabilities.find(item => item.id === id);
            const available = found?.available !== false && Boolean(found);
            return <li key={`capability:${id}`} data-testid="composer-recovery-reference" data-availability={available ? 'available' : 'unavailable'}>
              <span>{tr('能力')} · {found?.label ?? id}</span>
              <small>{available ? tr('当前能力可用。') : tr('当前能力不可用；恢复时会保留原选择。')}</small>
            </li>;
          })}
        </ul>
      </div>}
      {draft.attachmentError && <p className="xn-composer-recovery__error">{draft.attachmentError}</p>}
      {draft.deliveryUnconfirmed ? <p className="xn-composer-recovery__error">{tr('消息接收状态暂时无法确认，请先查看会话与队列再重试。')}</p>
        : draft.submissionError && <p className="xn-composer-recovery__error">{draft.submissionError}</p>}
      <div><button type="button" onClick={() => onRestore(index)}>{tr('恢复草稿')}</button>
        <button type="button" onClick={() => onDiscard(index)}>{tr('丢弃此草稿')}</button></div>
    </li>)}</ul>
  </details>;
}
