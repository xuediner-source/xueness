import { requestMutation } from "../../xuenessWorkbench";
import { t as tr } from '../../i18n';
import type { SessionCommandClient } from './commandClient';
import { CommandDeliveryUnconfirmedError } from './commandReceipt';
import { DeliveryUnconfirmedError } from './submissionTransport';

function record(result: unknown, commandId?: string): Record<string, unknown> {
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw unconfirmed(commandId);
  return result as Record<string, unknown>;
}
function unconfirmed(commandId?: string): Error {
  return commandId ? new CommandDeliveryUnconfirmedError(commandId) : new DeliveryUnconfirmedError();
}

function requireRevision(commands: SessionCommandClient | undefined, expectedRevision: number | undefined): void {
  if ((commands || expectedRevision !== undefined) && (!Number.isSafeInteger(expectedRevision) || expectedRevision! < 0)) {
    throw Object.assign(new Error('Queue revision is unavailable; refresh the queue before changing it'), { requestNotSent: true });
  }
}

export async function editQueuedMessage(sessionId: string, queueId: string, text: string, expectedText: string,
  commands?: SessionCommandClient, expectedRevision?: number): Promise<void> {
  requireRevision(commands, expectedRevision);
  const payload = { queueId, text, expectedText, ...(expectedRevision !== undefined ? { expectedRevision } : {}) };
  const direct = (signal?: AbortSignal) => requestMutation('PATCH',
    `/api/sessions/${encodeURIComponent(sessionId)}/queue/${encodeURIComponent(queueId)}`, { text, expectedText, ...(expectedRevision !== undefined ? { expectedRevision } : {}) }, signal);
  const validate = (value: unknown, commandId?: string) => {
    const result = record(value, commandId);
    const item = record(result.item, commandId);
    if (result.id !== queueId || item.id !== queueId || item.text !== text.trim()) throw unconfirmed(commandId);
  };
  if (commands) await commands.submitQueue(sessionId, 'edit_queue', payload, direct, validate);
  else validate(await direct());
}

export async function cancelQueuedMessage(sessionId: string, queueId: string, expectedText?: string,
  commands?: SessionCommandClient, expectedRevision?: number): Promise<void> {
  requireRevision(commands, expectedRevision);
  if (commands && typeof expectedText !== 'string') throw Object.assign(new Error('Queue cancellation requires the observed text'), { requestNotSent: true });
  const direct = (signal?: AbortSignal) => requestMutation('DELETE',
    `/api/sessions/${encodeURIComponent(sessionId)}/queue/${encodeURIComponent(queueId)}`,
    expectedText === undefined && expectedRevision === undefined ? undefined : { expectedText, ...(expectedRevision !== undefined ? { expectedRevision } : {}) }, signal);
  const validate = (value: unknown, commandId?: string) => {
    const result = record(value, commandId);
    if (result.removed !== true || (commandId ? result.id !== queueId : result.id !== undefined && result.id !== queueId)) throw unconfirmed(commandId);
  };
  if (commands) await commands.submitQueue(sessionId, 'cancel_queue', { queueId, expectedText, expectedRevision }, direct, validate);
  else validate(await direct());
}

export async function reorderQueuedMessages(sessionId: string, ids: string[], expectedIds: string[],
  commands?: SessionCommandClient, expectedRevision?: number): Promise<void> {
  requireRevision(commands, expectedRevision);
  // Caller arrays can change while admission is loading. Preserve this CAS intent.
  const payload = { ids: [...ids], expectedIds: [...expectedIds], ...(expectedRevision !== undefined ? { expectedRevision } : {}) };
  const direct = (signal?: AbortSignal) => requestMutation('PATCH',
    `/api/sessions/${encodeURIComponent(sessionId)}/queue`, payload, signal);
  const validate = (value: unknown, commandId?: string) => {
    const result = record(value, commandId);
    if (!Array.isArray(result.ids) || result.ids.length !== payload.ids.length || result.ids.some((id, index) => id !== payload.ids[index])) {
      throw unconfirmed(commandId);
    }
  };
  try {
    if (commands) await commands.submitQueue(sessionId, 'reorder_queue', payload, direct, validate);
    else validate(await direct());
  } catch (error) {
    if (error instanceof Error && (('status' in error && error.status === 409)
      || ('ack' in error && (error.ack as { reasonCode?: string })?.reasonCode === 'state_conflict'))) {
      throw new Error(tr('队列已发生变化，请根据最新顺序重新调整。'));
    }
    throw error;
  }
}

export type QueueWithdrawalMetadata = {
  id: string; queueId: string; sessionId: string; root: string; hasContext: boolean;
  expectedRevision: number; createdAt: number; expiresAt: number;
};
export type QueueWithdrawal = QueueWithdrawalMetadata & { text: string };
const withdrawalPath = (sessionId: string, id?: string) =>
  `/api/sessions/${encodeURIComponent(sessionId)}/queue-withdrawals${id ? `/${encodeURIComponent(id)}` : ''}`;

function parseWithdrawal(value: unknown, sessionId: string, root: string): QueueWithdrawalMetadata {
  const row = record(value);
  if (typeof row.id !== 'string' || !row.id || typeof row.queueId !== 'string' || !row.queueId
    || row.sessionId !== sessionId || row.root !== root || typeof row.hasContext !== 'boolean'
    || !Number.isSafeInteger(row.expectedRevision) || (row.expectedRevision as number) < 0
    || typeof row.createdAt !== 'number' || !Number.isSafeInteger(row.createdAt) || row.createdAt < 0 || !Number.isFinite(new Date(row.createdAt).getTime())
    || typeof row.expiresAt !== 'number' || !Number.isSafeInteger(row.expiresAt) || row.expiresAt <= row.createdAt || !Number.isFinite(new Date(row.expiresAt).getTime())) {
    throw new Error('Invalid withdrawal recovery identity');
  }
  return { id: row.id, queueId: row.queueId, sessionId, root, hasContext: row.hasContext,
    expectedRevision: row.expectedRevision as number, createdAt: row.createdAt, expiresAt: row.expiresAt };
}
async function readWithdrawal(path: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', signal });
  if (!response.ok) throw new Error(response.status === 404
    ? tr('恢复副本不存在或已过期；这不能证明原撤回操作是否成功。') : `HTTP ${response.status}`);
  return record(await response.json());
}
export async function listQueueWithdrawals(sessionId: string, root: string, signal?: AbortSignal): Promise<QueueWithdrawalMetadata[]> {
  const result = await readWithdrawal(withdrawalPath(sessionId), signal);
  if (!Array.isArray(result.withdrawals)) throw new Error('Invalid withdrawal recovery list');
  const rows = result.withdrawals.map(row => parseWithdrawal(row, sessionId, root));
  if (new Set(rows.map(row => row.id)).size !== rows.length) throw new Error('Duplicate withdrawal recovery identity');
  return rows;
}
export async function getQueueWithdrawal(sessionId: string, root: string, id: string, signal?: AbortSignal): Promise<QueueWithdrawal> {
  const result = await readWithdrawal(withdrawalPath(sessionId, id), signal);
  const metadata = parseWithdrawal(result.withdrawal, sessionId, root);
  const row = record(result.withdrawal);
  if (metadata.id !== id || typeof row.text !== 'string' || !row.text.trim() || row.text.includes('\0') || Array.from(row.text).length > 5000) throw new Error('Invalid withdrawal recovery text');
  return { ...metadata, text: row.text };
}
export async function dismissQueueWithdrawal(sessionId: string, id: string, signal?: AbortSignal, enabled?: () => boolean): Promise<void> {
  const result = record(await requestMutation('DELETE', withdrawalPath(sessionId, id), {}, signal, enabled));
  if (result.id !== id || result.dismissed !== true) throw new Error('Withdrawal dismissal unconfirmed');
}
/** No legacy cancellation fallback: only atomic escrow can authorize a withdrawal. */
export async function withdrawQueuedMessage(sessionId: string, queueId: string, expectedText: string,
  expectedRevision: number, commands: SessionCommandClient): Promise<string> {
  requireRevision(commands, expectedRevision);
  const validate = (value: unknown, commandId: string) => {
    const result = record(value, commandId);
    if (result.id !== queueId || result.removed !== true || result.recoveryId !== commandId) throw unconfirmed(commandId);
  };
  const result = record(await commands.submitQueue(sessionId, 'withdraw_queue', { queueId, expectedText, expectedRevision },
    async () => { throw Object.assign(new Error('Durable withdrawal requires session commands'), { requestNotSent: true }); }, validate));
  return result.recoveryId as string;
}
