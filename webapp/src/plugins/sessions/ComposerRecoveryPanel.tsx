import React from 'react';
import { t as tr, tf } from '../../i18n';
import type { RecoverableComposerDraft } from './composerRecovery';
import './ComposerRecovery.css';

export function ComposerRecoveryPanel({ drafts, onRestore, onDiscard }: {
  drafts: RecoverableComposerDraft[]; onRestore(index: number): void; onDiscard(index: number): void;
}) {
  if (!drafts.length) return null;
  return <details className="xn-composer-recovery" data-testid="composer-recovery">
    <summary><span role="status">{tf('已保留 {0} 条消息草稿', [drafts.length])}</span></summary>
    <p>{tr('恢复时会保留输入框里的现有内容。')}</p>
    <ul>{drafts.map((draft, index) => <li key={index}>
      <p className="xn-composer-recovery__preview">{draft.text || tr('附件与上下文')}</p>
      {!!draft.attachments?.length && <span>{tf('{0} 个附件', [draft.attachments.length])}</span>}
      {draft.attachmentError && <p className="xn-composer-recovery__error">{draft.attachmentError}</p>}
      {draft.deliveryUnconfirmed ? <p className="xn-composer-recovery__error">{tr('消息接收状态暂时无法确认，请先查看会话与队列再重试。')}</p>
        : draft.submissionError && <p className="xn-composer-recovery__error">{draft.submissionError}</p>}
      <div><button type="button" onClick={() => onRestore(index)}>{tr('恢复草稿')}</button>
        <button type="button" onClick={() => onDiscard(index)}>{tr('丢弃此草稿')}</button></div>
    </li>)}</ul>
  </details>;
}
