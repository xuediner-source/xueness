import { t as tr, tf } from '../../i18n';
import type { TimelineRow } from '../../xuenessWorkbench';

/**
 * 会话上下文压缩（progressive compaction）的时间线可见性。
 *
 * 后端 `core.compact` 会把移出请求上下文的消息存入 `archived_messages`，并在
 * `session.compactions` 追加 `{removed, masked, previous_chars, estimatedTokens, ...}`
 * 记录；会话快照的展示顺序是「归档原文在前、仍在上下文中的消息在后」。时间线
 * 因此可以在两者之间渲染一条内联边界：归档行由 journal 水合后不再携带
 * `messageIndex`（窗口化 journal 会把上下文内消息重映射为活跃索引，归档行剥离
 * 该字段），所以「第一条带 messageIndex 的行」就是仍在上下文中的开头。
 */

export type SessionCompactionRecord = {
  removed?: number;
  masked?: number;
  previous_chars?: number;
  estimatedTokens?: number;
  kept_user_turns?: number;
  advisory?: boolean;
};

export type ConversationCompactionMarker = {
  /** 分隔线渲染在「归档块之后第一条仍在模型上下文内的文本行」所属轮次的顶部。 */
  boundarySeq: number;
  /** 后端记录累计移出上下文的消息条数。 */
  removed: number;
  /** 后端记录累计掩码的旧工具输出条数。 */
  masked: number;
};

const NUMERIC_FIELDS: readonly string[] = ['removed', 'masked', 'previous_chars', 'estimatedTokens', 'kept_user_turns', 'targetChars', 'instructionsChars'];
const BOOLEAN_FIELDS: readonly string[] = ['advisory', 'manual'];

/** 防御性解析 session payload 的 compactions；形状意外时按空记录处理。 */
export function parseSessionCompactions(value: unknown): SessionCompactionRecord[] {
  if (!Array.isArray(value)) return [];
  return value.filter((record): record is SessionCompactionRecord => {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
    const source = record as Record<string, unknown>;
    return Object.entries(source).every(([key, field]) => {
      if (field === undefined || field === null) return true;
      if (NUMERIC_FIELDS.includes(key)) return typeof field === 'number' && Number.isFinite(field);
      if (BOOLEAN_FIELDS.includes(key)) return typeof field === 'boolean';
      return typeof field === 'string' || typeof field === 'number' || typeof field === 'boolean';
    });
  });
}

/** 压缩边界的单行说明；计数来自后端 compactions 记录，缺失时只陈述事实。 */
export function conversationCompactionLabel(marker: Pick<ConversationCompactionMarker, 'removed' | 'masked'>): string {
  if (marker.removed > 0 && marker.masked > 0) {
    return tf('已压缩 {0} 条较早消息，另有 {1} 条旧输出已掩码', [marker.removed, marker.masked]);
  }
  if (marker.removed > 0) return tf('已压缩 {0} 条较早消息', [marker.removed]);
  if (marker.masked > 0) return tf('已掩码 {0} 条较早的工具输出', [marker.masked]);
  return tr('较早历史已压缩出上下文');
}

function recordCount(records: SessionCompactionRecord[], key: 'removed' | 'masked'): number {
  return records.reduce((total, record) => {
    const value = record[key];
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? total + value : total;
  }, 0);
}

/**
 * 在合并后的时间线行里定位压缩边界。
 *
 * 窗口化 journal 水合后，仍在上下文中的 user/assistant 行携带重映射的
 * `messageIndex`，归档行没有该字段（工具/完成行两种情况都没有，无法判定，
 * 不参与定位）。真实压缩会话里原始任务行（seq 0，仍在上下文内）排在归档块
 * 之前，所以边界 = 「归档文本行之后第一条带 `messageIndex` 的文本行」；
 * 流式追加行（`streaming`）永远属于活上下文。找不到这样的成对结构
 * （未窗口化、本页看不到归档块、或归档块之后没有活行）时返回 null——
 * 不渲染标记，不猜测边界位置。
 */
export function conversationCompactionBoundary(
  rows: TimelineRow[],
  compactions: unknown,
): ConversationCompactionMarker | null {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  let seenArchived = false;
  for (const row of rows) {
    if (row.kind !== 'user' && row.kind !== 'assistant') continue;
    if (row.kind === 'assistant' && row.streaming === true) continue;
    if (row.messageIndex === undefined) {
      seenArchived = true;
      continue;
    }
    if (seenArchived) {
      const records = parseSessionCompactions(compactions);
      return {
        boundarySeq: row.seq,
        removed: recordCount(records, 'removed'),
        masked: recordCount(records, 'masked'),
      };
    }
  }
  return null;
}
