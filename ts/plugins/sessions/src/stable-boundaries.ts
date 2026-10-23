/** Stable identities for complete transcript prefixes across journal revisions. */
import { createHash } from 'node:crypto';
import type { AgentExtension } from '@xueness/agent';
import { isDict, isPyIntValue, pyDeepCopy } from '@xueness/contracts';
import type { Session } from '@xueness/sessions';
import { forkBoundaries } from './fork-boundaries.ts';
import { messageRevision } from './journal-http.ts';
import type { Row } from './fork-common.ts';

export interface StableForkAnchor { turn: number; endMessageId: string; orderedMessageIds: string[]; generation: number }
const KEY = 'stable_fork_boundaries';
const ID = /^[0-9a-f]{32}$/;

function rows(session: Row): Row[] {
  const messages = Array.isArray(session.messages) ? session.messages : [];
  return messages.length && messages.every(isDict) ? messages as Row[] : [];
}
function stored(session: Row): StableForkAnchor[] {
  if (!Array.isArray(session[KEY])) return [];
  return (session[KEY] as unknown[]).filter((value): value is StableForkAnchor => isDict(value)
    && isPyIntValue(value.turn) && Number(value.turn) > 0 && typeof value.endMessageId === 'string' && ID.test(value.endMessageId)
    && isPyIntValue(value.generation) && Number(value.generation) >= 0 && Array.isArray(value.orderedMessageIds)
    && value.orderedMessageIds.length > 0 && value.orderedMessageIds.every((id) => typeof id === 'string' && ID.test(id))
    && value.orderedMessageIds.at(-1) === value.endMessageId) as StableForkAnchor[];
}

/** Keep only anchors whose complete ordered message prefix still exists verbatim. */
export function continuousStableAnchors(session: Row): StableForkAnchor[] {
  const messages = rows(session);
  if (!messages.length || messages[0]?.role !== 'system') return [];
  return stored(session).filter((anchor) => anchor.orderedMessageIds.every((id, i) => messages[i + 1]?._message_id === id));
}

export function stableAnchorId(anchor: StableForkAnchor): string {
  const key = JSON.stringify([anchor.generation, anchor.turn, anchor.endMessageId, anchor.orderedMessageIds]);
  return 'sa1-' + createHash('sha256').update(key).digest('hex');
}

/** The latest still-continuous persisted anchor matching this offered boundary. */
export function anchorForBoundary(session: Row, boundary: Row): StableForkAnchor | null {
  const end = rows(session)[Number(boundary.endIndex)];
  if (!isDict(end) || typeof end._message_id !== 'string') return null;
  return continuousStableAnchors(session).filter((anchor) => anchor.turn === boundary.turn && anchor.endMessageId === end._message_id)
    .sort((a, b) => b.generation - a.generation)[0] ?? null;
}

function generation(session: Row): number {
  const history = Array.isArray(session.rewind_history) ? session.rewind_history : [];
  const last = history.findLast(isDict);
  return last && isPyIntValue(last.generation) && Number(last.generation) >= 0 ? Number(last.generation) : 0;
}

/** Recompute from closed fork boundaries only; never creates an anchor for a summary. */
export function recordStableForkBoundaries(session: Session): boolean {
  const s = session as Row, messages = rows(s);
  if (!messages.length || messages[0]?.role !== 'system') return false;
  let boundaries: Row[];
  try { boundaries = forkBoundaries(s, messageRevision(session)).boundaries as Row[]; }
  catch { return false; }
  const current = continuousStableAnchors(s), next: StableForkAnchor[] = [], seen = new Set<string>(), gen = generation(s);
  for (const boundary of boundaries) {
    const endIndex = Number(boundary.endIndex), end = messages[endIndex], prefix = messages.slice(1, endIndex + 1);
    if (!isDict(end) || typeof end._message_id !== 'string' || !ID.test(end._message_id) || !prefix.length) continue;
    const orderedMessageIds = prefix.map((m) => m._message_id);
    if (orderedMessageIds.some((id) => typeof id !== 'string' || !ID.test(id)) || new Set(orderedMessageIds).size !== orderedMessageIds.length) continue;
    const anchor: StableForkAnchor = { turn: Number(boundary.turn), endMessageId: end._message_id, orderedMessageIds, generation: gen };
    const id = stableAnchorId(anchor); if (!seen.has(id)) { next.push(anchor); seen.add(id); }
  }
  // A rewind may leave older anchors whose prefixes remain continuous. Prefer
  // the new generation for the same endpoint while retaining other valid ones.
  const endpoints = new Set(next.map((a) => `${a.turn}:${a.endMessageId}`));
  for (const anchor of current) {
    if (endpoints.has(`${anchor.turn}:${anchor.endMessageId}`)) continue;
    const id = stableAnchorId(anchor); if (!seen.has(id)) { next.push(pyDeepCopy(anchor)); seen.add(id); }
  }
  const bounded = next.slice(-64), previous = stored(s);
  if (JSON.stringify(previous) === JSON.stringify(bounded)) return false;
  s[KEY] = bounded;
  return true;
}

/** Host registration hook: record complete safe prefixes after a run settles. */
export function sessionsStableBoundariesExtension(): AgentExtension {
  const persist = async (context: Parameters<NonNullable<AgentExtension['settleRun']>>[0]): Promise<void> => {
    if (recordStableForkBoundaries(context.session)) await context.save();
  };
  return { id: 'sessions', capabilities: ['sessions.stable_boundaries'], settleRun: persist, afterRun: persist };
}
