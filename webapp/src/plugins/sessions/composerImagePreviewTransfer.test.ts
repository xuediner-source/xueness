import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { collectImagePreview, withPreviewDeadline } from './composerImagePreviewTransfer';
import { loadAttachmentPreview } from './composerAttachmentPreviewDialog';
const chunkBytes = 262144;
const size = 3 * 1024 * 1024 + 3;
const digest = createHash('sha256');
for (let index = 0; index < Math.ceil(size / chunkBytes); index++) digest.update(Buffer.alloc(Math.min(chunkBytes, size - index * chunkBytes), index));
const sha256 = digest.digest('hex');
function chunk(index: number) {
  return { schema: 'xueness.image-preview-chunk.v1', id: 'a'.repeat(32), name: 'large.png', mimeType: 'image/png',
    size, kind: 'image', truncated: false, sha256, chunkIndex: index, chunkBytes,
    totalChunks: Math.ceil(size / chunkBytes), data: Buffer.alloc(Math.min(chunkBytes, size - index * chunkBytes), index).toString('base64') };
}
test('large preview collects sequential bounded chunks into a non-persisted Blob', async () => {
  const seen: number[] = [];
  const preview = await collectImagePreview(chunk(0), async index => { seen.push(index); return chunk(index); });
  assert.equal(preview.blob?.size, size);
  assert.equal(preview.blob?.type, 'image/png');
  assert.equal(preview.data, undefined);
  assert.deepEqual(seen, Array.from({length: 12}, (_, i) => i + 1));
  const bytes = new Uint8Array(await preview.blob!.arrayBuffer());
  assert.equal(bytes[chunkBytes], 1);
  assert.equal(bytes[size - 1], 12);
});
test('fragment parser rejects excessive sizes, indexes, urls and changing identity', async () => {
  for (const patch of [{size: 20 * 1024 * 1024 + 1}, {chunkIndex: 1}, {data: 'a'}, {url: 'https://example.test'}, {mimeType: 'image/svg+xml'}]) {
    let calls = 0;
    await assert.rejects(collectImagePreview({...chunk(0), ...patch}, async () => {calls++; return chunk(1);}));
    assert.equal(calls, 0);
  }
  for (const patch of [{id: 'c'.repeat(32)}, {sha256: 'd'.repeat(64)}, {name: 'changed.png'}, {size: size + 1}]) {
    await assert.rejects(collectImagePreview(chunk(0), async index => ({...chunk(index), ...patch})));
  }
});
test('abort prevents the next authorized read and does not return partial media', async () => {
  const controller = new AbortController();
  let reads = 0;
  await assert.rejects(collectImagePreview(chunk(0), async index => {
    reads++; controller.abort(); return chunk(index);
  }, controller.signal), /abort/i);
  assert.equal(reads, 1);
});
test('injected remote preview reads every chunk without falling back to local HTTP', async () => {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('local HTTP must not be called'); };
  try {
    const indexes: (number | undefined)[] = [];
    const ref = {id: 'a'.repeat(32), name: 'large.png', mimeType: 'image/png', size, origin: 'file' as const,
      remoteOwner: {connectionId: 'remote', digest: 'digest', workspaceIdentity: '/ws', root: '/ws', sessionId: 's', draftKey: 'd'}};
    const preview = await loadAttachmentPreview({enabled: true, root: '/ws', id: ref.id, attachmentRef: ref,
      previewTransport: async (selected, signal, index) => {
        assert.equal(selected, ref); indexes.push(index); return {preview: chunk(index ?? 0)};
      }});
    assert.equal(preview.blob?.size, size);
    assert.equal(indexes.length, 13);
    await assert.rejects(loadAttachmentPreview({enabled: true, root: '/ws', id: ref.id, attachmentRef: ref}), /remote preview/);
  } finally {globalThis.fetch = oldFetch;}
});

test('assembled bytes must match the pinned digest, even if every chunk claims the same digest', async () => {
  await assert.rejects(collectImagePreview({...chunk(0), sha256: 'e'.repeat(64)}, async index =>
    ({...chunk(index), sha256: 'e'.repeat(64)})), /checksum mismatch/);
});
test('noncooperative pending reads reject on cancellation and total deadline', async () => {
  const controller = new AbortController();
  const pending = collectImagePreview(chunk(0), async () => new Promise(() => {}), controller.signal);
  controller.abort();
  await assert.rejects(pending, /abort/i);
  let received: AbortSignal | undefined;
  await assert.rejects(withPreviewDeadline(async signal => {
    received = signal; return new Promise(() => {});
  }, undefined, 10), /timed out/);
  assert.equal(received?.aborted, true);
});
test('first response body cannot hold the preview open after abort', async () => {
  const controller = new AbortController();
  const ref = {id: 'a'.repeat(32), name: 'large.png', mimeType: 'image/png', size, origin: 'file' as const};
  const pending = loadAttachmentPreview({enabled: true, root: '/ws', id: ref.id, attachmentRef: ref,
    previewTransport: async () => new Promise(() => {})}, controller.signal);
  controller.abort();
  await assert.rejects(pending, /abort/i);
});
test('cancellation during digest never publishes the verified image', async t => {
  const controller = new AbortController();
  const original = crypto.subtle.digest.bind(crypto.subtle);
  t.mock.method(crypto.subtle, 'digest', async (algorithm: AlgorithmIdentifier, bytes: BufferSource) => {
    const result = await original(algorithm, bytes);
    controller.abort();
    return result;
  });
  await assert.rejects(collectImagePreview(chunk(0), async index => chunk(index), controller.signal), /abort/i);
});
