import type { TimelineRow, ReasoningHistoryEntry, ReasoningTimingEntry } from '../../xuenessWorkbench';

function timingFields(interval: ReasoningTimingEntry | undefined): { startedAt?: number; endedAt?: number } {
  if (!interval) return {};
  const startedAt = Date.parse(interval.started_at);
  const endedAt = Date.parse(interval.ended_at);
  return Number.isFinite(startedAt) && Number.isFinite(endedAt) ? { startedAt, endedAt } : {};
}

/** Journal responses precede the calls they propose. The bounded events stream
 * omits text-less responses; restore their reasoning when a visible turn gives
 * us a stable anchor, without fabricating rows for an incomplete page. */
export function projectJournalAssistantWork(
  rows: TimelineRow[], messages: unknown[], history: ReasoningHistoryEntry[], timing: ReasoningTimingEntry[] = [],
): TimelineRow[] {
  const tools = new Map(rows.filter((row): row is Extract<TimelineRow, { kind: 'tool' }> => row.kind === 'tool')
    .map(row => [row.toolCallId, row]));
  const assistants = new Map(rows.filter((row): row is Extract<TimelineRow, { kind: 'assistant' }> => row.kind === 'assistant' && row.messageIndex !== undefined)
    .map(row => [row.messageIndex, row]));
  const thoughts = new Map(history.filter(item => Number.isInteger(item?.message_index) && typeof item?.text === 'string')
    .map(item => [item.message_index, item.text.slice(0, 32_000)]));
  const intervals = new Map(timing.filter(item => Number.isInteger(item?.message_index)
    && typeof item?.started_at === 'string' && typeof item?.ended_at === 'string')
    .map(item => [item.message_index, item]));
  const before = new Map<number, TimelineRow>();
  const relocated = new Set<number>();
  const synthesized: TimelineRow[] = [];
  messages.forEach((value, messageIndex) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const message = value as Record<string, unknown>;
    if (message.role !== 'assistant') return;
    const transcriptPartial = message._transcript_partial === true;
    const reasoning = thoughts.get(messageIndex)
      ?? (transcriptPartial && typeof message._stream_reasoning === 'string' ? message._stream_reasoning : undefined);
    if (!Array.isArray(message.tool_calls) || message.tool_calls.length === 0) {
      if (transcriptPartial && !assistants.has(messageIndex)) {
        const turnId = typeof message._turn_id === 'string' ? message._turn_id : undefined;
        const anchor = turnId
          ? rows.findLast((row): row is Extract<TimelineRow, { kind: 'user' }> => row.kind === 'user' && row.turnId === turnId)
          : rows.findLast((row): row is Extract<TimelineRow, { kind: 'user' }> => row.kind === 'user');
        if (!anchor) return;
        const precedingTools = messages.slice(0, messageIndex).flatMap(prev => {
          if (!prev || typeof prev !== 'object' || Array.isArray(prev)) return [];
          const prevMsg = prev as Record<string, unknown>;
          if (!Array.isArray(prevMsg.tool_calls)) return [];
          return prevMsg.tool_calls.flatMap(call => {
            if (!call || typeof call !== 'object' || typeof call.id !== 'string') return [];
            const row = tools.get(call.id);
            return row && (!turnId || row.turnId === turnId) ? [row] : [];
          });
        });
        const lastTool = precedingTools.reduce<typeof precedingTools[number] | undefined>(
          (latest, row) => !latest || row.seq > latest.seq ? row : latest, undefined);
        const anchorSeq = lastTool ? lastTool.seq : anchor.seq;
        const text = typeof message.content === 'string' ? message.content : '';
        const startedAt = timingValue(message._stream_reasoning_started_at);
        const endedAt = timingValue(message._stream_reasoning_ended_at ?? message._stream_interrupted_at);
        synthesized.push({kind: 'assistant', seq: anchorSeq + 0.1 + (messageIndex * 0.001),
          turnId: turnId ?? anchor.turnId, text, ...(reasoning ? {reasoning} : {}),
          ...(typeof message._stream_id === 'string' ? {streamId: message._stream_id} : {}),
          interrupted: true, messageIndex,
          ...(typeof message._message_id === 'string' ? {messageId: message._message_id} : {}),
          ...(startedAt !== undefined ? {startedAt} : {}), ...(endedAt !== undefined ? {endedAt} : {})});
        return;
      }
      // events.v1 omits a text-less, tool-less assistant response. If the
      // visible page still contains its user row, retain the pure-thinking
      // history instead of silently dropping it; an empty/partial page must
      // remain untouched (no fabricated row without a turn anchor).
      if (!reasoning?.trim() || assistants.has(messageIndex)) return;
      const targetTurnId = typeof message._turn_id === 'string' ? message._turn_id
        : rows.findLast((row): row is Extract<TimelineRow, { kind: 'user' }> => row.kind === 'user')?.turnId;
      const anchor = targetTurnId
        ? rows.findLast((row): row is Extract<TimelineRow, { kind: 'user' }> => row.kind === 'user' && row.turnId === targetTurnId)
        : rows.findLast((row): row is Extract<TimelineRow, { kind: 'user' }> => row.kind === 'user');
      if (!anchor) return;
      const turnId = targetTurnId ?? anchor.turnId;
      const precedingTools = messages.slice(0, messageIndex).flatMap(prev => {
        if (!prev || typeof prev !== 'object' || Array.isArray(prev)) return [];
        const prevMsg = prev as Record<string, unknown>;
        if (!Array.isArray(prevMsg.tool_calls)) return [];
        return prevMsg.tool_calls.flatMap(call => {
          if (!call || typeof call !== 'object' || typeof call.id !== 'string') return [];
          const row = tools.get(call.id);
          return row && (!turnId || row.turnId === turnId) ? [row] : [];
        });
      });
      const lastTool = precedingTools.reduce<typeof precedingTools[number] | undefined>(
        (latest, row) => !latest || row.seq > latest.seq ? row : latest, undefined);
      const anchorSeq = lastTool ? lastTool.seq : anchor.seq;
      const seq = anchorSeq + 0.1 + (messageIndex * 0.001);
      const interval = intervals.get(messageIndex);
      synthesized.push({ kind: 'assistant', seq, turnId,
        text: '', reasoning, messageIndex,
        ...(typeof message._message_id === 'string' ? { messageId: message._message_id } : {}),
        ...timingFields(interval) });
      return;
    }
    const calls = message.tool_calls.flatMap(call => {
      if (!call || typeof call !== 'object' || typeof call.id !== 'string') return [];
      const row = tools.get(call.id);
      return row ? [row] : [];
    });
    const first = calls.reduce<typeof calls[number] | undefined>((earliest, row) => !earliest || row.seq < earliest.seq ? row : earliest, undefined);
    if (!first) return; // A partial event page must not invent earlier calls.
    const existing = assistants.get(messageIndex);
    if (existing) {
      // Keep narration/reasoning ahead of its tool call after seq-based sorting.
      before.set(first.seq, { ...existing, seq: first.seq - 0.25 });
      relocated.add(existing.seq);
    } else {
      if (!reasoning?.trim()) return;
      // Fractional display sequence cannot collide with integer event IDs.
      before.set(first.seq, { kind: 'assistant', seq: first.seq - 0.25,
        turnId: first.turnId, text: '', reasoning, messageIndex,
        ...(typeof message._message_id === 'string' ? { messageId: message._message_id } : {}),
        ...timingFields(intervals.get(messageIndex)) });
    }
  });
  if (!before.size && !synthesized.length) return rows;
  const relocatedRows = rows.flatMap(row => [
    ...(before.has(row.seq) ? [before.get(row.seq)!] : []),
    ...(relocated.has(row.seq) ? [] : [row]),
  ]);
  return [...relocatedRows, ...synthesized].sort((left, right) => left.seq - right.seq);
}

function timingValue(value: unknown): number | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
