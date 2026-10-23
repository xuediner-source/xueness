import { findRemoteRestore, claimRemoteRestore, unclaimRemoteRestore, beginRemoteRestore, disposeRemoteRestore, ownRemoteRestoreRefs, releasedRemoteRestoreRef, remoteRestoreParams, validateRemoteRestoreReceipt } from './remoteRestoreLedger';
import { deferComposerAttachmentAbort, deferComposerAttachmentRelease } from '../sessions/composerAttachmentCleanup';
import { isComposerAttachmentLifecycleEnabled } from '../sessions/composerAttachmentLifecycle';
import { parseAttachmentRef } from '../sessions/composerAttachmentRef';
import type { UploadTransport } from '../sessions/composerAttachmentUpload';
import { bindRemoteRestoredMedia, createRemoteMediaTransport, createRemoteHistoryMediaTransport } from './remoteMediaTransport';
import { RemoteSessionAdapter } from './remoteSessionAdapter';
import type { QuestionTransport } from '../sessions/PendingQuestion';
import { parseQuestionResponse, type AnswerResponse } from '../sessions/questionApi';
import type { QueueWithdrawalTransport } from '../sessions/useQueueWithdrawals';
import type { QueueWithdrawalMetadata, QueueWithdrawal } from '../sessions/queueApi';
import type { guideCurrentTurn, withdrawGuidance, reserveQueuedMessageNow, readGuidance } from '../sessions/steeringApi';

const uncertain = new Set<string>();
const answerIntents = new Map<string, { intent: string; payload: Record<string, unknown> }>();
type GuidanceOperation = { operation: 'send' | 'promote' | 'cancel'; requestId: string;
  envelope: Record<string, unknown>; validate: (r: Record<string, unknown>) => boolean };
const guidanceOperations = new Map<string, GuidanceOperation>();
export type RemoteGuidanceReconciliation = { result: 'accepted' | 'released' | 'unknown' | 'none';
  operation?: 'send' | 'promote' | 'cancel'; requestId?: string; receipt?: Record<string, unknown> };
function answerIntent(payload: Record<string, unknown>): string {
  if (typeof payload.answer === 'string') return JSON.stringify({answer: payload.answer.trim()});
  const answers = row(payload.answers);
  return JSON.stringify({answers: Object.fromEntries(Object.keys(answers).sort().map(key => {
    const item = row(answers[key]);
    return [key, {selected: Array.isArray(item.selected) ? item.selected.map(String).map(v => v.trim()).sort() : [], text: typeof item.text === 'string' ? item.text.trim() : ''}];
  }))});
}
const row = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid remote workflow response');
  return value as Record<string, unknown>;
};
const unknown = () => Object.assign(new Error('Remote outcome is unknown; check the original operation result before continuing'), { outcomeUnknown: true });
const definite = (error: unknown) => error instanceof Error && (('requestNotSent' in error && error.requestNotSent === true)
  || ('status' in error && Number(error.status) >= 400 && Number(error.status) < 500 && Number(error.status) !== 408));
export function createRemoteWorkflowTransport(adapter: RemoteSessionAdapter, isCurrent: () => boolean = adapter.isCurrent) {
  const scope = JSON.stringify([adapter.owner.connectionId, adapter.owner.digest, adapter.owner.workspaceIdentity]);
  const key = (sid: string, kind: string) => JSON.stringify([scope, sid, kind]);
  const request = (method: string, sid: string, params: Record<string, unknown> = {}, signal?: AbortSignal, enabled: () => boolean = isCurrent) =>
    adapter.request(method, { ...params, sessionId: sid }, signal, () => isCurrent() && enabled());
  async function answer(sid: string, questionId: string, payload: Record<string, unknown>): Promise<AnswerResponse> {
    const id = key(sid, questionId), intent = answerIntent(payload);
    const previous = answerIntents.get(id);
    if (previous && previous.intent !== intent) throw new Error('The original answer is still unconfirmed; this changed answer has not been sent');
    const pending = previous ?? {intent, payload: JSON.parse(JSON.stringify(payload)) as Record<string, unknown>};
    const recover = async () => {
      const result = row(await request('question/query', sid, { questionId, payload: pending.payload }));
      if (answerIntents.get(id) !== pending) throw unknown();
      if (result.questionId !== questionId || result.result !== 'accepted') throw unknown();
      uncertain.delete(id); answerIntents.delete(id);
      return { id: sid, questionId, accepted: true as const, alreadyAnswered: true, status: typeof result.status === 'string' ? result.status : 'unknown' };
    };
    if (uncertain.has(id)) return recover();
    uncertain.add(id); answerIntents.set(id, pending);
    try {
      const result = row(await request('question/answer', sid, { payload: { ...payload, questionId } }));
      if (answerIntents.get(id) !== pending || result.id !== sid || result.questionId !== questionId || result.accepted !== true || typeof result.alreadyAnswered !== 'boolean') throw unknown();
      uncertain.delete(id); answerIntents.delete(id); return result as AnswerResponse;
    } catch (error) {
      if (definite(error)) { if (answerIntents.get(id) === pending) { uncertain.delete(id); answerIntents.delete(id); } throw error; }
      try { return await recover(); } catch { throw unknown(); }
    }
  }
  const question: QuestionTransport = {
    load: async (sid, signal) => parseQuestionResponse(await request('question/read', sid, {}, signal), sid),
    answer: (sid, id, text) => answer(sid, id, { answer: text }),
    answerCards: (sid, id, answers) => answer(sid, id, { answers }),
  };
  const metadata = (value: unknown, sid: string, root: string): QueueWithdrawalMetadata => {
    const r = row(value);
    if (root !== adapter.owner.workspaceIdentity || r.root !== root || r.sessionId !== sid
      || typeof r.id !== 'string' || !/^c_\d{13}_[0-9a-f]{32}$/u.test(r.id)
      || typeof r.queueId !== 'string' || !/^[0-9a-f]{32}$/u.test(r.queueId)
      || typeof r.hasContext !== 'boolean' || !Number.isSafeInteger(r.expectedRevision) || Number(r.expectedRevision) < 0
      || !Number.isSafeInteger(r.createdAt) || Number(r.createdAt) < 0 || !Number.isSafeInteger(r.expiresAt)
      || Number(r.expiresAt) <= Number(r.createdAt)) throw new Error('Invalid remote withdrawal identity');
    return r as QueueWithdrawalMetadata;
  };
  const withdrawal: QueueWithdrawalTransport = {
    list: async (sid, root, signal) => {
      const result = row(await request('withdrawal/list', sid, {}, signal));
      if (!Array.isArray(result.withdrawals)) throw new Error('Invalid withdrawal list');
      const rows = result.withdrawals.map(r => metadata(r, sid, root));
      if (new Set(rows.map(r => r.id)).size !== rows.length) throw new Error('Duplicate withdrawal identity');
      return rows;
    },
    get: async (sid, root, recoveryId, signal) => {
      const result = row(await request('withdrawal/get', sid, { recoveryId }, signal));
      const r = row(result.withdrawal), meta = metadata(r, sid, root);
      if (meta.id !== recoveryId || typeof r.text !== 'string' || !r.text.trim() || r.text.includes('\0') || Array.from(r.text).length > 5000) throw new Error('Invalid withdrawal text');
      const proof = { ...meta, text: r.text } as QueueWithdrawal;
      if (!adapter.confirmWithdrawalProof(sid, proof)) throw new Error('Withdrawal proof does not match the original remote command');
      return proof;
    },
    dismiss: async (sid, recoveryId, signal, enabled) => {
      if (enabled && !enabled()) throw Object.assign(new Error('Recovery disabled'), { requestNotSent: true });
      const result = row(await request('withdrawal/dismiss', sid, { recoveryId }, signal, enabled));
      if (result.id !== recoveryId || result.dismissed !== true) throw unknown();
    },
  };
  async function reconcile(sid: string, signal?: AbortSignal): Promise<RemoteGuidanceReconciliation> {
    const id = key(sid, 'guidance'), pending = guidanceOperations.get(id);
    if (!pending) return {result: 'none'};
    const result = row(await request('guidance/query', sid, {payload: pending.envelope}, signal));
    if (guidanceOperations.get(id) !== pending) throw unknown();
    if (result.requestId !== pending.requestId || !['accepted','released','unknown'].includes(String(result.result))) throw unknown();
    if (result.result === 'unknown') return {result: 'unknown', operation: pending.operation, requestId: pending.requestId};
    const receipt = row(result.receipt);
    if (!pending.validate(receipt) || (result.result === 'released' && pending.operation !== 'promote')) throw unknown();
    guidanceOperations.delete(id);
    return {result: result.result as 'accepted' | 'released', operation: pending.operation, requestId: pending.requestId, receipt};
  }
  async function mutation(sid: string, method: string, params: Record<string, unknown>, validate: (r: Record<string, unknown>) => boolean, enabled: () => boolean = isCurrent) {
    const id = key(sid, 'guidance');
    if (guidanceOperations.has(id)) return { ok: false as const, error: unknown().message, outcomeUnknown: true };
    const operation = method === 'guidance/send' ? 'send' : method === 'guidance/promote' ? 'promote' : 'cancel';
    const payload = operation === 'cancel' ? {} : row(params.payload);
    const envelope = operation === 'cancel' ? {operation, guidanceId: params.guidanceId}
      : {operation, payload, ...(operation === 'promote' ? {queueId: params.queueId} : {})};
    const pending: GuidanceOperation = {operation, requestId: String(operation === 'cancel' ? params.guidanceId : payload.request_id), envelope, validate};
    guidanceOperations.set(id, pending);
    try {
      const result = row(await request(method, sid, params, undefined, enabled));
      if (guidanceOperations.get(id) !== pending || !validate(result)) throw unknown();
      guidanceOperations.delete(id); return { ok: true as const, value: result };
    } catch (error) {
      if (definite(error) && guidanceOperations.get(id) === pending) guidanceOperations.delete(id);
      return { ok: false as const, error: error instanceof Error ? error.message : String(error), ...(!definite(error) ? { outcomeUnknown: true } : {}) };
    }
  }
  const guidance: { read: typeof readGuidance; send: typeof guideCurrentTurn; cancel: typeof withdrawGuidance; promote: typeof reserveQueuedMessageNow; reconcile: typeof reconcile } = {
    reconcile,
    read: async (sid, signal) => {
      const result = row(await request('guidance/read', sid, {}, signal));
      for (const field of ['pending_guidance', 'guidance_history']) {
        if (!Array.isArray(result[field]) || (result[field] as unknown[]).some(item => {
          const r = row(item); return typeof r.id !== 'string' || typeof r.text !== 'string' || typeof r.status !== 'string';
        })) throw new Error('Invalid guidance snapshot');
      }
      return result as Awaited<ReturnType<typeof readGuidance>>;
    },
    send: async (sid, turn, text, token, enabled) => {
      const result = await mutation(sid, 'guidance/send', { payload: { request_id: crypto.randomUUID().replaceAll('-', ''), expected_turn_id: turn, text, ...(token ? { prepared_token: token } : {}) } }, r => {
        const item = row(r.item); return typeof item.id === 'string' && /^[0-9a-f]{32}$/u.test(item.id) && r.id === item.id && item.text === text && item.delivery === 'guide' && item.targetTurnId === turn && item.status === 'queued' && Number.isInteger(item.position) && Number(item.position) >= 0;
      }, enabled);
      return result.ok ? { ok: true, value: result.value.item as Extract<Awaited<ReturnType<typeof guideCurrentTurn>>, {ok: true}>['value'] } : result;
    },
    cancel: async (sid, guidanceId, enabled) => {
      const result = await mutation(sid, 'guidance/cancel', {guidanceId}, r => r.id === guidanceId && r.removed === true, enabled);
      if (!result.ok) throw result.outcomeUnknown ? unknown() : new Error(result.error);
    },
    promote: async (sid, queueId, turn, revision, enabled) => {
      const requestId = crypto.randomUUID().replaceAll('-', '');
      const result = await mutation(sid, 'guidance/promote', { queueId, payload: { request_id: requestId, expected_turn_id: turn, ...(revision !== undefined ? { expectedRevision: revision } : {}) } }, r =>
        r.id === queueId && r.request_id === requestId && r.delivery === 'startNow' && r.state === 'reserved', enabled);
      return result as Awaited<ReturnType<typeof reserveQueuedMessageNow>>;
    },
  };
  return { question, withdrawal, guidance };
}

export function createRemoteMessageEditAttachmentTransport(adapter: RemoteSessionAdapter, isCurrent: () => boolean = adapter.isCurrent) {
  const draftKey = 'remote-history-edit:' + crypto.randomUUID();
  const guarded = new RemoteSessionAdapter(adapter.owner, () => adapter.isCurrent() && isCurrent());
  // Disposal retains the original connection generation but outlives its pane.
  const disposal = new RemoteSessionAdapter(adapter.owner, isComposerAttachmentLifecycleEnabled);
  const disposalMedia = createRemoteMediaTransport(adapter.mediaOwner,
    (method, params, signal) => disposal.request(method, params, signal, isComposerAttachmentLifecycleEnabled), adapter.owner.limits);
  const cleanup: UploadTransport = async <T>(path: string, body: object, signal?: AbortSignal): Promise<T> => {
    if (!['/api/composer/attachments/abort', '/api/composer/attachments/release'].includes(path)) throw new Error('Unsupported remote history disposal');
    const payload = body as Record<string, unknown>;
    if (typeof payload.session_id !== 'string' || !payload.session_id || typeof payload.id !== 'string' || !/^[0-9a-f]{32}$/u.test(payload.id)
      || Object.keys(payload).some(key => !['root','session_id','id'].includes(key))) throw new Error('Invalid remote history disposal scope');
    const result = await disposalMedia<T>(path, body, signal);
    if (path.endsWith('/release')) releasedRemoteRestoreRef(adapter.mediaOwner, payload.session_id, payload.id);
    return result;
  };
  const check = (enabled: () => boolean) => { if (!enabled() || !adapter.isCurrent() || !isCurrent()) throw Object.assign(new Error('Remote edit attachment owner changed'), { requestNotSent: true }); };
  return {
    endpoint: adapter.mediaOwner, draftKey, cleanup,
    prepare: (async (...args: Parameters<typeof guarded.prepare>) => {
      const result = await guarded.prepare(...args);
      return { ...result, root: adapter.mediaOwner.workspaceIdentity };
    }),
    upload: createRemoteMediaTransport(adapter.mediaOwner, (method, params, signal) => guarded.request(method, params, signal, isCurrent, value => {
      const ref = value && typeof value === 'object' ? parseAttachmentRef((value as {ref?:unknown}).ref) : null;
      if (ref && typeof params.sessionId === 'string') deferComposerAttachmentAbort({ root: adapter.mediaOwner.workspaceIdentity,
        sessionId: params.sessionId, remote: adapter.mediaOwner, draftKey }, ref.id, () => false, cleanup);
    }), adapter.owner.limits),
    restore: async (input: { sessionId: string; messageIndex: number; revision: string }, enabled: () => boolean) => {
      check(enabled);
      const previous = findRemoteRestore(adapter.mediaOwner, input);
      let intent;
      if (previous) { intent = previous; claimRemoteRestore(intent); }
      else {
        const epoch = row(await guarded.request('media/restore-epoch', { sessionId: input.sessionId, payload: {} }, undefined, () => enabled() && isCurrent()));
        check(enabled);
        if (epoch.sessionId !== input.sessionId || epoch.root !== adapter.mediaOwner.workspaceIdentity
          || !Number.isSafeInteger(epoch.restoreEpoch) || Number(epoch.restoreEpoch) < 0) throw new Error('Invalid remote restore epoch');
        intent = beginRemoteRestore(adapter.mediaOwner, input, Number(epoch.restoreEpoch));
      }
      try {
        const media = createRemoteHistoryMediaTransport(adapter.mediaOwner, (method, params, signal) => guarded.request(method, params, signal, () => enabled() && isCurrent(), () => disposeRemoteRestore(intent)));
        let result;
        try {
          if (previous) throw new Error('Query original history restore');
          result = await media.restore(input.sessionId, input.messageIndex, input.revision, draftKey, undefined, intent.restoreId, intent.restoreEpoch);
        } catch (error) {
          check(enabled);
          const status = validateRemoteRestoreReceipt(await guarded.request('media/restore-status', remoteRestoreParams(intent), undefined, () => enabled() && isCurrent()), intent);
          if (status.status !== 'committed' || status.cleanupOnly === true || !status.result) throw error;
          result = bindRemoteRestoredMedia(adapter.mediaOwner, status.result, input.sessionId, draftKey);
        }
        check(enabled);
        if (intent.revision !== input.revision) throw new Error('Original history restore belongs to an older revision');
        ownRemoteRestoreRefs(intent, result.refs.map(ref => ref.id));
        return { ...result, disposeRestore: () => disposeRemoteRestore(intent) };
      } catch (error) {
        if (previous && enabled() && adapter.isCurrent() && isCurrent()) {
          unclaimRemoteRestore(intent);
          return { disposeRestore: () => disposeRemoteRestore(intent) };
        }
        disposeRemoteRestore(intent);
        throw error;
      }
    },
    release: async (input: { sessionId?: string; root: string; id: string }, enabled: () => boolean) => {
      check(enabled);
      if (!input.sessionId || input.root !== adapter.owner.workspaceIdentity) throw new Error('Remote release scope mismatch');
      const result = await guarded.request('media/release', { sessionId: input.sessionId, payload: { id: input.id } }, undefined, enabled);
      check(enabled); releasedRemoteRestoreRef(adapter.mediaOwner, input.sessionId, input.id); return result;
    },
  };
}
