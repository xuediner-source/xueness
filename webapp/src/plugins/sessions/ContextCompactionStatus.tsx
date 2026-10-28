import React from 'react';
import { t as tr } from '../../i18n';
import { conversationCompactionLabel, type ConversationCompactionMarker } from './conversationCompaction';
import './context-compaction-status.css';

/** The same quiet inline status for the live request and the persisted archive boundary. */
export function ContextCompactionStatus({ complete = false, label, detail }: { complete?: boolean; label?: string; detail?: string }) {
  return <span className="xn-context-compaction-status" data-state={complete ? 'complete' : 'running'} title={detail}>
    <svg viewBox="0 0 20 20" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 3H3.8A1.8 1.8 0 0 0 2 4.8v3.4L.8 10 2 11.8v3.4A1.8 1.8 0 0 0 3.8 17H5M15 3h1.2A1.8 1.8 0 0 1 18 4.8v10.4a1.8 1.8 0 0 1-1.8 1.8H15M7 6h6M7 10h4M7 14h6" />
    </svg>
    <span>{label ?? tr(complete ? '上下文已自动压缩' : '正在压缩上下文 · 可能需要几分钟')}</span>
  </span>;
}

export function CompactionBoundary({ marker }: { marker: ConversationCompactionMarker }) {
  const label = conversationCompactionLabel(marker);
  const detail = tr('此边界以上的历史已压缩或掩码出模型上下文，原文保留在会话日志。');
  return <div className="xn-zc-compaction" data-testid="timeline-compaction-boundary" role="note" aria-label={`${label} ${detail}`}>
    <ContextCompactionStatus complete label={label} detail={detail} />
  </div>;
}
