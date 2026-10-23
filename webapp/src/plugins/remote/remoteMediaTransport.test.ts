import test from 'node:test';
import assert from 'node:assert/strict';
import { createRemoteMediaTransport, validateRemoteMediaRefs } from './remoteMediaTransport';
import { uploadComposerAttachment, canonicalUploadOwner } from '../sessions/composerAttachmentUpload';
import { persistedAttachmentFields, parseStoredAttachmentRefs } from '../sessions/composerAttachmentRef';
import { canRequestAttachmentPreview } from '../sessions/composerAttachmentPreviewModel';
const endpoint = { connectionId: 'ssh-a', digest: 'config-v1', workspaceIdentity: 'remote-ws' };
const owner = { root: 'remote-ws', sessionId: 'same-session', draftKey: 'stable-draft', remote: endpoint };
const file = new File([new Uint8Array(700000)], 'photo.png', { type: 'image/png' });
const ref = { id: 'a'.repeat(32), token: 'a'.repeat(32), name: file.name, mimeType: file.type, size: file.size, origin: 'file' as const, source: 'upload' as const };
function fixture(drop: string[] = []) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  let next = 0, committed = false;
  const progress = () => ({ ref, status: committed ? 'committed' : 'pending', nextChunkIndex: next, uploadedBytes: Math.min(next * 262144, file.size) });
  const transport = createRemoteMediaTransport(endpoint, async (method, params) => {
    calls.push({ method, params });
    const p = params.payload as Record<string, unknown>;
    assert.equal(params.sessionId, owner.sessionId);
    assert.equal('root' in p, false); assert.equal('session_id' in p, false);
    if (method === 'media/begin') { assert.equal(p.chunkBytes, 262144); assert.equal(p.totalChunks, 3); }
    if (method === 'media/chunk') next = Number(p.chunkIndex) + 1;
    if (method === 'media/commit') committed = true;
    if (drop.includes(method)) { drop.splice(drop.indexOf(method), 1); throw new TypeError('lost response body'); }
    return progress();
  });
  return { transport, calls };
}
const upload = (transport: ReturnType<typeof createRemoteMediaTransport>) => uploadComposerAttachment({ owner, file, origin: 'file', uploadId: 'tx-stable', signal: new AbortController().signal, isCurrent: () => true, transport });
test('remote chunks and commit recover lost responses via same transaction status; bytes never persist', async () => {
  const f = fixture(['media/chunk', 'media/commit']);
  const result = await upload(f.transport);
  assert.equal(f.calls.filter(c => c.method === 'media/status').length, 2);
  assert.equal(f.calls.filter(c => c.method === 'media/begin').length, 1);
  assert.deepEqual(result.remoteOwner, { ...endpoint, root: owner.root, sessionId: owner.sessionId, draftKey: owner.draftKey });
  const fields = persistedAttachmentFields([{ name: result.name, mimeType: result.mimeType, data: '', ref: result }]);
  assert.equal(JSON.stringify(fields).includes('generation'), false);
  assert.equal(JSON.stringify(fields).includes('data'), false);
  assert.deepEqual(parseStoredAttachmentRefs(fields.attachmentRefs), [result]);
  assert.equal(canRequestAttachmentPreview(true, owner.root, { ref: result }), false);
});
test('exact resumption reuses begin upload identity and committed receipt', async () => {
  const f = fixture(); const first = await upload(f.transport); const second = await upload(f.transport);
  assert.deepEqual(first, second);
  assert.equal(f.calls.filter(c => c.method === 'media/chunk').length, 3);
  assert.equal(f.calls.filter(c => c.method === 'media/begin').every(c => (c.params.payload as Record<string, unknown>).uploadId === 'tx-stable'), true);
});
test('eight remote refs accepted; local same-session and changed endpoint/session/draft are refused', async () => {
  const result = await upload(fixture().transport);
  const refs = Array.from({ length: 8 }, (_, i) => ({ id: i.toString(16).repeat(32), remoteOwner: result.remoteOwner }));
  assert.equal(validateRemoteMediaRefs(refs, endpoint, owner.root, owner.sessionId).length, 8);
  assert.throws(() => validateRemoteMediaRefs([...refs, refs[0]], endpoint, owner.root, owner.sessionId));
  assert.throws(() => validateRemoteMediaRefs([{ id: ref.id }], endpoint, owner.root, owner.sessionId));
  for (const changed of [{ ...endpoint, digest: 'new-config' }, { ...endpoint, connectionId: 'ssh-b' }]) assert.throws(() => validateRemoteMediaRefs(refs, changed, owner.root, owner.sessionId));
  assert.throws(() => validateRemoteMediaRefs(refs, endpoint, owner.root, 'different-session'));
  assert.throws(() => validateRemoteMediaRefs([refs[0], { ...refs[1], remoteOwner: { ...result.remoteOwner!, draftKey: 'other' } }], endpoint, owner.root, owner.sessionId));
  assert.notEqual(canonicalUploadOwner(owner), canonicalUploadOwner({ ...owner, remote: undefined }));
});
test('remote transport rejects local roots and unsupported preview without a request', async () => {
  const f = fixture();
  await assert.rejects(f.transport('/api/composer/attachments/begin', { root: '/local', session_id: owner.sessionId }));
  await assert.rejects(f.transport('/api/composer/attachments/preview', { root: owner.root }));
  assert.equal(f.calls.length, 0);
});

test('manager endpoint uses exact live generation, resumes only same config, and strips prepare ownership metadata', async () => {
  const { RemoteSessionAdapter } = await import('./remoteSessionAdapter');
  const { remoteConnections } = await import('./remoteConnectionStore');
  const original = globalThis.fetch;
  const current = { connectionId: endpoint.connectionId, digest: endpoint.digest, workspaceIdentity: endpoint.workspaceIdentity,
    generation: 'g1', state: 'connected', capabilities: { stagedMedia: true, preparedMedia: true },
    limits: { maxChunkBytes: 262144, maxMediaFiles: 8, maxMediaFileBytes: 20971520, maxMediaSelectionBytes: 67108864 } };
  remoteConnections.publish(current, []);
  let enabled = true;
  const adapter = new RemoteSessionAdapter(current, () => enabled);
  const calls: Record<string, unknown>[] = [];
  globalThis.fetch = (async (path: string, init?: RequestInit) => {
    if (path === '/api/csrf') return new Response(JSON.stringify({ csrfToken: 'test' }));
    assert.equal(path, `/api/remote/${endpoint.connectionId}/request`);
    calls.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ status: 'released' }));
  }) as typeof fetch;
  try {
    const release = () => adapter.mediaTransport('/api/composer/attachments/release', { root: owner.root, session_id: owner.sessionId, id: ref.id });
    await release(); assert.equal(calls[0].expectedGeneration, 'g1');
    remoteConnections.publish({ ...current, generation: 'g2' }, []);
    await release(); assert.equal(calls[1].expectedGeneration, 'g2');
    const next = new RemoteSessionAdapter({ ...current, generation: 'g2' });
    const remoteOwner = { ...endpoint, root: owner.root, sessionId: owner.sessionId, draftKey: owner.draftKey };
    await next.prepare('hello', { attachments: [], attachmentRefs: [{ id: ref.id, remoteOwner }], files: [], sessions: [], skills: [], plugins: [], goal: false }, { root: owner.root, session_id: owner.sessionId });
    const params = calls[2].params as {payload: {input: {attachmentRefs: unknown[]}}};
    assert.deepEqual(params.payload.input.attachmentRefs, [{id: ref.id}]);
    enabled = false; await assert.rejects(release()); assert.equal(calls.length, 3);
    enabled = true; remoteConnections.publish({ ...current, digest: 'changed', generation: 'g3' }, []);
    await assert.rejects(release()); assert.equal(calls.length, 3);
    assert.equal(new RemoteSessionAdapter({ ...current, limits: {} }).mediaReady, false);
  } finally { globalThis.fetch = original; }
});

test('negotiated smaller media limits constrain uploader selection and chunk geometry', () => {
  const transport = createRemoteMediaTransport(endpoint, async () => ({}), { maxChunkBytes: 65536, maxMediaFiles: 2, maxMediaFileBytes: 1048576, maxMediaSelectionBytes: 2097152 });
  assert.equal(transport.chunkBytes, 65536);
  assert.deepEqual(transport.attachmentLimits, { count: 2, imageBytes: 1048576, totalBytes: 2097152 });
});

test('cleanup separates identical local and remote ids and never falls back without remote transport', async () => {
  const { deferComposerAttachmentRelease } = await import('../sessions/composerAttachmentCleanup');
  const { setComposerAttachmentLifecycleEnabled } = await import('../sessions/composerAttachmentLifecycle');
  const calls: string[] = [];
  const transport = (tag: string) => (async <T>() => { calls.push(tag); return {} as T; });
  setComposerAttachmentLifecycleEnabled(false);
  deferComposerAttachmentRelease({ root: owner.root, sessionId: owner.sessionId }, ref.id, () => false, transport('local'));
  deferComposerAttachmentRelease(owner, ref.id, () => false, transport('remote'));
  deferComposerAttachmentRelease({ ...owner, remote: { ...endpoint, connectionId: 'missing-transport' } }, ref.id, () => false);
  setComposerAttachmentLifecycleEnabled(true);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(calls.sort(), ['local', 'remote']);
  setComposerAttachmentLifecycleEnabled(false);
});
