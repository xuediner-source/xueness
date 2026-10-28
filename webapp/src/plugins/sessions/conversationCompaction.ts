import { getLocale, t as tr, type Locale } from '../../i18n';
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
  /** ZCode compaction (ts/plugins/providers/src/zcode-compact.ts): model summary, flat scalar record. */
  kind?: string;
  trigger?: string;
  manual?: boolean;
  kept?: number;
  summarizedMessageCount?: number;
  preCompactTokens?: number;
  postCompactTokens?: number;
  truePostCompactTokens?: number;
  willRetriggerNextTurn?: boolean;
  /** 这次压缩本身花掉的墙钟时间（毫秒）；后端未上报时缺省。 */
  elapsedMs?: number;
};

export type ConversationCompactionMarker = {
  manual?: boolean;
  /** 分隔线渲染在「归档块之后第一条仍在模型上下文内的文本行」所属轮次的顶部。 */
  boundarySeq: number;
  /** 后端记录累计移出上下文的消息条数。 */
  removed: number;
  /** 后端记录累计掩码的旧工具输出条数。 */
  masked: number;
  /** 最近一条压缩记录（可选）；ZCode 记录（kind "zcode"）用 ZCode 的文案。 */
  latest?: SessionCompactionRecord;
  /** 所有压缩记录上报的耗时之和（毫秒）；后端全未上报时缺省。 */
  elapsedMs?: number;
};

/** Attach archive provenance to tool rows: unlike text rows, tools have no
 * messageIndex, so the journal window's explicit null index is needed to tell
 * an archived result from an active one. */
export function markArchivedToolRows(rows: TimelineRow[], journal: unknown): TimelineRow[] {
  if (!journal || typeof journal !== 'object' || Array.isArray(journal)) return rows;
  const source = journal as Record<string, unknown>;
  const messages = source.messages;
  const window = source.message_window;
  if (!Array.isArray(messages) || !window || typeof window !== 'object' || Array.isArray(window)) return rows;
  const indices = (window as Record<string, unknown>).messageIndices;
  if (!Array.isArray(indices) || indices.length !== messages.length) return rows;
  const archivedCalls = new Set<string>();
  messages.forEach((value, index) => {
    if (indices[index] !== null || !value || typeof value !== 'object' || Array.isArray(value)) return;
    const message = value as Record<string, unknown>;
    if (message.role === 'tool' && typeof message.tool_call_id === 'string') archivedCalls.add(message.tool_call_id);
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        if (call && typeof call === 'object' && !Array.isArray(call)
          && typeof (call as Record<string, unknown>).id === 'string') {
          archivedCalls.add((call as Record<string, unknown>).id as string);
        }
      }
    }
  });
  if (!archivedCalls.size) return rows;
  return rows.map(row => row.kind === 'tool' && archivedCalls.has(row.toolCallId)
    ? { ...row, archivedForCompaction: true } : row);
}

const NUMERIC_FIELDS: readonly string[] = ['removed', 'masked', 'previous_chars', 'estimatedTokens', 'kept_user_turns', 'targetChars', 'instructionsChars',
  'kept', 'summarizedMessageCount', 'preCompactTokens', 'postCompactTokens', 'truePostCompactTokens', 'elapsedMs'];
const BOOLEAN_FIELDS: readonly string[] = ['advisory', 'manual', 'willRetriggerNextTurn'];

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

/**
 * 压缩耗时文本：`12秒` / `1分12秒` / `1小时2分`，en 为 `12s` / `1m 12s` / `1h 2m`。
 *
 * 耗时单位属于占位符实参（整句在 i18n 表里），所以单位必须跟着 locale 走，
 * 否则 en 界面会在英文句子里混进中文单位。不足 1 秒按 1 秒计，避免「0秒」。
 */
export function formatCompactElapsed(ms: number, locale: Locale = getLocale()): string {
  const totalSeconds = Math.max(1, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return locale === 'en' ? `${hours}h ${minutes}m` : `${hours}小时${minutes}分`;
  if (minutes > 0) return locale === 'en' ? `${minutes}m ${seconds}s` : `${minutes}分${seconds}秒`;
  return locale === 'en' ? `${seconds}s` : `${seconds}秒`;
}

/** 压缩边界的单行说明；耗时来自后端 compactions 累计的 elapsedMs，缺失时只陈述事实。 */
export function conversationCompactionLabel(
  marker: Pick<ConversationCompactionMarker, 'removed' | 'masked' | 'latest' | 'elapsedMs' | 'manual'>,
): string {
  return tr(marker.manual || marker.latest?.trigger === 'manual' || marker.latest?.manual ? '上下文已压缩' : '上下文已自动压缩');
}

function recordCount(records: SessionCompactionRecord[], key: 'removed' | 'masked'): number {
  return records.reduce((total, record) => {
    const value = record[key];
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? total + value : total;
  }, 0);
}

/** 耗时允许小数毫秒，所以只要求有限正数，不要求整数。 */
function recordElapsedMs(records: SessionCompactionRecord[]): number {
  return records.reduce((total, record) => {
    const value = record.elapsedMs;
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? total + value : total;
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
    if (row.kind === 'tool' && row.archivedForCompaction === true) {
      seenArchived = true;
      continue;
    }
    if (row.kind !== 'user' && row.kind !== 'assistant') continue;
    if (row.kind === 'assistant' && row.streaming === true) continue;
    if (row.messageIndex === undefined) {
      seenArchived = true;
      continue;
    }
    if (seenArchived) {
      const records = parseSessionCompactions(compactions);
      const latest = records.at(-1);
      const elapsedMs = recordElapsedMs(records);
      return {
        boundarySeq: row.seq,
        removed: recordCount(records, 'removed'),
        masked: recordCount(records, 'masked'),
        ...(elapsedMs > 0 ? { elapsedMs } : {}),
        ...(latest?.kind === 'zcode' ? { latest } : latest?.manual || latest?.trigger === 'manual' ? { manual: true } : {}),
      };
    }
  }
  return null;
}
