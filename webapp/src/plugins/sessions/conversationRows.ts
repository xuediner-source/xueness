import type { TimelineRow } from '../../xuenessWorkbench';
import type { MarkdownRenderOptions } from '../../XuenessShell';
import { conversationFindRowKey } from './ConversationFind';
import type { Assistant, ConversationTurn } from './conversationTypes';

export const streamingMarkdown: MarkdownRenderOptions = { codeHighlightTiming: 'after-stream', cacheParseResults: false };
export const settledMarkdown: MarkdownRenderOptions = { codeHighlightTiming: 'on-visible', cacheParseResults: true };

export function timelineRowTurnId(row: TimelineRow): string | undefined {
  if (!('turnId' in row)) return undefined;
  const turnId = row.turnId;
  return typeof turnId === 'string' ? turnId : undefined;
}

/** Preserve source order, including tool results updated in place by call ID. */
export function buildConversationTurns(rows: TimelineRow[]): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  let currentTurnId: string | undefined;
  for (const row of rows) {
    const rowTurnId = timelineRowTurnId(row);
    if (!turns.length || row.kind === 'user' && rowTurnId !== currentTurnId) {
      const stableId = (row.kind === 'user' || row.kind === 'assistant') && row.messageId ? row.messageId : row.seq;
      turns.push({ key: row.kind === 'user' ? `user:${stableId}` : `leading:${stableId}`, rows: [],
        ...(row.kind === 'user' ? { userSeq: row.seq } : {}) });
      currentTurnId = undefined;
    }
    turns[turns.length - 1].rows.push(row);
    if (!currentTurnId && rowTurnId) currentTurnId = rowTurnId;
  }
  return turns;
}

export function rowData(row: TimelineRow): { 'data-zcode-row-key': string; 'data-zcode-row-kind': string; 'data-zcode-row-seq': number } {
  return {
    'data-zcode-row-key': conversationFindRowKey(row),
    'data-zcode-row-kind': row.kind,
    'data-zcode-row-seq': row.seq,
  };
}

export function visibleAssistantText(row: Assistant): string {
  return row.streaming ? row.text : (row.displayText ?? row.text);
}
