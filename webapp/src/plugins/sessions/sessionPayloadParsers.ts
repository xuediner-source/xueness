/**
 * Strict readers for session payloads. A malformed field throws, and the data
 * layer reports it as `{ok:false, error}` instead of rendering invented state.
 */
import { parseEventsEnvelope } from '../../xuenessEvents';
import type { PendingGuidance } from './CurrentTurnInput';
import type { ConversationSnapshot, ConversationSnapshotWindow, QueuedMessage, WorkbenchSession } from './workbenchTypes';

const QUEUED_MESSAGE_STATUSES = ["queued", "running", "paused", "completed", "needs_review", "failed", "cancelled"] as const;

export function parseQueuedMessages(value: unknown): QueuedMessage[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("invalid queued messages response");
  return value.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("invalid queued messages response");
    const record = item as Record<string, unknown>;
    if (typeof record.id !== "string" || !record.id || typeof record.text !== "string"
      || typeof record.status !== "string" || !QUEUED_MESSAGE_STATUSES.includes(record.status as typeof QUEUED_MESSAGE_STATUSES[number])
      || (record.position !== undefined && (!Number.isInteger(record.position) || (record.position as number) < 0))
      || (record.created_at !== undefined && typeof record.created_at !== "string")
      || (record.updated_at !== undefined && typeof record.updated_at !== "string")
      || (record.pause_reason !== undefined && typeof record.pause_reason !== "string")
      || (record.editable !== undefined && typeof record.editable !== "boolean")
      || (record.has_attachments !== undefined && typeof record.has_attachments !== 'boolean')
      || (record.has_context !== undefined && typeof record.has_context !== 'boolean')
      || (record.promotion !== undefined && (!record.promotion || typeof record.promotion !== 'object'
        || Array.isArray(record.promotion)
        || (record.promotion as Record<string, unknown>).id !== undefined && typeof (record.promotion as Record<string, unknown>).id !== 'string'
        || !['reserved', 'claimed', 'released', 'settled'].includes(String((record.promotion as Record<string, unknown>).state))))) {
      throw new Error("invalid queued messages response");
    }
    return {
      id: record.id,
      text: record.text,
      status: record.status as QueuedMessage["status"],
      ...(typeof record.position === "number" ? { position: record.position } : {}),
      ...(typeof record.created_at === "string" ? { created_at: record.created_at } : {}),
      ...(typeof record.updated_at === "string" ? { updated_at: record.updated_at } : {}),
      ...(typeof record.pause_reason === "string" ? { pause_reason: record.pause_reason } : {}),
      ...(typeof record.editable === "boolean" ? { editable: record.editable } : {}),
      ...(typeof record.has_attachments === 'boolean' ? { has_attachments: record.has_attachments } : {}),
      ...(typeof record.has_context === 'boolean' ? { has_context: record.has_context } : {}),
      ...(record.promotion && typeof record.promotion === 'object' && !Array.isArray(record.promotion)
        ? { promotion: { ...((record.promotion as Record<string, unknown>).id ? { id: (record.promotion as Record<string, unknown>).id as string } : {}),
          state: (record.promotion as Record<string, unknown>).state as NonNullable<QueuedMessage['promotion']>['state'] } } : {}),
    };
  });
}

function parsePendingGuidance(value: unknown): PendingGuidance[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error('invalid current-turn guidance response');
  return value.map(candidate => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error('invalid current-turn guidance response');
    }
    const item = candidate as Record<string, unknown>;
    const statuses = ['queued', 'running', 'paused', 'completed', 'needs_review', 'failed', 'cancelled'];
    if (typeof item.id !== 'string' || !item.id || typeof item.text !== 'string'
      || typeof item.status !== 'string' || !statuses.includes(item.status)
      || (item.targetTurnId !== undefined && typeof item.targetTurnId !== 'string')
      || (item.pause_reason !== undefined && typeof item.pause_reason !== 'string')
      || (item.has_attachments !== undefined && typeof item.has_attachments !== 'boolean')
      || (item.has_context !== undefined && typeof item.has_context !== 'boolean')
      || (item.position !== undefined && (!Number.isInteger(item.position) || (item.position as number) < 0))) {
      throw new Error('invalid current-turn guidance response');
    }
    return { id: item.id, text: item.text, status: item.status as PendingGuidance['status'],
      ...(typeof item.targetTurnId === 'string' ? { targetTurnId: item.targetTurnId } : {}),
      ...(typeof item.pause_reason === 'string' ? { pause_reason: item.pause_reason } : {}),
      ...(item.has_attachments === true ? { has_attachments: true } : {}),
      ...(item.has_context === true ? { has_context: true } : {}),
      ...(Number.isInteger(item.position) ? { position: item.position as number } : {}) };
  });
}

export function parseSessionInboxFields(value: Record<string, unknown>): Partial<WorkbenchSession> {
  if (value.active_run_command_id !== undefined && value.active_run_command_id !== null
    && (typeof value.active_run_command_id !== 'string' || !value.active_run_command_id
      || value.active_run_command_id.length > 128)) throw new Error('invalid active run command identity');
  if (Object.prototype.hasOwnProperty.call(value, "queue_revision")
    && (!Number.isSafeInteger(value.queue_revision) || (value.queue_revision as number) < 0)) {
    throw new Error("invalid queue revision");
  }
  const historyRevision = value.history_revision;
  if (historyRevision !== undefined && (!Number.isInteger(historyRevision) || (historyRevision as number) < 0)) {
    throw new Error('invalid session history revision');
  }
  if (value.active_turn_id !== undefined && value.active_turn_id !== null
    && (typeof value.active_turn_id !== 'string' || !value.active_turn_id)) {
    throw new Error('invalid active turn id');
  }
  const pendingGuidance = parsePendingGuidance(value.pending_guidance);
  const guidanceHistory = parsePendingGuidance(value.guidance_history);
  return { ...(typeof value.active_turn_id === 'string' || value.active_turn_id === null
      ? { active_turn_id: value.active_turn_id } : {}),
    ...(typeof value.active_run_command_id === 'string' || value.active_run_command_id === null
      ? {active_run_command_id:value.active_run_command_id} : {}),
    ...(typeof historyRevision === 'number' ? { history_revision: historyRevision } : {}),
    ...(pendingGuidance ? { pending_guidance: pendingGuidance } : {}),
    ...(guidanceHistory ? { guidance_history: guidanceHistory } : {}) };
}

export function parseConversationSnapshot(id: string, payload: unknown): ConversationSnapshot {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('invalid conversation snapshot');
    const record = payload as Record<string, unknown>;
    const session = record.session as WorkbenchSession | null;
    const journal = record.journal as Record<string, unknown> | null;
    const timeline = parseEventsEnvelope(record.timeline);
    let window: ConversationSnapshotWindow | undefined;
    if (record.window !== undefined) {
      if (!record.window || typeof record.window !== 'object' || Array.isArray(record.window)) throw new Error('invalid conversation window');
      const raw = record.window as Record<string, unknown>;
      const messageWindow = journal?.message_window;
      if (!messageWindow || typeof messageWindow !== 'object' || Array.isArray(messageWindow)) throw new Error('invalid conversation window');
      const page = messageWindow as Record<string, unknown>;
      if (!Number.isSafeInteger(raw.start) || !Number.isSafeInteger(raw.end) || !Number.isSafeInteger(raw.total)
        || (raw.start as number) < 0 || (raw.end as number) < (raw.start as number) || (raw.total as number) < (raw.end as number)
        || typeof raw.hasOlder !== 'boolean' || raw.hasOlder !== ((raw.start as number) > 0)
        || (raw.olderCursor !== null && raw.olderCursor !== raw.start)
        || typeof raw.messageRevision !== 'string' || raw.messageRevision !== journal?.message_revision
        || !Number.isSafeInteger(raw.historyRevision) || (raw.historyRevision as number) < 0
        || raw.historyRevision !== journal?.history_revision
        || page.start !== raw.start || page.end !== raw.end || page.total !== raw.total
        || page.hasOlder !== raw.hasOlder || page.olderCursor !== raw.olderCursor
        || page.messageRevision !== raw.messageRevision || !Array.isArray(page.messageIndices)
        || page.messageIndices.length !== (journal?.messages as unknown[] | undefined)?.length
        || (raw.end as number) - (raw.start as number) !== page.messageIndices.length
        || page.messageIndices.some(value => value !== null && (!Number.isSafeInteger(value) || (value as number) < 0))) {
        throw new Error('invalid conversation window');
      }
      window = {start: raw.start as number, end: raw.end as number, total: raw.total as number,
        hasOlder: raw.hasOlder, olderCursor: raw.olderCursor as number | null,
        messageRevision: raw.messageRevision, historyRevision: raw.historyRevision as number};
    }
    if (!session || typeof session !== 'object' || Array.isArray(session) || session.id !== id || typeof session.status !== 'string'
      || !journal || typeof journal !== 'object' || Array.isArray(journal) || journal.id !== id || !Array.isArray(journal.messages)
      || typeof journal.message_revision !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(journal.message_revision)
      || !timeline || timeline.sessionId !== id || timeline.status !== session.status || journal.status !== session.status
      || timeline.hasMore || timeline.cursor !== 0 || timeline.events.length !== timeline.head || timeline.nextCursor !== timeline.head
      || timeline.events.some((event, index) => event.sessionId !== id || event.seq !== index + 1)) throw new Error('invalid conversation snapshot');
    const queued_messages = parseQueuedMessages(session.queued_messages);
    const inboxFields = parseSessionInboxFields(session as unknown as Record<string, unknown>);
    return {session: {...session, ...inboxFields, ...(queued_messages ? {queued_messages} : {}),
      message_revision: journal.message_revision}, journal,
      timeline: {events: timeline.events, cursor: 0, nextCursor: timeline.nextCursor, head: timeline.head, hasMore: false},
      ...(window ? {window} : {})};
}
