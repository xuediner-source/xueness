/** Compact operation facts shared by model and deterministic compactors. */
import { isDict, uuid4Hex } from '@xueness/contracts';
import type { Session } from './store.ts';
export function compactTimelineRows(session: Session): Session[] { return Array.isArray(session.compact_timeline) ? session.compact_timeline.filter(isDict) : []; }
export function beginCompactTimeline(session: Session, operation: Session, id = uuid4Hex()): Session {
  const rows = compactTimelineRows(session), row: Session = { id, ...operation, status: 'started', attempt: 1, startedAt: new Date().toISOString() };
  rows.push(row); session.compact_timeline = rows.slice(-64); return row;
}
export function finishCompactTimeline(session: Session, id: unknown, values: Session): void {
  const row = compactTimelineRows(session).find(item => item.id === id);
  if (row) Object.assign(row, values);
}
export function recoverCompactTimelines(session: Session): number {
  const checkpoints = Array.isArray(session.context_checkpoints) ? session.context_checkpoints.filter(isDict) : [];
  let changed = 0;
  for (const row of compactTimelineRows(session)) {
    if (row.status !== 'started' && row.status !== 'retrying') continue;
    const checkpoint = checkpoints.find(item => item.operationId === row.id);
    Object.assign(row, { status: checkpoint ? 'completed' : 'interrupted', finishedAt: new Date().toISOString(), ...(checkpoint ? { checkpointId: checkpoint.id } : { reason: 'runtime_interrupted' }) }); changed++;
  }
  return changed;
}
