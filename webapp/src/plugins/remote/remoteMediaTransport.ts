import type { UploadTransport } from '../sessions/composerAttachmentUpload';
import { parseAttachmentRef, type AttachmentRef, parseRemoteAttachmentEndpoint, type RemoteAttachmentEndpoint, type RemoteAttachmentOwner } from '../sessions/composerAttachmentRef';

export type RemoteMediaRequest = (method: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
/** Transport only. Remote references never pass through a local composer route. */
export function createRemoteMediaTransport(endpoint: RemoteAttachmentEndpoint, request: RemoteMediaRequest, limits?: Record<string, number>): UploadTransport {
  const transport: UploadTransport = async <T>(path: string, body: object, signal?: AbortSignal): Promise<T> => {
    const match = /^\/api\/composer\/attachments\/(begin|chunk|commit|status|abort|release)$/u.exec(path);
    const { root, session_id, ...payload } = body as Record<string, unknown>;
    if (!match || root !== endpoint.workspaceIdentity || (session_id !== undefined && typeof session_id !== 'string')) {
      throw new Error('Remote attachment scope mismatch');
    }
    const action = match[1];
    const params = { sessionId: session_id ?? null, payload };
    try { return await request(`media/${action}`, params, signal) as T; }
    catch (error) {
      signal?.throwIfAborted();
      // Query the same transaction after an unknown body/commit response. Never create a replacement.
      if (!['chunk', 'commit', 'abort'].includes(action) || typeof payload.id !== 'string') throw error;
      const status = await request('media/status', { sessionId: session_id ?? null, payload: { id: payload.id } }, signal) as Record<string, unknown>;
      if (status.status === 'committed' || (action === 'chunk' && status.status === 'pending' &&
          status.nextChunkIndex === Number(payload.chunkIndex) + 1)) return status as T;
      throw error;
    }
  };
  transport.chunkBytes = Math.min(limits?.maxChunkBytes ?? 262144, 262144);
  transport.attachmentLimits = { count: Math.min(limits?.maxMediaFiles ?? 8, 8), imageBytes: Math.min(limits?.maxMediaFileBytes ?? 20971520, 20971520), totalBytes: Math.min(limits?.maxMediaSelectionBytes ?? 67108864, 67108864) };
  return transport;
}

export function validateRemoteMediaRefs(refs: readonly { id: string; remoteOwner?: RemoteAttachmentOwner }[],
  endpoint: RemoteAttachmentEndpoint, root: string, sessionId?: string): { id: string }[] {
  if (refs.length > 8) throw new Error('Remote attachment selection limit exceeded');
  const drafts = new Set<string>();
  return refs.map(ref => {
    const owner = ref.remoteOwner;
    if (!/^[0-9a-f]{32}$/u.test(ref.id) || !owner || !parseRemoteAttachmentEndpoint(owner) ||
        owner.connectionId !== endpoint.connectionId || owner.digest !== endpoint.digest ||
        owner.workspaceIdentity !== endpoint.workspaceIdentity || owner.root !== root ||
        owner.sessionId !== sessionId || typeof owner.draftKey !== 'string' || !owner.draftKey) {
      throw new Error('Attachment was not uploaded for this remote workspace and draft');
    }
    drafts.add(owner.draftKey);
    if (drafts.size > 1) throw new Error('Remote attachment draft ownership mismatch');
    return { id: ref.id };
  });
}

export function bindRemoteRestoredMedia(endpoint: RemoteAttachmentEndpoint, value: unknown, sessionId: string, draftKey: string) {
  const result = value as Record<string, unknown>;
  if (!result || typeof result.text !== 'string' || !Array.isArray(result.refs) || result.refs.length > 8) throw new Error('Invalid remote history media response');
  const refs = result.refs.map(value => {
    const ref = parseAttachmentRef(value);
    if (!ref || !/^[0-9a-f]{32}$/u.test(ref.id)) throw new Error('Invalid restored remote attachment');
    const { path: _path, ...publicRef } = ref;
    return { ...publicRef, origin: 'file' as const, source: 'upload' as const, remoteOwner: { ...endpoint, root: endpoint.workspaceIdentity, sessionId, draftKey } };
  });
  return { text: result.text, refs, root: endpoint.workspaceIdentity };

}

/** History references are authorized by the saved message and revision first. */
export function createRemoteHistoryMediaTransport(endpoint: RemoteAttachmentEndpoint, request: RemoteMediaRequest) {
  return {
    restore: async (sessionId: string, messageIndex: number, revision: string, draftKey: string, signal: AbortSignal | undefined, restoreId: string, restoreEpoch: number) => {
      if (!Number.isSafeInteger(restoreEpoch) || restoreEpoch < 0 || !/^[0-9a-f]{32}$/u.test(restoreId) || !sessionId || !draftKey || !Number.isSafeInteger(messageIndex) || messageIndex < 0 || !/^sha256:[0-9a-f]{64}$/u.test(revision)) throw new Error('Invalid remote history identity');
      const result = await request('media/restore', { sessionId, payload: { messageIndex, revision, restoreId, restoreEpoch } }, signal) as Record<string, unknown>;
      return bindRemoteRestoredMedia(endpoint, result, sessionId, draftKey);
    },
    preview: async (sessionId: string, ref: AttachmentRef, signal?: AbortSignal, chunkIndex?: number) => {
      if (chunkIndex !== undefined && (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= 80)) throw new Error('Invalid preview chunk index');
      validateRemoteMediaRefs([ref], endpoint, endpoint.workspaceIdentity, sessionId);
      // The receiver validates bounded preview payloads before rendering them.
      return request('media/preview', { sessionId, payload: { id: ref.id, ...(chunkIndex !== undefined ? { chunkIndex } : {}) } }, signal);
    },
  };
}
