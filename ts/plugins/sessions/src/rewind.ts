/** Conversation-only rewind: cut the live transcript while retaining a compact branch record. */
import { isDict, isPyIntValue, pyDeepCopy, pyUtcNow, pySubstring } from '@xueness/contracts';
import { isPyOSError, pyExceptionName, type Session, type SessionStore } from '@xueness/sessions';
import { messageRevision } from './journal-http.ts';
import type { Row } from './fork-common.ts';

const SID = /^[0-9a-f]{32}$/;
const MESSAGE_ID = /^[0-9a-f]{32}$/;
const REVISION = /^sha256:[0-9a-f]{64}$/;
const OMIT_USER_KINDS = new Set(['guide', 'background_notice', 'summary', 'semantic_summary', 'compact_summary']);

export class RewindError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) { super(message); this.name = 'RewindError'; this.status = status; }
}
export interface ConversationRewindRequest { messageId: string; revision: string; confirmed: true }
export type RewindTarget = { messageId: string; messageIndex: number; turn: string | number | null; preview: string };

export function isRewindTarget(message: unknown): message is Row {
  if (!isDict(message) || message.role !== 'user' || typeof message._message_id !== 'string' || !MESSAGE_ID.test(message._message_id)) return false;
  if (Object.hasOwn(message, '_meta_source') || OMIT_USER_KINDS.has(String(message._input_kind)) || message._semantic_summary === true || message._compact_summary === true || message._summary === true || typeof message.content === 'string' && message.content.startsWith('Older history compacted;')) return false;
  return true;
}

export function conversationRewindTargets(session: Session): RewindTarget[] {
  const messages = Array.isArray(session.messages) ? session.messages : [];
  if (!isDict(messages[0]) || messages[0].role !== 'system') return [];
  const counts = new Map<string, number>();
  for (const message of messages) if (isDict(message) && typeof message._message_id === 'string') counts.set(message._message_id, (counts.get(message._message_id) ?? 0) + 1);
  return messages.flatMap((message, messageIndex) => {
    if (!isRewindTarget(message) || counts.get(message._message_id) !== 1) return [];
    const content = typeof message.content === 'string' ? message.content : '';
    const preview = Array.from(content, (c) => /\s/u.test(c) ? ' ' : c).join('').replace(/ +/g, ' ').trim();
    return [{ messageId: message._message_id, messageIndex, turn: message._turn_id ?? null, preview: pySubstring(preview, 0, 240) }];
  });
}

function checkedRequest(value: unknown): ConversationRewindRequest {
  if (!isDict(value) || Object.keys(value).some((key) => !['messageId', 'revision', 'confirmed'].includes(key))
    || !['messageId', 'revision', 'confirmed'].every((key) => Object.hasOwn(value, key))) throw new RewindError('expected messageId, revision, and confirmed:true');
  if (value.confirmed !== true) throw new RewindError('explicit confirmation is required', 428);
  if (typeof value.messageId !== 'string' || !MESSAGE_ID.test(value.messageId)) throw new RewindError('invalid rewind message id');
  if (typeof value.revision !== 'string' || !REVISION.test(value.revision)) throw new RewindError('invalid conversation revision');
  return value as unknown as ConversationRewindRequest;
}

function generation(session: Row): number {
  const history = Array.isArray(session.rewind_history) ? session.rewind_history : [];
  const last = history.findLast(isDict);
  return last && isPyIntValue(last.generation) && Number(last.generation) >= 0 ? Number(last.generation) : 0;
}

function pruneSuffix(session: Row, messages: Row[], removed: Set<string>): void {
  const turns = new Set(messages.flatMap((message) => typeof message._turn_id === 'string' ? [message._turn_id] : []));
  const calls = new Set(messages.flatMap((message) => message.role === 'assistant' && Array.isArray(message.tool_calls)
    ? message.tool_calls.flatMap((call: unknown) => isDict(call) && typeof call.id === 'string' ? [call.id] : []) : []));
  if (!isDict(session.results)) session.results = {};
  else session.results = Object.fromEntries(Object.entries(session.results).filter(([id]) => calls.has(id)));
  if (isDict(session.message_annotations)) session.message_annotations = Object.fromEntries(Object.entries(session.message_annotations).filter(([index]) => /^\d+$/u.test(index) && Number(index) < messages.length));
  for (const key of ['reasoning_history', 'reasoning_timing'] as const) if (Array.isArray(session[key])) {
    session[key] = (session[key] as unknown[]).filter((row) => isDict(row) && isPyIntValue(row.message_index) && Number(row.message_index) < messages.length && !(typeof row.message_id === 'string' && removed.has(row.message_id)));
  }
  for (const key of ['completion_history', 'runtime_turn_history', 'runtime_activity_history', 'stream_history', 'tool_timings'] as const) if (Array.isArray(session[key])) {
    session[key] = (session[key] as unknown[]).filter((row) => {
      if (!isDict(row)) return false;
      if (typeof row.message_id === 'string' && removed.has(row.message_id)) return false;
      if (typeof row.after_message_id === 'string' && removed.has(row.after_message_id)) return false;
      if (typeof row.turn_id === 'string' && !turns.has(row.turn_id)) return false;
      if (typeof row.transcript_turn_id === 'string' && !turns.has(row.transcript_turn_id)) return false;
      if (typeof row.call_id === 'string' && !calls.has(row.call_id)) return false;
      return true;
    });
  }
  if (Array.isArray(session.interrupted_transcripts)) session.interrupted_transcripts = session.interrupted_transcripts.filter((row) => isDict(row)
    && !(typeof row.after_message_id === 'string' && removed.has(row.after_message_id))
    && (typeof row.transcript_turn_id !== 'string' || turns.has(row.transcript_turn_id)));
  if (Array.isArray(session.message_edit_history)) session.message_edit_history = session.message_edit_history.filter((row) => isDict(row) && !(typeof row.message_id === 'string' && removed.has(row.message_id)));
  const retainedUsers = messages.filter((message) => message.role === 'user' && message._input_kind !== 'guide' && message._input_kind !== 'background_notice').length;
  for (const key of ['input_context', 'input_attachments'] as const) if (Array.isArray(session[key])) session[key] = (session[key] as unknown[]).filter((row) => isDict(row) && isPyIntValue(row.user_turn) && Number(row.user_turn) <= retainedUsers);
  delete session.active_turn_id; delete session.current_queue_item_id; delete session.active_run_command_id;
  delete session.completion; delete session.pending_question; delete session.streaming; delete session.runtime_turn;
  delete session.runtime_activity; delete session.tool_activity; delete session.pause_code; delete session.pause_reason; delete session.runtime_budget;
  session.todos = [];
}

function taskIdsInTail(tail: Row[], results: Row): Set<string> {
  const ids = new Set<string>();
  for (const message of tail) {
    if (typeof message._background_task_notice === 'string') ids.add(message._background_task_notice.split(':', 1)[0]!);
    if (message.role !== 'assistant' || !Array.isArray(message.tool_calls)) continue;
    for (const call of message.tool_calls) if (isDict(call) && isDict(call.function) && call.function.name === 'exec' && typeof call.id === 'string') {
      const result = results[call.id], data = isDict(result) && isDict(result.data) ? result.data : null;
      if (data && typeof data.id === 'string') ids.add(data.id);
    }
  }
  return ids;
}

function markRemovedTaskFacts(session: Row, ids: Set<string>): void {
  if (!Array.isArray(session.background_tasks) || !ids.size) return;
  session.background_tasks = session.background_tasks.map((fact: unknown) => isDict(fact) && typeof fact.id === 'string' && ids.has(fact.id)
    ? { ...fact, branch_removed: true } : fact);
}

/** Applies a confirmed rewind under the session lease; workspace/files are untouched. */
export async function applyConversationRewind(
  store: SessionStore,
  sid: string,
  input: unknown,
  beforeApply?: (session: Session) => void | Promise<void>,
  afterApply?: (session: Session, result: Row) => void | Promise<void>,
): Promise<Row> {
  if (!SID.test(sid)) throw new RewindError('session not found', 404);
  const request = checkedRequest(input);
  let lease: Awaited<ReturnType<SessionStore['lease']>>;
  try { lease = await store.lease(sid); }
  catch (error) { if (pyExceptionName(error) === 'BlockingIOError') throw new RewindError('session is in use by another process', 409); throw error; }
  try {
    let session: Session;
    try { session = await store.load(sid); }
    catch (error) { if (isPyOSError(error)) throw new RewindError('session not found', 404); throw error; }
    await beforeApply?.(session);
    if (messageRevision(session) !== request.revision) throw new RewindError('conversation changed; refresh rewind targets', 409);
    const messages = Array.isArray(session.messages) ? session.messages : [];
    const target = conversationRewindTargets(session).find((row) => row.messageId === request.messageId);
    if (!target) throw new RewindError('rewind target is no longer available', 409);
    const prefix = messages.slice(0, target.messageIndex) as Row[];
    if (!isDict(prefix[0]) || prefix[0].role !== 'system') throw new RewindError('session transcript has no system prompt', 409);
    const tail = messages.slice(target.messageIndex).filter(isDict) as Row[];
    const removedMessageIds = [...new Set(tail.flatMap((message) => typeof message._message_id === 'string' && MESSAGE_ID.test(message._message_id) ? [message._message_id] : []))];
    const oldResults = isDict(session.results) ? pyDeepCopy(session.results) as Row : {};
    const branchTasks = taskIdsInTail(tail, oldResults);
    const cut = { generation: generation(session) + 1, targetMessageId: request.messageId, removedMessageIds, time: pyUtcNow(), previousRevision: request.revision };
    session.messages = prefix;
    pruneSuffix(session as Row, prefix, new Set(removedMessageIds));
    markRemovedTaskFacts(session as Row, branchTasks);
    const history = Array.isArray(session.rewind_history) ? session.rewind_history as Row[] : [];
    session.rewind_history = [...history, cut].slice(-24);
    session.steps = prefix.filter((message) => isDict(message) && message.role === 'assistant').length;
    session.status = 'paused';
    await store.save(session);
    const result: Row = { id: sid, status: 'paused', generation: cut.generation, targetMessageId: request.messageId,
      removedMessageIds, revision: messageRevision(session), steps: session.steps };
    await afterApply?.(session, result);
    return result;
  } finally { await lease.release(); }
}
