import assert from 'node:assert/strict';
import { test } from 'node:test';
import { beginCompactTimeline, compactTimelineRows, finishCompactTimeline, recoverCompactTimelines } from '@xueness/sessions';
import type { Row } from '@xueness/agent';
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
