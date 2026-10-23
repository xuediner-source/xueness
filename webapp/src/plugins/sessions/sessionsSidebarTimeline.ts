import { t as tr } from '../../i18n';
import type { SessionSummary } from '../../xuenessWorkbench';

export type TimelineBucketKind = 'today' | 'yesterday' | 'week' | 'older' | 'unknown';
export type TimelineBucket = {
  id: string;
  kind: TimelineBucketKind;
  label: string;
  items: SessionSummary[];
  project: false;
};

const kinds: TimelineBucketKind[] = ['today', 'yesterday', 'week', 'older', 'unknown'];
const labels = { today: '今天', yesterday: '昨天', week: '最近 7 天', older: '更早', unknown: '未知时间' };
const timestamp = (session: SessionSummary): number => Date.parse(session.updatedAt ?? '');

/** Compare local calendar days, including days that are 23 or 25 hours long. */
function localDay(timestamp: number): number {
  const date = new Date(timestamp);
  const ordinal = new Date(0);
  ordinal.setUTCFullYear(date.getFullYear(), date.getMonth(), date.getDate());
  return ordinal.getTime() / 86_400_000;
}

/** Timeline uses existing activity timestamps, with no inferred remote state or
 * additional requests. Unknown dates remain visible after all dated rows. */
export function timelineBuckets(sessions: SessionSummary[], now = Date.now()): TimelineBucket[] {
  const today = localDay(now);
  const sorted = [...sessions].sort((left, right) => {
    const a = timestamp(left), b = timestamp(right);
    if (Number.isFinite(a) !== Number.isFinite(b)) return Number.isFinite(a) ? -1 : 1;
    if (Number.isFinite(a) && a !== b) return b - a;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
  const buckets = new Map<TimelineBucketKind, TimelineBucket>();
  for (const session of sorted) {
    const time = timestamp(session);
    const age = today - localDay(time);
    const kind: TimelineBucketKind = !Number.isFinite(time) ? 'unknown'
      : age <= 0 ? 'today' : age === 1 ? 'yesterday' : age <= 7 ? 'week' : 'older';
    const bucket = buckets.get(kind) ?? {
      id: `__timeline_${kind}__`, kind, label: tr(labels[kind]), items: [], project: false,
    };
    bucket.items.push(session);
    buckets.set(kind, bucket);
  }
  return kinds.flatMap(kind => buckets.has(kind) ? [buckets.get(kind)!] : []);
}
