/** Session reads. Failures come back as `{ok:false, error}`, never as throws. */
import { parseSessionsIndex } from './sessionsIndex';
import { parseConversationSnapshot, parseQueuedMessages, parseSessionInboxFields } from './sessionPayloadParsers';
import { requestGet, sessionPath, toErrorMessage } from './sessionHttp';
import type {
  ArchivedSummary, ConversationSnapshot, ConversationSnapshotRequest, FilePreview, Result, SessionSummary,
  WorkbenchSession, WorkspaceListing,
} from './workbenchTypes';

export async function listSessions(signal?: AbortSignal): Promise<Result<SessionSummary[]>> {
  try {
    const payload = await requestGet<{ sessions?: SessionSummary[] }>("/api/sessions", signal);
    return { ok: true, value: payload.sessions ?? [] };
  } catch (error) {
    return { ok: false, error: toErrorMessage(error) };
  }
}

/** Same-origin transport; sessions owns snapshot parsing and list fallback. */
export async function listSessionsIndex(signal?: AbortSignal): Promise<Result<SessionSummary[]>> {
  try {
    const payload = await requestGet<unknown>("/api/sessions/index", signal);
    return { ok: true, value: parseSessionsIndex(payload) };
  } catch (error) {
    return { ok: false, error: toErrorMessage(error) };
  }
}

export async function loadSession(id: string, signal?: AbortSignal): Promise<Result<WorkbenchSession>> {
  try {
    const payload = await requestGet<unknown>(sessionPath(id), signal);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("invalid session response");
    const value = payload as WorkbenchSession;
    const record = payload as Record<string, unknown>;
    const queuedMessages = parseQueuedMessages(record.queued_messages);
    const inboxFields = parseSessionInboxFields(record);
    return { ok: true, value: { ...value, ...inboxFields, ...(queuedMessages ? { queued_messages: queuedMessages } : {}) } };
  } catch (error) {
    return { ok: false, error: toErrorMessage(error) };
  }
}

/** Reject mixed sessions and incomplete snapshots before updating the view. */
export async function loadConversationSnapshot(id: string, signal?: AbortSignal,
  window?: ConversationSnapshotRequest): Promise<Result<ConversationSnapshot>> {
  try {
    const query = new URLSearchParams();
    if (window?.tail !== undefined) query.set('tail', String(window.tail));
    if (window?.before !== undefined) query.set('before', String(window.before));
    if (window?.limit !== undefined) query.set('limit', String(window.limit));
    if (window?.revision) query.set('revision', window.revision);
    const suffix = `/conversation${query.size ? `?${query.toString()}` : ''}`;
    const payload = await requestGet<unknown>(sessionPath(id, suffix), signal);
    return {ok: true, value: parseConversationSnapshot(id, payload)};
  } catch (error) { return {ok: false, error: toErrorMessage(error)}; }
}

export async function loadOlderConversationPage(id: string, before: number, revision: string,
  signal?: AbortSignal, limit = 80): Promise<Result<ConversationSnapshot>> {
  return loadConversationSnapshot(id, signal, {before, limit, revision});
}

export async function loadFiles(id: string, signal?: AbortSignal): Promise<Result<WorkspaceListing>> {
  try {
    const value = await requestGet<WorkspaceListing>(sessionPath(id, "/files"), signal);
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: toErrorMessage(error) };
  }
}

export async function loadFilePreview(id: string, path: string, signal?: AbortSignal): Promise<Result<FilePreview>> {
  try {
    const query = new URLSearchParams({ path });
    const value = await requestGet<FilePreview>(`${sessionPath(id, "/file")}?${query.toString()}`, signal);
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: toErrorMessage(error) };
  }
}

export async function loadJournal(id: string, signal?: AbortSignal): Promise<Result<unknown>> {
  try {
    return { ok: true, value: await requestGet<unknown>(sessionPath(id, "/journal"), signal) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Lists soft-deleted sessions from the archive, newest archive first. */
export async function listArchivedSessions(signal?: AbortSignal): Promise<Result<ArchivedSummary[]>> {
  try {
    const payload = await requestGet<{ sessions?: ArchivedSummary[] }>("/api/sessions/archived", signal);
    return { ok: true, value: payload.sessions ?? [] };
  } catch (error) {
    return { ok: false, error: toErrorMessage(error) };
  }
}
