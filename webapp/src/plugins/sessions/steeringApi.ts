import { requestMutation, type SubmissionResult } from '../../xuenessWorkbench';
import { couldHaveBeenAccepted, DeliveryUnconfirmedError } from './submissionTransport';
import type { PendingGuidance } from './CurrentTurnInput';

type AdmittedInput = PendingGuidance & { delivery: 'guide'; position: number; targetTurnId: string };
export type GuidanceSnapshot = { pending_guidance: PendingGuidance[]; guidance_history: PendingGuidance[] };

function parseGuidanceItems(value: unknown): PendingGuidance[] {
  if (!Array.isArray(value)) throw new Error('Invalid current-turn input response');
  return value.map((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error('Invalid current-turn input response');
    }
    const item = candidate as Record<string, unknown>;
    if (typeof item.id !== 'string' || typeof item.text !== 'string'
      || !['queued', 'running', 'paused', 'completed', 'needs_review', 'failed', 'cancelled'].includes(String(item.status))) {
      throw new Error('Invalid current-turn input response');
    }
    return { id: item.id, text: item.text, status: item.status as PendingGuidance['status'],
      ...(typeof item.targetTurnId === 'string' ? { targetTurnId: item.targetTurnId } : {}),
      ...(typeof item.pause_reason === 'string' ? { pause_reason: item.pause_reason } : {}),
      ...(item.delivery === 'guide' ? { delivery: 'guide' as const } : {}),
      ...(item.has_attachments === true ? { has_attachments: true } : {}),
      ...(item.has_context === true ? { has_context: true } : {}),
      ...(Number.isInteger(item.position) ? { position: item.position as number } : {}) };
  });
}

export async function readGuidance(sessionId: string, signal?: AbortSignal): Promise<GuidanceSnapshot> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/steer`, {
    credentials: 'same-origin', cache: 'no-store', signal: signal ?? AbortSignal.timeout(20000),
  });
  let payload: unknown;
  try { payload = await response.json(); }
  catch { throw new Error('Invalid current-turn input response'); }
  if (!response.ok) {
    const detail = payload && typeof payload === 'object' && 'error' in payload
      ? (payload as { error?: unknown }).error : undefined;
    throw Object.assign(new Error(typeof detail === 'string' ? detail : `HTTP ${response.status}`), { status: response.status });
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid current-turn input response');
  const result = payload as Record<string, unknown>;
  return { pending_guidance: parseGuidanceItems(result.pending_guidance),
    guidance_history: parseGuidanceItems(result.guidance_history) };
}

function ensureEnabled(enabled?: () => boolean): void {
  if (enabled && !enabled()) throw Object.assign(new Error('Current-turn input is no longer enabled'), { requestNotSent: true });
}

async function admitOnce(path: string, body: object, enabled?: () => boolean): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    try {
      ensureEnabled(enabled);
      return await requestMutation('POST', path, body, AbortSignal.timeout(20000), enabled);
    }
    catch (error) {
      if (attempt > 0) throw new DeliveryUnconfirmedError();
      if (!couldHaveBeenAccepted(error)) throw error;
    }
  }
}

type PendingOperation = {
  operation: 'send' | 'promote' | 'cancel'; requestId: string; payload?: Record<string, unknown>;
  queueId?: string; guidanceId?: string; validate(value: unknown): void; unknown: boolean;
};
// Session IDs are server-global locally. Retain original intent across pane remounts.
const pendingOperations = new Map<string, PendingOperation>();
export function hasUnconfirmedLocalGuidance(sessionId: string): boolean { return pendingOperations.get(sessionId)?.unknown === true; }

async function mutateGuidance<T>(sessionId: string, entry: PendingOperation, work: () => Promise<T>, enabled?: () => boolean): Promise<T> {
  ensureEnabled(enabled);
  if (pendingOperations.has(sessionId)) throw new DeliveryUnconfirmedError();
  pendingOperations.set(sessionId, entry);
  try {
    const result = await work(); entry.validate(result);
    pendingOperations.delete(sessionId); return result;
  } catch (error) {
    if (couldHaveBeenAccepted(error) || error instanceof DeliveryUnconfirmedError
      || (error instanceof Error && error.name === 'AbortError' && !('requestNotSent' in error && error.requestNotSent === true))) {
      entry.unknown = true; throw new DeliveryUnconfirmedError();
    }
    pendingOperations.delete(sessionId); throw error;
  }
}

export type GuidanceReconciliation = { result: 'accepted' | 'released' | 'unknown' | 'none';
  operation?: 'send' | 'promote' | 'cancel'; requestId?: string; receipt?: unknown };
/** Query exact retained original intent. This endpoint never re-admits input. */
export async function reconcileLocalGuidanceReceipt(sessionId: string, enabled?: () => boolean): Promise<GuidanceReconciliation> {
  ensureEnabled(enabled);
  const entry = pendingOperations.get(sessionId);
  if (!entry) return { result: 'none' };
  const unresolved = (): GuidanceReconciliation => ({ result: 'unknown', operation: entry.operation, requestId: entry.requestId });
  if (!entry.unknown) return unresolved();
  const result = await requestMutation<{requestId?: unknown; result?: unknown; receipt?: unknown}>('POST',
    `/api/sessions/${encodeURIComponent(sessionId)}/steer-query`, {
      operation: entry.operation, ...(entry.payload ? { payload: entry.payload } : {}),
      ...(entry.queueId ? { queueId: entry.queueId } : {}), ...(entry.guidanceId ? { guidanceId: entry.guidanceId } : {}),
    }, AbortSignal.timeout(20000), enabled);
  ensureEnabled(enabled);
  if (pendingOperations.get(sessionId) !== entry || result.requestId !== entry.requestId) return unresolved();
  if (result.result === 'released' && entry.operation === 'promote') {
    pendingOperations.delete(sessionId); return { result: 'released', operation: entry.operation, requestId: entry.requestId };
  }
  if (result.result !== 'accepted') return unresolved();
  try { entry.validate(result.receipt); } catch { return unresolved(); }
  pendingOperations.delete(sessionId);
  return { result: 'accepted', operation: entry.operation, requestId: entry.requestId, receipt: result.receipt };
}
export async function reconcileLocalGuidance(sessionId: string, enabled?: () => boolean): Promise<boolean> {
  return (await reconcileLocalGuidanceReceipt(sessionId, enabled)).result !== 'unknown';
}

export async function guideCurrentTurn(sessionId: string, expectedTurnId: string, text: string,
  preparedToken?: string, enabled?: () => boolean): Promise<SubmissionResult<AdmittedInput>> {
  const body = { text, expected_turn_id: expectedTurnId,
    request_id: crypto.randomUUID().replaceAll('-', ''), ...(preparedToken ? { prepared_token: preparedToken } : {}) };
  const validate = (result: unknown) => {
    const record = result as { id?: string; item?: AdmittedInput } | null;
    if (!record || !record.item || record.item.id !== record.id || record.item.text !== text
      || record.item.delivery !== 'guide' || record.item.targetTurnId !== expectedTurnId
      || record.item.status !== 'queued' || !Number.isInteger(record.item.position)) throw new DeliveryUnconfirmedError();
  };
  try {
    const result = await mutateGuidance(sessionId, { operation: 'send', requestId: body.request_id, payload: body, validate, unknown: false },
      () => admitOnce(`/api/sessions/${encodeURIComponent(sessionId)}/steer`, body, enabled), enabled);
    return { ok: true, value: (result as {item:AdmittedInput}).item };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error),
      ...(error instanceof DeliveryUnconfirmedError ? { outcomeUnknown: true } : {}) };
  }
}

export async function withdrawGuidance(sessionId: string, inputId: string, enabled?: () => boolean): Promise<void> {
  const validate = (value: unknown) => {
    const response = value as {id?: string; removed?: boolean} | null;
    if (response?.id !== inputId || response.removed !== true) throw new DeliveryUnconfirmedError();
  };
  await mutateGuidance(sessionId, {operation: 'cancel', requestId: inputId, guidanceId: inputId, validate, unknown: false},
    () => requestMutation('DELETE', `/api/sessions/${encodeURIComponent(sessionId)}/steer/${encodeURIComponent(inputId)}`, {}, undefined, enabled), enabled);
}

export type PromotionReceipt = { id: string; request_id: string; delivery: 'startNow'; state: 'reserved' };

/** Admission only: the caller still waits for the old worker, then starts it. */
export async function reserveQueuedMessageNow(sessionId: string, queueId: string,
  expectedTurnId: string, expectedRevision?: number, enabled?: () => boolean): Promise<SubmissionResult<PromotionReceipt>> {
  const body = { expected_turn_id: expectedTurnId, request_id: crypto.randomUUID().replaceAll('-', ''),
    ...(expectedRevision !== undefined ? { expectedRevision } : {}) };
  const validate = (value: unknown) => {
    const result = value as PromotionReceipt | null;
    if (!result || result.id !== queueId || result.request_id !== body.request_id
      || result.delivery !== 'startNow' || result.state !== 'reserved') throw new DeliveryUnconfirmedError();
  };
  try {
    const result = await mutateGuidance(sessionId, {operation: 'promote', requestId: body.request_id, queueId, payload: body, validate, unknown: false},
      () => admitOnce(`/api/sessions/${encodeURIComponent(sessionId)}/queue/${encodeURIComponent(queueId)}/send-now`, body, enabled), enabled);
    return { ok: true, value: result as PromotionReceipt };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error),
      ...(error instanceof DeliveryUnconfirmedError ? { outcomeUnknown: true } : {}) };
  }
}
