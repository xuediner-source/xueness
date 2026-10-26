import assert from 'node:assert/strict';
import { test } from 'node:test';
import { beginCompactTimeline, compactTimelineRows, finishCompactTimeline, recoverCompactTimelines } from '@xueness/sessions';
import type { Row } from '@xueness/agent';
import { projectCompactSummaries } from '../src/zcode-compact-view.ts';
test('compact recovery requires a matching durable operation boundary, not a recent unrelated summary', () => {
  const session: Row = {};
  beginCompactTimeline(session, { trigger: 'manual', phase: 'manual' }, 'lost');
  beginCompactTimeline(session, { trigger: 'auto', phase: 'preflight' }, 'committed');
  finishCompactTimeline(session, 'committed', { status: 'retrying', attempt: 2 });
  session.context_checkpoints = [{ id: 'unrelated', operationId: 'other' }, { id: 'proof', operationId: 'committed' }];
  assert.equal(recoverCompactTimelines(session), 2);
  assert.equal(compactTimelineRows(session)[0]!.status, 'interrupted');
  assert.equal(compactTimelineRows(session)[1]!.status, 'completed');
  assert.equal(compactTimelineRows(session)[1]!.checkpointId, 'proof'); assert.equal(recoverCompactTimelines(session), 0);
});

test('post-compact tool_discovery reminders pass through as their own wrapped source (C-TOOL-05)', () => {
  const messages: Row[] = [
    { role: 'user', content: 'hi' },
    { role: 'system', _compact_summary: true, content: 'summary text', _post_compact_reminders: [{ source: 'tool_discovery', content: 'Tools found earlier with tool_search stay callable.' }] },
  ];
  const view = projectCompactSummaries(messages);
  assert.equal(view.length, 3);
  assert.equal(view[1]!.role, 'user', 'the summary row projects as a user row');
  const reminderRow = view[2]!;
  assert.equal(reminderRow.role, 'user');
  assert.equal(reminderRow._meta_source, 'tool_discovery');
  assert.ok(String(reminderRow.content).startsWith('<system-reminder>'));
  assert.ok(String(reminderRow.content).includes('Tools found earlier'));
});
