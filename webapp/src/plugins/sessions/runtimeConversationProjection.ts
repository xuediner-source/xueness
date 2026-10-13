import { mergeTimelineRowsByIdentity, requestMutation, type Result, type TimelineRow, type ToolDisplayStatus, type WorkbenchSession } from '../../xuenessWorkbench';
import type { RuntimeConversationSnapshot, RuntimeRow } from '../runtimes/RuntimeConversation';

const toolStatuses: Record<string, ToolDisplayStatus> = {
  success: 'ok', succeeded: 'ok', ok: 'ok', pendingApproval: 'queued', queued: 'queued',
  running: 'running', error: 'error', cancelled: 'cancelled', stopped: 'stopped',
};
function text(value: unknown): string { return typeof value === 'string' ? value : ''; }
function sourceIdentity(row: RuntimeRow, snapshot: RuntimeConversationSnapshot) {
  const index = row.sourceMessageIndex ?? row.messageIndex;
  const revision = row.sourceMessageRevision ?? row.messageRevision
    ?? (snapshot.meta.window as {messageRevision?: string} | undefined)?.messageRevision;
  return {
    ...(typeof row.messageId === 'string' ? { messageId: row.messageId }
      : typeof row.entityId === 'string' ? { messageId: row.entityId } : {}),
    ...(typeof index === 'number' && Number.isSafeInteger(index) && index >= 0 ? { messageIndex: index } : {}),
    ...(typeof revision === 'string' && revision ? { messageRevision: revision } : {}),
  };
}

/** The server owns row order, content, stream identity and approval status. */
export function runtimeConversationRows(snapshot: RuntimeConversationSnapshot): TimelineRow[] {
  const result: TimelineRow[] = [];
  const assistantIds = new Set(snapshot.rows.window.filter(row => row.kind === 'assistantText')
    .map(row => row.assistantResponseId ?? row.entityId));
  const thoughts = new Map(snapshot.rows.window.filter(row => row.kind === 'reasoning')
    .map(row => [row.assistantResponseId ?? row.entityId, text(row.text)]));
  for (const row of snapshot.rows.window) {
    if (row.visibility === 'hidden') continue;
    const base = { seq: typeof row.createdAtSeq === 'number' ? row.createdAtSeq : row.rowId, turnId: row.turnId };
    if (row.kind === 'userInput') {
      result.push({ kind: 'user', ...base, text: text(row.text), ...sourceIdentity(row, snapshot) });
    } else if (row.kind === 'assistantText') {
      result.push({ kind: 'assistant', ...base, text: text(row.text), ...sourceIdentity(row, snapshot),
        ...(thoughts.has(row.assistantResponseId ?? row.entityId)
          ? { reasoning: thoughts.get(row.assistantResponseId ?? row.entityId) } : {}),
        ...(row.feedback === 'like' || row.feedback === 'dislike' ? { feedback: row.feedback } : {}),
        streaming: row.state === 'streaming', interrupted: row.state === 'interrupted',
        ...(typeof row.startedAt === 'number' ? { startedAt: row.startedAt } : {}),
        ...(typeof row.endedAt === 'number' ? { endedAt: row.endedAt } : {}) });
    } else if (row.kind === 'toolCall') {
      const error = row.error && typeof row.error === 'object' ? row.error as Record<string, unknown> : {};
      result.push({ kind: 'tool', ...base, toolCallId: text(row.toolCallId), name: text(row.toolName),
        subject: text(row.subject) || text(row.inputText), status: toolStatuses[text(row.status)] ?? 'running',
        error: text(error.message), errorCode: text(row.errorCode) || text(error.code),
        ...(row.input && typeof row.input === 'object' && !Array.isArray(row.input) ? { input: row.input as Record<string, unknown> } : {}),
        ...(row.result !== undefined ? { output: row.result } : row.output !== undefined ? { output: row.output } : {}),
        ...(row.archivedForCompaction === true ? { archivedForCompaction: true } : {}) });
    } else if (row.kind === 'reasoning' && !assistantIds.has(row.assistantResponseId ?? row.entityId)) {
      result.push({ kind: 'assistant', ...base, text: '', reasoning: text(row.text), ...sourceIdentity(row, snapshot),
        streaming: row.state === 'streaming', interrupted: row.state === 'interrupted' });
    }
    const outcomes = Array.isArray(snapshot.meta.outcomes) ? snapshot.meta.outcomes : [];
    const attached = outcomes.filter(item => item && typeof item === 'object'
      && (item as Record<string, unknown>).afterRowId === row.rowId) as Record<string, unknown>[];
    for (const [index, outcome] of attached.entries()) {
      result.push({ kind: 'completion', turnId: row.turnId, seq: base.seq + (index + 1) / (attached.length + 1),
        verified: outcome.verified === true, summary: text(outcome.summary),
        ...(typeof outcome.status === 'string' ? { status: outcome.status as Extract<TimelineRow, {kind: 'completion'}>['status'] } : {}),
        ...(typeof outcome.toolExecutionStatus === 'string' ? { toolExecutionStatus: outcome.toolExecutionStatus as Extract<TimelineRow, {kind: 'completion'}>['toolExecutionStatus'] } : {}),
        ...(typeof outcome.deliveryStatus === 'string' ? { deliveryStatus: outcome.deliveryStatus as Extract<TimelineRow, {kind: 'completion'}>['deliveryStatus'] } : {}) });
    }
  }
  if (typeof snapshot.meta.pendingQuestion === 'string' && snapshot.meta.pendingQuestion) {
    result.push({ kind: 'pending_question', seq: (result.at(-1)?.seq ?? 0) + 1, question: snapshot.meta.pendingQuestion });
  }
  return result;
}

export type RuntimeConversationWindow = {start: number; end: number; total: number; hasOlder: boolean;
  messageRevision: string; historyRevision: number; prefixRevision: string};
export function runtimeConversationWindow(snapshot: RuntimeConversationSnapshot): RuntimeConversationWindow {
  const value = snapshot.meta.window as RuntimeConversationWindow | undefined;
  if (!value || !Number.isSafeInteger(value.start) || !Number.isSafeInteger(value.end) || !Number.isSafeInteger(value.total)
    || value.start < 0 || value.end < value.start || value.end > value.total || typeof value.hasOlder !== 'boolean'
    || typeof value.messageRevision !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value.messageRevision)) {
    throw new Error('Invalid runtime transcript window');
  }
  return value;
}

export function runtimeConversationHistory(snapshot: RuntimeConversationSnapshot, prefix: TimelineRow[]): TimelineRow[] {
  const revision = runtimeConversationWindow(snapshot).messageRevision;
  return mergeTimelineRowsByIdentity(prefix.map(row => row.kind === 'assistant' || row.kind === 'user'
    ? {...row, messageRevision: revision} : row), runtimeConversationRows(snapshot));
}

export async function loadOlderRuntimeConversationPage(sessionId: string, before: number, messageRevision: string,
  signal: AbortSignal): Promise<Result<{rows: TimelineRow[]; window: RuntimeConversationWindow}>> {
  try {
    const snapshot = await requestMutation<RuntimeConversationSnapshot>('POST', '/api/runtimes/v4',
      {kind: 'conversationPage', params: {sessionId, before, messageRevision}}, signal);
    if (snapshot.sessionId !== sessionId) throw new Error('Invalid runtime page session');
    const window = runtimeConversationWindow(snapshot);
    if (window.end !== before || window.messageRevision !== messageRevision) throw new Error('Runtime page revision mismatch');
    return {ok: true, value: {rows: runtimeConversationRows(snapshot), window}};
  } catch (error) { return {ok: false, error: error instanceof Error ? error.message : String(error)}; }
}

export function runtimeConversationSession(snapshot: RuntimeConversationSnapshot): WorkbenchSession {
  const session = snapshot.meta.session;
  if (session.id !== snapshot.sessionId || typeof session.status !== 'string' || !Array.isArray(session.pending)
    || !session.approved || typeof session.approved !== 'object') throw new Error('Invalid runtime session details');
  return session as WorkbenchSession;
}
