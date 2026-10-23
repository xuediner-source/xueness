// sessions.message_actions: per-tab reload-safe, reference-only ownership of local history restores.
import { requestMutation } from '../../xuenessWorkbench';
import { deferComposerAttachmentRelease, flushComposerAttachmentReleases } from './composerAttachmentCleanup';
import { isComposerAttachmentLifecycleEnabled, subscribeComposerAttachmentLifecycle } from './composerAttachmentLifecycle';

export type MessageRestoreIdentity = { sessionId: string; restoreId: string; messageIndex: number; revision: string; root: string; restoreEpoch: number };
export const MESSAGE_RESTORE_STORAGE_KEY = 'xueness.history-restore-cleanup.v1';
type StoredRestore = MessageRestoreIdentity & { cleanup: boolean };
const active = new Set<string>();
const LIMIT = 256;
function key(identity: MessageRestoreIdentity): string { return JSON.stringify([identity.root, identity.sessionId, identity.restoreEpoch, identity.restoreId]); }
function valid(value: unknown): value is StoredRestore {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const r = value as StoredRestore;
  return Object.keys(r).sort().join(',') === 'cleanup,messageIndex,restoreEpoch,restoreId,revision,root,sessionId'
    && typeof r.cleanup === 'boolean'
    && typeof r.root === 'string' && r.root.length > 0 && r.root.length <= 4096
    && Number.isSafeInteger(r.restoreEpoch) && r.restoreEpoch >= 0
    && typeof r.sessionId === 'string' && /^[A-Za-z0-9_-]{1,160}$/u.test(r.sessionId)
    && typeof r.restoreId === 'string' && /^[0-9a-f]{32}$/u.test(r.restoreId)
    && Number.isSafeInteger(r.messageIndex) && r.messageIndex >= 0
    && typeof r.revision === 'string' && /^sha256:[0-9a-f]{64}$/u.test(r.revision);
}
function read(): StoredRestore[] {
  const raw = sessionStorage.getItem(MESSAGE_RESTORE_STORAGE_KEY);
  const rows: unknown = raw === null ? [] : JSON.parse(raw);
  if (!Array.isArray(rows) || rows.length > LIMIT || !rows.every(valid)
      || new Set(rows.map(key)).size !== rows.length) throw new Error('History restore ownership storage is unavailable');
  return rows;
}
function write(rows: StoredRestore[]): void {
  const encoded = JSON.stringify(rows);
  sessionStorage.setItem(MESSAGE_RESTORE_STORAGE_KEY, encoded);
  if (sessionStorage.getItem(MESSAGE_RESTORE_STORAGE_KEY) !== encoded) throw new Error('History restore ownership was not persisted');
}
function body(identity: MessageRestoreIdentity) {
  return { session_id: identity.sessionId, root: identity.root, restoreEpoch: identity.restoreEpoch, restoreId: identity.restoreId, messageIndex: identity.messageIndex, revision: identity.revision };
}
function receipt(value: unknown, identity: MessageRestoreIdentity): Record<string, unknown> {
  if (!value || typeof value !== 'object') throw new Error('Invalid restore receipt');
  const r = value as Record<string, unknown>;
  if (r.sessionId !== identity.sessionId || r.restoreId !== identity.restoreId || r.messageIndex !== identity.messageIndex
       || r.revision !== identity.revision || r.root !== identity.root || r.restoreEpoch !== identity.restoreEpoch
      || !['unknown', 'preparing', 'committed', 'aborted'].includes(String(r.status))) throw new Error('Restore receipt identity changed');
  return r;
}
function queue(identity: MessageRestoreIdentity): void {
  // A synthetic cleanup key is never sent to the server; only the captured exact identity is sent.
  deferComposerAttachmentRelease({ root: identity.root, sessionId: identity.sessionId, draftKey: identity.restoreId }, identity.restoreId,
    () => active.has(key(identity)), async <T>(_path: string, _body: object, signal?: AbortSignal) => {
      const result = receipt(await requestMutation('POST', '/api/composer/attachments/restore-abort', body(identity), signal,
        isComposerAttachmentLifecycleEnabled), identity);
      if (result.status !== 'aborted' || result.cleanupComplete !== true) throw new Error('Restore cleanup remains unconfirmed');
      write(read().filter(row => key(row) !== key(identity)));
      return result as T;
    });
}
/** Reload resumes only explicitly requested cleanup. Live/cloned drafts are never discarded on hydration. */
export function recoverMessageRestoreCleanup(): void {
  try { for (const identity of read()) if (identity.cleanup) queue(identity); } catch { /* Never overwrite malformed or inaccessible ownership storage. */ }
}
export function disposeMessageRestore(identity: MessageRestoreIdentity): void {
  active.delete(key(identity));
  // Keep cleanup authority through reload; if storage fails, retain the live in-memory job.
  try { write(read().map(row => key(row) === key(identity) ? { ...row, cleanup: true } : row)); } catch { /* Retry the captured exact operation without overwriting unknown data. */ }
  queue(identity); flushComposerAttachmentReleases();
}
export async function restoreLocalMessageDraft(input: Pick<MessageRestoreIdentity, 'sessionId' | 'messageIndex' | 'revision'>,
  isEffective: () => boolean, signal?: AbortSignal): Promise<{ result: unknown; identity: MessageRestoreIdentity }> {
  if (!isEffective() || signal?.aborted) throw new Error('History editor is inactive');
  recoverMessageRestoreCleanup();
  const rows = read();
  const previous = rows.find(row => !row.cleanup && row.sessionId === input.sessionId
    && row.messageIndex === input.messageIndex);
  let identity: MessageRestoreIdentity;
  if (previous) {
    const { cleanup: _cleanup, ...original } = previous;
    identity = original;
  } else {
    const epoch = await requestMutation('POST', '/api/composer/attachments/restore-epoch', { session_id: input.sessionId }, signal, isEffective) as Record<string, unknown>;
    if (epoch.sessionId !== input.sessionId || typeof epoch.root !== 'string' || !epoch.root
      || !Number.isSafeInteger(epoch.restoreEpoch) || Number(epoch.restoreEpoch) < 0) throw new Error('Invalid history restore epoch');
    if (!isEffective() || signal?.aborted) throw new Error('History editor is inactive');
    identity = { ...input, root: epoch.root, restoreEpoch: Number(epoch.restoreEpoch), restoreId: crypto.randomUUID().replaceAll('-', '') };
  }
  if (!valid({ ...identity, cleanup: false })) throw new Error('Invalid history restore identity');
  if (active.has(key(identity))) throw new Error('This history restore is already owned by an open editor');
  if (!previous) {
    if (rows.length >= LIMIT) throw new Error('History restore cleanup capacity exhausted');
    // Persist before restore admission; epoch acquisition never allocates attachments.
    const latest = read();
    if (latest.length >= LIMIT) throw new Error('History restore cleanup capacity exhausted');
    if (latest.some(row => !row.cleanup && row.sessionId === input.sessionId && row.messageIndex === input.messageIndex)) throw new Error('This history restore is already owned by an open editor');
    write([...latest, { ...identity, cleanup: false }]);
  }
  active.add(key(identity));
  const cancel = () => disposeMessageRestore(identity);
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    let result: unknown;
    try {
      if (previous) throw new Error('Query original history restore');
      result = await requestMutation('POST', '/api/composer/attachments/restore', body(identity), signal, isEffective);
    } catch (error) {
      if (!isEffective() || signal?.aborted) throw error;
      const status = receipt(await requestMutation('POST', '/api/composer/attachments/restore-status', body(identity), signal, isEffective), identity);
      if (status.status !== 'committed' || !status.result || typeof status.result !== 'object'
          || (status.result as Record<string, unknown>).root !== status.root) throw new Error('Original history restore is unresolved');
      result = status.result;
    }
    if (!isEffective() || signal?.aborted) throw new Error('History editor is inactive');
    if (!result || typeof result !== 'object' || (result as Record<string, unknown>).root !== identity.root) throw new Error('Restore result root changed');
    return { result: previous && previous.revision !== input.revision ? undefined : result, identity };
  } catch (error) {
    if (previous && isEffective() && !signal?.aborted) {
      // A retained/cloned operation is query-only. Keep its draft and show unavailable until explicit cancellation.
      return { result: undefined, identity };
    }
    cancel(); throw error;
  }
  finally { signal?.removeEventListener('abort', cancel); }
}
subscribeComposerAttachmentLifecycle(() => {
  if (isComposerAttachmentLifecycleEnabled()) recoverMessageRestoreCleanup();
});
recoverMessageRestoreCleanup();
