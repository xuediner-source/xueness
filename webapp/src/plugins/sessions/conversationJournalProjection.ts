import type { TimelineRow, ReasoningHistoryEntry } from '../../xuenessWorkbench';

/** Journal responses precede the calls they propose. The bounded events stream
 * omits text-less responses; restore only reasoning backed by a real call ID. */
export function projectJournalAssistantWork(
  rows: TimelineRow[], messages: unknown[], history: ReasoningHistoryEntry[],
): TimelineRow[] {
  const tools = new Map(rows.filter((row): row is Extract<TimelineRow, { kind: 'tool' }> => row.kind === 'tool')
    .map(row => [row.toolCallId, row]));
  const assistants = new Map(rows.filter((row): row is Extract<TimelineRow, { kind: 'assistant' }> => row.kind === 'assistant' && row.messageIndex !== undefined)
    .map(row => [row.messageIndex, row]));
  const thoughts = new Map(history.filter(item => Number.isInteger(item?.message_index) && typeof item?.text === 'string')
    .map(item => [item.message_index, item.text.slice(0, 32_000)]));
  const before = new Map<number, TimelineRow>();
  const relocated = new Set<number>();
  messages.forEach((value, messageIndex) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const message = value as Record<string, unknown>;
    if (message.role !== 'assistant' || !Array.isArray(message.tool_calls)) return;
    const calls = message.tool_calls.flatMap(call => {
      if (!call || typeof call !== 'object' || typeof call.id !== 'string') return [];
      const row = tools.get(call.id);
      return row ? [row] : [];
    });
    const first = calls.reduce<typeof calls[number] | undefined>((earliest, row) => !earliest || row.seq < earliest.seq ? row : earliest, undefined);
    if (!first) return; // A partial event page must not invent earlier calls.
    const existing = assistants.get(messageIndex);
    if (existing) {
      before.set(first.seq, existing);
      relocated.add(existing.seq);
    } else {
      const reasoning = thoughts.get(messageIndex);
      if (!reasoning?.trim()) return;
      // Fractional display sequence cannot collide with integer event IDs.
      before.set(first.seq, { kind: 'assistant', seq: first.seq - 0.25,
        turnId: first.turnId, text: '', reasoning, messageIndex });
    }
  });
  if (!before.size) return rows;
  return rows.flatMap(row => [
    ...(before.has(row.seq) ? [before.get(row.seq)!] : []),
    ...(relocated.has(row.seq) ? [] : [row]),
  ]);
}
