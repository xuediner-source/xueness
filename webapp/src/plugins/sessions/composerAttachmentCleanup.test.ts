import test from 'node:test';
import assert from 'node:assert/strict';
import { deferComposerAttachmentAbort, deferComposerAttachmentRelease, flushComposerAttachmentReleases } from './composerAttachmentCleanup';
import { setComposerAttachmentLifecycleEnabled } from './composerAttachmentLifecycle';
import type { UploadTransport } from './composerAttachmentUpload';
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const owner = { root: '/workspace', draftKey: 'draft' };
const ref = (id: string) => ({ id, token: id, name: 'a.png', size: 3, origin: 'file', mimeType: 'image/png' });
test('accepted disposal ignores editor admission but defers across actual feature disable', async () => {
  const calls: string[] = [];
  const transport: UploadTransport = async <T>(path: string) => { calls.push(path); return {} as T; };
  setComposerAttachmentLifecycleEnabled(false);
  deferComposerAttachmentRelease(owner, '1'.repeat(32), () => false, transport);
  await settle(); assert.deepEqual(calls, []);
  setComposerAttachmentLifecycleEnabled(true); await settle();
  assert.deepEqual(calls, ['/api/composer/attachments/release']);
});
test('cancel after commit reconciles exact token then explicitly releases only unowned reference', async () => {
  const calls: string[] = []; const id = '2'.repeat(32);
  const transport: UploadTransport = async <T>(path: string) => {
    calls.push(path); return (path.endsWith('/abort') ? { status: 'committed', ref: ref(id) } : {}) as T;
  };
  deferComposerAttachmentAbort(owner, id, () => false, transport); await settle();
  assert.deepEqual(calls, ['/api/composer/attachments/abort', '/api/composer/attachments/release']);
});
test('uncertain cancellation remains retryable and recovery ownership prevents release', async () => {
  let owned = false; let attempts = 0; const calls: string[] = []; const id = '3'.repeat(32);
  const transport: UploadTransport = async <T>(path: string) => {
    calls.push(path); if (++attempts === 1) throw new TypeError('lost response');
    owned = true; return { status: 'committed', ref: ref(id) } as T;
  };
  deferComposerAttachmentAbort(owner, id, () => owned, transport); await settle();
  flushComposerAttachmentReleases(); await settle();
  assert.deepEqual(calls, ['/api/composer/attachments/abort', '/api/composer/attachments/abort']);
  setComposerAttachmentLifecycleEnabled(false);
});
