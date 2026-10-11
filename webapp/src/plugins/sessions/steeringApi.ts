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

async function admitOnce(path: string, body: object): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    try { return await requestMutation('POST', path, body, AbortSignal.timeout(20000)); }
    catch (error) {
      if (attempt > 0) throw new DeliveryUnconfirmedError();
      if (!couldHaveBeenAccepted(error)) throw error;
    }
  }
}

export async function guideCurrentTurn(sessionId: string, expectedTurnId: string, text: string,
  preparedToken?: string): Promise<SubmissionResult<AdmittedInput>> {
  const body = { text, expected_turn_id: expectedTurnId,
    request_id: crypto.randomUUID().replaceAll('-', ''), ...(preparedToken ? { prepared_token: preparedToken } : {}) };
  try {
    const result = await admitOnce(`/api/sessions/${encodeURIComponent(sessionId)}/steer`, body);
    const record = result as { id?: string; item?: AdmittedInput } | null;
    if (!record || !record.item || record.item.id !== record.id || record.item.text !== text
      || record.item.delivery !== 'guide' || record.item.targetTurnId !== expectedTurnId
      || record.item.status !== 'queued' || !Number.isInteger(record.item.position)) throw new DeliveryUnconfirmedError();
    return { ok: true, value: record.item };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error),
      ...(error instanceof DeliveryUnconfirmedError ? { outcomeUnknown: true } : {}) };
  }
}

export async function withdrawGuidance(sessionId: string, inputId: string): Promise<void> {
  const response = await requestMutation<{ id: string; removed: boolean }>('DELETE',
    `/api/sessions/${encodeURIComponent(sessionId)}/steer/${encodeURIComponent(inputId)}`, {});
  if (response.id !== inputId || response.removed !== true) throw new Error('Invalid guidance withdrawal response');
}

export type PromotionReceipt = { id: string; request_id: string; delivery: 'startNow'; state: 'reserved' };

/** Admission only: the caller still waits for the old worker, then starts it. */
export async function reserveQueuedMessageNow(sessionId: string, queueId: string,
  expectedTurnId: string): Promise<SubmissionResult<PromotionReceipt>> {
  const body = { expected_turn_id: expectedTurnId, request_id: crypto.randomUUID().replaceAll('-', '') };
  try {
    const response = await admitOnce(`/api/sessions/${encodeURIComponent(sessionId)}/queue/${encodeURIComponent(queueId)}/send-now`, body);
    const result = response as PromotionReceipt | null;
    if (!result || result.id !== queueId || result.request_id !== body.request_id
      || result.delivery !== 'startNow' || result.state !== 'reserved') throw new DeliveryUnconfirmedError();
    return { ok: true, value: result };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error),
      ...(error instanceof DeliveryUnconfirmedError ? { outcomeUnknown: true } : {}) };
  }
}
