import React from 'react';
import { getLocale } from '../../i18n';
import type { TimelineRow } from '../../xuenessWorkbench';

export type ConversationFactMarker = {
  id: string; kind: 'fork' | 'checkpoint_source' | 'model' | 'edit' | 'context';
  message_id: string; placement: 'before_user' | 'work_tail'; label?: string;
  effect?: 'immediate' | 'next_run' | 'next_request';
  context_kind?: 'files' | 'sessions' | 'skills' | 'plugins' | 'capabilities';
};
const token = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/u.test(value);
const label = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
  && value.length <= 120 && !/[\p{Cc}\p{Cf}/\\<>@]/u.test(value) && !value.includes('://');

/** Snapshot facts only; no timestamp sorting, prose inference, requests or file reads. */
export function conversationMarkers(raw: unknown, rows: readonly TimelineRow[], placement: ConversationFactMarker['placement'], enabled: boolean): ConversationFactMarker[] {
  if (!enabled || !Array.isArray(raw)) return [];
  const anchors = new Set(rows.flatMap(row => (row.kind === 'user' || row.kind === 'assistant') && row.messageId ? [row.messageId] : []));
  const users = new Set(rows.flatMap(row => row.kind === 'user' && row.messageId ? [row.messageId] : []));
  const seen = new Set<string>();
  return raw.slice(-400).flatMap(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const item = value as ConversationFactMarker;
    if (!token(item.id) || !token(item.message_id) || !anchors.has(item.message_id) || seen.has(item.id)
      || item.placement !== placement || !['fork', 'checkpoint_source', 'model', 'edit', 'context'].includes(item.kind)) return [];
    if (placement === 'before_user' && (!users.has(item.message_id) || !['edit', 'context'].includes(item.kind))) return [];
    if (placement === 'work_tail' && !['fork', 'checkpoint_source', 'model'].includes(item.kind)) return [];
    if (item.kind === 'model' && (!label(item.label) || !['immediate', 'next_run', 'next_request'].includes(item.effect ?? ''))) return [];
    if (item.kind === 'context' && (!label(item.label) || !['files', 'sessions', 'skills', 'plugins', 'capabilities'].includes(item.context_kind ?? ''))) return [];
    // Provider input formats are configuration, not material selected for this message.
    if (item.kind === 'context' && item.context_kind === 'capabilities' && ['image', 'pdf', 'video'].includes(item.label ?? '')) return [];
    seen.add(item.id);
    return [{ id: item.id, kind: item.kind, message_id: item.message_id, placement: item.placement,
      ...(item.kind === 'model' ? { label: item.label, effect: item.effect } : {}),
      ...(item.kind === 'context' ? { label: item.label, context_kind: item.context_kind } : {}) }];
  });
}

function markerLabel(marker: ConversationFactMarker): string {
  const en = getLocale() === 'en';
  if (marker.kind === 'fork') return en ? 'Forked from source conversation' : '从源会话分叉';
  if (marker.kind === 'checkpoint_source') return en ? 'Fork source: checkpoint' : '分叉来源：检查点';
  if (marker.kind === 'edit') return en ? 'User message edited' : '用户消息已编辑';
  if (marker.kind === 'model') return `${en ? 'Model selected' : '已选择模型'}: ${marker.label} · ${marker.effect === 'immediate' ? (en ? 'immediate' : '立即生效') : (en ? 'next request' : '下次请求生效')}`;
  const kinds = { files: en ? 'File' : '文件', sessions: en ? 'Session' : '会话', skills: en ? 'Skill' : '技能', plugins: en ? 'Plugin' : '插件', capabilities: en ? 'Capability' : '能力' };
  return `${kinds[marker.context_kind!]}: ${marker.label}`;
}

export function ConversationMarkers({ facts, rows, placement, enabled }: {
  facts: unknown; rows: readonly TimelineRow[]; placement: ConversationFactMarker['placement']; enabled: boolean;
}) {
  const markers = conversationMarkers(facts, rows, placement, enabled);
  if (!markers.length) return null;
  return <div className="xn-zc-fact-markers" role="note" data-testid={`timeline-facts-${placement}`}>
    {markers.map(marker => <span key={marker.id} className="xn-zc-fact-chip" data-fact-id={marker.id} data-fact-kind={marker.kind}>{markerLabel(marker)}</span>)}
  </div>;
}
