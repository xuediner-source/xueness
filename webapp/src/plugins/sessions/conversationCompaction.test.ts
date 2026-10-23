import test from 'node:test';
import assert from 'node:assert/strict';
import {
  conversationCompactionBoundary,
  conversationCompactionLabel,
  markArchivedToolRows,
  parseSessionCompactions,
} from './conversationCompaction';
import type { TimelineRow } from '../../xuenessWorkbench';

// 窗口化 journal 水合后的行：归档行没有 messageIndex，上下文内的行有。
const archivedRows: TimelineRow[] = [
  { kind: 'assistant', seq: 1, turnId: 'turn-1', text: '被压缩掉的回答' },
  { kind: 'tool', seq: 2, turnId: 'turn-1', toolCallId: 'call-a', name: 'exec', subject: 'pwd', status: 'ok', error: '', errorCode: '' },
  { kind: 'completion', seq: 3, turnId: 'turn-1', verified: true, summary: '被压缩掉的完成记录' },
];
const liveRows: TimelineRow[] = [
  { kind: 'user', seq: 4, turnId: 'turn-1', text: '原始任务', messageIndex: 2, messageRevision: `sha256:${'a'.repeat(64)}` },
  { kind: 'assistant', seq: 5, turnId: 'turn-1', text: '仍在上下文中的回答', messageIndex: 3 },
];

test('boundary sits before the first row that is still in the live context', () => {
  const marker = conversationCompactionBoundary([...archivedRows, ...liveRows],
    [{ removed: 2, masked: 1, previous_chars: 9000, estimatedTokens: 2250 }]);
  assert.deepEqual(marker, { boundarySeq: 4, removed: 2, masked: 1 });
});

test('the live task row ahead of the archived block does not hide the boundary', () => {
  // 真实压缩会话的行序：任务行（仍在上下文）→ 归档块 → 恢复的活行。
  const rows: TimelineRow[] = [
    { kind: 'user', seq: 0, turnId: 'turn-2', text: '原始任务', messageIndex: 2 },
    ...archivedRows,
    { kind: 'user', seq: 18, turnId: 'turn-3', text: 'follow-up 0', messageIndex: 3 },
  ];
  const marker = conversationCompactionBoundary(rows, [{ removed: 10, masked: 5 }]);
  assert.deepEqual(marker, { boundarySeq: 18, removed: 10, masked: 5 });
});

test('streaming appends stay in the live context and keep the boundary visible', () => {
  const rows: TimelineRow[] = [
    ...archivedRows,
    { kind: 'user', seq: 4, turnId: 'turn-1', text: '原始任务', messageIndex: 2 },
    { kind: 'assistant', seq: 5, turnId: 'turn-1', text: '正在流式输出', streaming: true },
  ];
  const marker = conversationCompactionBoundary(rows, [{ removed: 1 }]);
  assert.deepEqual(marker, { boundarySeq: 4, removed: 1, masked: 0 });
});

test('a masked archived tool result supplies the boundary when no text row was archived', () => {
  const rows: TimelineRow[] = [
    { kind: 'tool', seq: 1, turnId: 'turn-1', toolCallId: 'archived-call', name: 'exec', subject: 'pwd', status: 'ok', error: '', errorCode: '' },
    { kind: 'user', seq: 2, turnId: 'turn-1', text: '原始任务', messageIndex: 2 },
    { kind: 'assistant', seq: 3, turnId: 'turn-1', text: '仍在上下文中的回答', messageIndex: 3 },
  ];
  const journal = {
    messages: [
      { role: 'tool', tool_call_id: 'archived-call', content: '旧输出' },
      { role: 'assistant', tool_calls: [{ id: 'active-call' }] },
    ],
    message_window: { messageIndices: [null, 4] },
  };
  const marked = markArchivedToolRows(rows, journal);
  assert.equal(marked[0].kind === 'tool' && marked[0].archivedForCompaction, true);
  assert.deepEqual(conversationCompactionBoundary(marked, [{ removed: 0, masked: 1 }]),
    { boundarySeq: 2, removed: 0, masked: 1 });
  assert.equal(markArchivedToolRows(rows, { ...journal, message_window: { messageIndices: [3, 4] } }), rows,
    'active tool rows do not create an archive boundary');
});

test('projected fractional assistant rows keep their own seq below the boundary', () => {
  const rows: TimelineRow[] = [
    { kind: 'assistant', seq: 3.75, turnId: 'turn-1', text: '', reasoning: '归档的思考' },
    { kind: 'assistant', seq: 4, turnId: 'turn-1', text: ' live', messageIndex: 5 },
  ];
  const marker = conversationCompactionBoundary(rows, []);
  assert.equal(marker?.boundarySeq, 4);
});

test('no marker is rendered without an archived block or without live rows after it', () => {
  assert.equal(conversationCompactionBoundary([], []), null);
  // 全部文本行都在上下文内 → 无边界可画。
  assert.equal(conversationCompactionBoundary(liveRows, []), null);
  // 页面里只有归档行（更早分页尚未到达上下文开头）→ 不猜测边界。
  assert.equal(conversationCompactionBoundary(archivedRows, []), null);
  // 行缺失 messageIndex（journal 未窗口化）时无法定位 → 不渲染。
  const legacy: TimelineRow[] = [{ kind: 'user', seq: 0, turnId: 'turn-1', text: 'task' }];
  assert.equal(conversationCompactionBoundary(legacy, []), null);
  // 只有任务行和归档行、归档块之后没有活行 → 不渲染。
  const headAndArchive: TimelineRow[] = [liveRows[0], ...archivedRows];
  assert.equal(conversationCompactionBoundary(headAndArchive, []), null);
});

test('compaction records are summed defensively across malformed entries', () => {
  assert.deepEqual(parseSessionCompactions(undefined), []);
  assert.deepEqual(parseSessionCompactions('nope'), []);
  assert.deepEqual(parseSessionCompactions([null, 3, { removed: 'x' }]), []);
  const records = parseSessionCompactions([
    { removed: 2, masked: 1 },
    { removed: 3 },
    { advisory: true, removed: 0 },
    { removed: -1, masked: 1.5 },
    { masked: 4 },
  ]);
  const marker = conversationCompactionBoundary([...archivedRows, ...liveRows], records);
  assert.equal(marker?.removed, 5);
  assert.equal(marker?.masked, 5);
});

test('labels describe removal, masking or the bare fact in the current locale', () => {
  assert.equal(conversationCompactionLabel({ removed: 3, masked: 2 }), '已压缩 3 条较早消息，另有 2 条旧输出已掩码');
  assert.equal(conversationCompactionLabel({ removed: 3, masked: 0 }), '已压缩 3 条较早消息');
  assert.equal(conversationCompactionLabel({ removed: 0, masked: 2 }), '已掩码 2 条较早的工具输出');
  assert.equal(conversationCompactionLabel({ removed: 0, masked: 0 }), '较早历史已压缩出上下文');
});

// ZCode 压缩记录（ts/plugins/providers/src/zcode-compact.ts）：扁平标量，旧记录照常解析。
const zcodeRecord = {
  kind: 'zcode', trigger: 'auto', phase: 'preflight', reason: 'context_limit', checkpointId: 'c1', removed: 6, kept: 2,
  summarizedMessageCount: 6, preCompactTokens: 180000, postCompactTokens: 190000, truePostCompactTokens: 4200,
  willRetriggerNextTurn: false, at: '2026-10-19T00:00:00+00:00',
};

test('ZCode compaction records parse and carry the latest record onto the marker', () => {
  assert.equal(parseSessionCompactions([zcodeRecord]).length, 1);
  assert.equal(parseSessionCompactions([{ ...zcodeRecord, willRetriggerNextTurn: 'no' }]).length, 0);
  assert.equal(parseSessionCompactions([{ ...zcodeRecord, kept: '2' }]).length, 0);
  const marker = conversationCompactionBoundary([...archivedRows, ...liveRows], [{ removed: 2, masked: 1 }, zcodeRecord]);
  assert.deepEqual(marker, { boundarySeq: 4, removed: 8, masked: 1, latest: zcodeRecord });
});

test('ZCode compaction uses the ZCode divider text; earlier records keep theirs', () => {
  assert.equal(conversationCompactionLabel({ removed: 6, masked: 0, latest: zcodeRecord }), '上下文已压缩（6 条较早消息已摘要）');
  assert.equal(conversationCompactionLabel({ removed: 0, masked: 0, latest: { ...zcodeRecord, trigger: 'manual' } }), '上下文已压缩');
  assert.equal(conversationCompactionLabel({ removed: 6, masked: 0, latest: { removed: 6 } }), '已压缩 6 条较早消息');
  assert.equal(conversationCompactionLabel({ removed: 6, masked: 0 }), '已压缩 6 条较早消息');
});
