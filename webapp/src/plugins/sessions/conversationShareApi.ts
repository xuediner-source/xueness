/**
 * Read-only conversation shares. Only the lazy sharing views use these calls,
 * so they load with those views instead of with the workbench.
 */
import { requestGet, requestMutation, requestPost, sessionPath, toErrorMessage } from './sessionHttp';
import type { Result } from './workbenchTypes';

export type ConversationShareRow = {
  id: string;
  turnId: string;
  role: 'user' | 'assistant';
  text: string;
};

export type ConversationShare = {
  schema: 'xueness.conversation-share.v1';
  id: string;
  title: string;
  createdAt: string;
  rows: ConversationShareRow[];
};

export type CreatedConversationShare = { id: string; url: string; title: string };

export type ConversationSharePreview = {
  title: string;
  rows: ConversationShareRow[];
  message_revision: string;
};

/** Read the complete, sanitized transcript and the exact revision to publish. */
export async function loadConversationSharePreview(
  sessionId: string,
  signal?: AbortSignal,
): Promise<Result<ConversationSharePreview>> {
  try {
    const payload = await requestGet<unknown>(sessionPath(sessionId, '/share'), signal);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('invalid conversation share preview');
    const record = payload as Record<string, unknown>;
    if (typeof record.title !== 'string' || !record.title
      || typeof record.message_revision !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(record.message_revision)
      || !Array.isArray(record.rows)) throw new Error('invalid conversation share preview');
    const rows = record.rows.map((value): ConversationShareRow => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid conversation share preview row');
      const row = value as Record<string, unknown>;
      if (typeof row.id !== 'string' || !row.id || typeof row.turnId !== 'string' || !/^turn-[1-9][0-9]*$/u.test(row.turnId)
        || (row.role !== 'user' && row.role !== 'assistant') || typeof row.text !== 'string') {
        throw new Error('invalid conversation share preview row');
      }
      return { id: row.id, turnId: row.turnId, role: row.role, text: row.text };
    });
    return { ok: true, value: { title: record.title, rows, message_revision: record.message_revision } };
  } catch (error) { return { ok: false, error: toErrorMessage(error) }; }
}

/** Create a same-host, read-only transcript share tied to one exact journal revision. */
export async function createConversationShare(
  sessionId: string,
  expectedRevision: string,
  turnIds?: string[],
  title?: string,
): Promise<Result<CreatedConversationShare>> {
  if (!/^sha256:[0-9a-f]{64}$/u.test(expectedRevision)) {
    return { ok: false, error: 'Refresh this conversation before creating a share link.' };
  }
  const cleanTitle = title?.trim();
  try {
    const payload = await requestPost<unknown>(sessionPath(sessionId, '/share'), {
      expected_revision: expectedRevision,
      ...(cleanTitle ? { title: cleanTitle } : {}),
      ...(turnIds ? { turn_ids: turnIds } : {}),
    });
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('invalid conversation share response');
    const record = payload as Record<string, unknown>;
    if (typeof record.id !== 'string' || !record.id || typeof record.title !== 'string' || typeof record.url !== 'string'
      || record.url !== `/share/${encodeURIComponent(record.id)}`) throw new Error('invalid conversation share response');
    return { ok: true, value: { id: record.id, url: record.url, title: record.title } };
  } catch (error) { return { ok: false, error: toErrorMessage(error) }; }
}

/** Read the sanitized, read-only projection at the local share URL. */
export async function loadConversationShare(id: string, signal?: AbortSignal): Promise<Result<ConversationShare>> {
  try {
    const payload = await requestGet<unknown>(`/api/conversation_shares/${encodeURIComponent(id)}`, signal);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('invalid conversation share');
    const record = payload as Record<string, unknown>;
    if (record.schema !== 'xueness.conversation-share.v1' || record.id !== id || typeof record.title !== 'string'
      || typeof record.createdAt !== 'string' || !Array.isArray(record.rows)) throw new Error('invalid conversation share');
    const rows = record.rows.map((value): ConversationShareRow => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid conversation share row');
      const row = value as Record<string, unknown>;
      if (typeof row.id !== 'string' || !row.id || typeof row.turnId !== 'string' || !row.turnId
        || (row.role !== 'user' && row.role !== 'assistant') || typeof row.text !== 'string') throw new Error('invalid conversation share row');
      return { id: row.id, turnId: row.turnId, role: row.role, text: row.text };
    });
    return { ok: true, value: { schema: 'xueness.conversation-share.v1', id, title: record.title,
      createdAt: record.createdAt, rows } };
  } catch (error) { return { ok: false, error: toErrorMessage(error) }; }
}

export async function revokeConversationShare(id: string): Promise<Result<void>> {
  try {
    const payload = await requestMutation<unknown>('DELETE', `/api/conversation_shares/${encodeURIComponent(id)}`, undefined);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || (payload as Record<string, unknown>).revoked !== true) {
      throw new Error('invalid conversation share revoke response');
    }
    return { ok: true, value: undefined };
  } catch (error) { return { ok: false, error: toErrorMessage(error) }; }
}

export async function importConversationShare(
  id: string,
  options: { root?: string; title?: string } = {},
): Promise<Result<string>> {
  try {
    const cleanTitle = options.title?.trim();
    const payload = await requestPost<unknown>(`/api/conversation_shares/${encodeURIComponent(id)}/import`, {
      ...(options.root ? { root: options.root } : {}),
      ...(cleanTitle ? { title: cleanTitle } : {}),
    });
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof (payload as Record<string, unknown>).id !== 'string') {
      throw new Error('invalid imported conversation response');
    }
    return { ok: true, value: (payload as Record<string, unknown>).id as string };
  } catch (error) { return { ok: false, error: toErrorMessage(error) }; }
}
