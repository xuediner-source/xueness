import test from 'node:test';
import assert from 'node:assert/strict';
import { projectJournalAssistantWork } from './conversationJournalProjection';
import type { TimelineRow, ReasoningHistoryEntry, ReasoningTimingEntry } from '../../xuenessWorkbench';

test('projectJournalAssistantWork: synthesizes reasoning rows with monotonic fractional seq anchored after preceding tool calls', () => {
  const user: TimelineRow = { kind: 'user', seq: 0, turnId: 'turn-1', text: 'solve this' };
  const tool1: TimelineRow = {
    kind: 'tool', seq: 1, turnId: 'turn-1', toolCallId: 'call-1', name: 'read',
    subject: 'a.txt', status: 'ok', error: '', errorCode: '',
  };
  const tool2: TimelineRow = {
    kind: 'tool', seq: 2, turnId: 'turn-1', toolCallId: 'call-2', name: 'edit',
    subject: 'a.txt', status: 'ok', error: '', errorCode: '',
  };

  const messages = [
    { role: 'user', content: 'solve this', _turn_id: 'turn-1' },
    // messageIndex 1: first reasoning step, followed by tool call 1
    { role: 'assistant', content: '', tool_calls: [{ id: 'call-1' }], _turn_id: 'turn-1' },
    { role: 'tool', tool_call_id: 'call-1', content: 'read result', _turn_id: 'turn-1' },
    // messageIndex 3: second reasoning step (pure reasoning, no tool calls)
    { role: 'assistant', content: '', tool_calls: [], _turn_id: 'turn-1' },
    // messageIndex 4: third reasoning step, followed by tool call 2
    { role: 'assistant', content: '', tool_calls: [{ id: 'call-2' }], _turn_id: 'turn-1' },
    { role: 'tool', tool_call_id: 'call-2', content: 'edit result', _turn_id: 'turn-1' },
    // messageIndex 6: fourth reasoning step (pure reasoning, no tool calls)
    { role: 'assistant', content: '', tool_calls: [], _turn_id: 'turn-1' },
  ];

  const history: ReasoningHistoryEntry[] = [
    { message_index: 1, text: 'Thinking about call 1' },
    { message_index: 3, text: 'Thinking between call 1 and call 2' },
    { message_index: 4, text: 'Thinking about call 2' },
    { message_index: 6, text: 'Thinking after call 2' },
  ];

  const timing: ReasoningTimingEntry[] = [
    { message_index: 3, started_at: '2026-10-14T00:00:01Z', ended_at: '2026-10-14T00:00:04Z' },
    { message_index: 6, started_at: '2026-10-14T00:00:05Z', ended_at: '2026-10-14T00:00:08Z' },
  ];

  const projected = projectJournalAssistantWork([user, tool1, tool2], messages, history, timing);

  // Verification:
  // 1. Initial tool-associated reasoning (msg 1) placed before tool1: seq = 1 - 0.25 = 0.75
  const msg1Row = projected.find(r => r.kind === 'assistant' && r.messageIndex === 1);
  assert.ok(msg1Row && msg1Row.kind === 'assistant', 'messageIndex 1 should be projected as assistant');
  assert.equal(msg1Row.seq, 0.75);
  assert.equal(msg1Row.reasoning, 'Thinking about call 1');

  // 2. Synthesized pure reasoning (msg 3) anchored after call 1 (seq = 1):
  // anchorSeq = 1, seq = 1 + 0.1 + 3 * 0.001 = 1.103
  const msg3Row = projected.find(r => r.kind === 'assistant' && r.messageIndex === 3);
  assert.ok(msg3Row && msg3Row.kind === 'assistant', 'messageIndex 3 should be projected as assistant');
  assert.equal(msg3Row.seq, 1.103);
  assert.equal(msg3Row.reasoning, 'Thinking between call 1 and call 2');
  assert.equal(msg3Row.startedAt, Date.parse('2026-10-14T00:00:01Z'));
  assert.equal(msg3Row.endedAt, Date.parse('2026-10-14T00:00:04Z'));

  // 3. Tool-associated reasoning (msg 4) placed before tool2: seq = 2 - 0.25 = 1.75
  const msg4Row = projected.find(r => r.kind === 'assistant' && r.messageIndex === 4);
  assert.ok(msg4Row && msg4Row.kind === 'assistant', 'messageIndex 4 should be projected as assistant');
  assert.equal(msg4Row.seq, 1.75);

  // 4. Synthesized pure reasoning (msg 6) anchored after call 2 (seq = 2):
  // anchorSeq = 2, seq = 2 + 0.1 + 6 * 0.001 = 2.106
  const msg6Row = projected.find(r => r.kind === 'assistant' && r.messageIndex === 6);
  assert.ok(msg6Row && msg6Row.kind === 'assistant', 'messageIndex 6 should be projected as assistant');
  assert.equal(msg6Row.seq, 2.106);
  assert.equal(msg6Row.reasoning, 'Thinking after call 2');

  // Relative ordering must be strictly sorted by seq
  for (let i = 1; i < projected.length; i++) {
    assert.ok(projected[i - 1].seq <= projected[i].seq, `Row at ${i - 1} (${projected[i - 1].seq}) <= Row at ${i} (${projected[i].seq})`);
  }
});

test('projectJournalAssistantWork: multiple pure reasoning messages before any tool call remain monotonic', () => {
  const user: TimelineRow = { kind: 'user', seq: 0, turnId: 'turn-1', text: 'start' };
  const messages = [
    { role: 'user', content: 'start', _turn_id: 'turn-1' },
    { role: 'assistant', content: '', tool_calls: [], _turn_id: 'turn-1' },
    { role: 'assistant', content: '', tool_calls: [], _turn_id: 'turn-1' },
  ];
  const history: ReasoningHistoryEntry[] = [
    { message_index: 1, text: 'first step reasoning' },
    { message_index: 2, text: 'second step reasoning' },
  ];

  const projected = projectJournalAssistantWork([user], messages, history);
  const row1 = projected.find(r => r.kind === 'assistant' && r.messageIndex === 1);
  const row2 = projected.find(r => r.kind === 'assistant' && r.messageIndex === 2);
  assert.ok(row1 && row1.kind === 'assistant' && row2 && row2.kind === 'assistant');
  assert.equal(row1.seq, 0 + 0.1 + 1 * 0.001); // 0.101
  assert.equal(row2.seq, 0 + 0.1 + 2 * 0.001); // 0.102
  assert.ok(row1.seq < row2.seq);
});
