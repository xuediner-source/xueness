import type { RemoteAttachmentEndpoint } from './composerAttachmentRef';
import { post } from '../../xuenessApi';
import { abortComposerAttachment, boundedRequest, type UploadOwner, type UploadTransport } from './composerAttachmentUpload';
import { isComposerAttachmentLifecycleEnabled, subscribeComposerAttachmentLifecycle } from './composerAttachmentLifecycle';

type Owner = { root: string; sessionId?: string; remote?: RemoteAttachmentEndpoint; draftId?: string; draftKey?: string };
type Job = { owner: Owner; id: string; isOwned: () => boolean; controller?: AbortController; abortOwner?: UploadOwner; transport?: UploadTransport };
const jobs = new Map<string, Job>();
let retry: ReturnType<typeof setTimeout> | undefined;
/** Disposal intent survives UI busy state, navigation and feature suspension. */
export function deferComposerAttachmentRelease(owner: Owner, id: string, isOwned: () => boolean, transport?: UploadTransport): void {
  const key = JSON.stringify([owner.root, owner.sessionId ?? null, owner.remote ?? null, owner.draftId ?? owner.draftKey ?? null, id]);
  if (!jobs.has(key)) jobs.set(key, { owner: { ...owner }, id, isOwned, transport });
  flushComposerAttachmentReleases();
}
/** Cancel intent is retained even when abort's response or commit's response is lost. */
export function deferComposerAttachmentAbort(owner: UploadOwner, id: string, isOwned: () => boolean, transport?: UploadTransport): void {
  const key = JSON.stringify([owner.root, owner.sessionId ?? null, owner.remote ?? null, owner.draftKey, id]);
  if (!jobs.has(key)) jobs.set(key, { owner: { ...owner }, abortOwner: { ...owner }, id, isOwned, transport });
  flushComposerAttachmentReleases();
}
export function flushComposerAttachmentReleases(): void {
  if (!isComposerAttachmentLifecycleEnabled()) return;
  for (const [key, job] of jobs) {
    if (job.controller || job.isOwned() || (job.owner.remote && !job.transport)) continue;
    const controller = new AbortController(); job.controller = controller;
    const timeout = setTimeout(() => controller.abort(), 15_000);
    void (async () => {
      if (job.abortOwner) {
        const committed = await abortComposerAttachment(job.abortOwner, job.id, controller.signal, job.transport);
        if (!committed) { jobs.delete(key); return; }
        job.abortOwner = undefined;
      }
      if (!isComposerAttachmentLifecycleEnabled() || job.isOwned()) return;
      await boundedRequest(job.transport ?? post, '/api/composer/attachments/release', { root: job.owner.root,
        ...(job.owner.sessionId ? { session_id: job.owner.sessionId } : {}), id: job.id }, controller.signal);
      jobs.delete(key);
    })()
      .catch(() => undefined)
      .finally(() => {
        clearTimeout(timeout); job.controller = undefined;
        if (jobs.size && isComposerAttachmentLifecycleEnabled() && !retry) {
          retry = setTimeout(() => { retry = undefined; flushComposerAttachmentReleases(); }, 30_000);
          // Node tests should not be held open by a browser background cleanup.
          (retry as unknown as { unref?: () => void }).unref?.();
        }
      });
  }
}
subscribeComposerAttachmentLifecycle(() => {
  if (isComposerAttachmentLifecycleEnabled()) flushComposerAttachmentReleases();
  else {
    if (retry) clearTimeout(retry); retry = undefined;
    for (const job of jobs.values()) job.controller?.abort();
  }
});
