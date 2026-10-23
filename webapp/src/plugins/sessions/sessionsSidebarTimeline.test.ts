import test from 'node:test';
import assert from 'node:assert/strict';
import type { SessionSummary } from '../../xuenessWorkbench';
import { timelineBuckets } from './sessionsSidebarTimeline';

const session = (id: string, updatedAt?: string, patch: Partial<SessionSummary> = {}): SessionSummary => ({
  id, task: `Task ${id}`, status: 'completed', updatedAt, ...patch,
});
const localTime = (day: number, hour = 12, minute = 0): string => new Date(2026, 9, day, hour, minute).toISOString();

test('timeline uses local calendar days, includes day seven, and retains unknown times last', () => {
  const input = [
    session('older', localTime(6, 23, 59)),
    session('day-seven', localTime(7, 0)),
    session('day-two', localTime(12, 23, 59)),
    session('yesterday', localTime(13, 23, 59)),
    session('today', localTime(14, 0)),
    session('future', localTime(25)),
    session('invalid', 'not-a-date'),
    session('missing'),
    session('empty', ''),
  ];
  const buckets = timelineBuckets(input, new Date(2026, 9, 14, 0, 15).getTime());
  assert.deepEqual(buckets.map(bucket => ({ id: bucket.id, kind: bucket.kind, label: bucket.label, ids: bucket.items.map(item => item.id) })), [
    { id: '__timeline_today__', kind: 'today', label: '今天', ids: ['future', 'today'] },
    { id: '__timeline_yesterday__', kind: 'yesterday', label: '昨天', ids: ['yesterday'] },
    { id: '__timeline_week__', kind: 'week', label: '最近 7 天', ids: ['day-two', 'day-seven'] },
    { id: '__timeline_older__', kind: 'older', label: '更早', ids: ['older'] },
    { id: '__timeline_unknown__', kind: 'unknown', label: '未知时间', ids: ['empty', 'invalid', 'missing'] },
  ]);
});

test('timeline sorts ties by ASCII identity without mutating sessions or losing pinned input', () => {
  const input = [session('a', localTime(14)), session('Z', localTime(14), { pinned: true }), session('newer', localTime(14, 13))];
  const snapshot = structuredClone(input);
  const buckets = timelineBuckets(input, new Date(2026, 9, 14, 14).getTime());
  assert.deepEqual(buckets.map(bucket => bucket.items.map(item => item.id)), [['newer', 'Z', 'a']]);
  assert.deepEqual(input, snapshot);
  assert.equal(buckets[0].items[1], input[1]);
  assert.equal(buckets[0].items[1].pinned, true);
  assert.deepEqual(timelineBuckets([], new Date(2026, 9, 14).getTime()), []);
});

test('timeline calendar buckets remain correct through both daylight saving transitions', () => {
  const originalTimezone = process.env.TZ;
  process.env.TZ = 'America/New_York';
  try {
    const spring = timelineBuckets([
      session('yesterday', '2026-03-08T00:30:00-05:00'),
      session('day-two', '2026-03-07T23:50:00-05:00'),
      session('day-seven', '2026-03-02T00:00:00-05:00'),
      session('day-eight', '2026-03-01T23:59:00-05:00'),
    ], Date.parse('2026-03-09T00:15:00-04:00'));
    assert.deepEqual(spring.map(bucket => ({ kind: bucket.kind, ids: bucket.items.map(item => item.id) })), [
      { kind: 'yesterday', ids: ['yesterday'] },
      { kind: 'week', ids: ['day-two', 'day-seven'] },
      { kind: 'older', ids: ['day-eight'] },
    ]);
    const fall = timelineBuckets([
      session('yesterday', '2026-11-01T00:05:00-04:00'),
      session('day-two', '2026-10-31T23:50:00-04:00'),
      session('day-seven', '2026-10-26T00:00:00-04:00'),
      session('day-eight', '2026-10-25T23:59:00-04:00'),
    ], Date.parse('2026-11-02T00:15:00-05:00'));
    assert.deepEqual(fall.map(bucket => ({ kind: bucket.kind, ids: bucket.items.map(item => item.id) })), [
      { kind: 'yesterday', ids: ['yesterday'] },
      { kind: 'week', ids: ['day-two', 'day-seven'] },
      { kind: 'older', ids: ['day-eight'] },
    ]);
  } finally {
    if (originalTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimezone;
  }
});
