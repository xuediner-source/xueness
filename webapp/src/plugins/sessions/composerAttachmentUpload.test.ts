import { setComposerAttachmentLifecycleEnabled } from './composerAttachmentLifecycle';
import test from "node:test";
import assert from "node:assert/strict";
import { ATTACHMENT_CHUNK_BYTES, uploadComposerAttachment, type UploadInput, type UploadTransport } from "./composerAttachmentUpload";
import { ComposerAttachmentUploadStore, getComposerAttachmentUploadStore } from "./composerAttachmentUploadStore";
import type { AttachmentRef } from "./composerAttachmentRef";

const owner = { root: "/ws", draftKey: "root:/ws?route=1" };
const file = (size = 10, name = "image.png") => new File([new Uint8Array(size)], name, { type: "image/png" });
const ref = (f: File, id = "a".repeat(32)): AttachmentRef => ({ id, token: id, name: f.name, size: f.size, mimeType: f.type, origin: "file", source: "upload" });
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));

function fixture(f: File, mutate?: (operation: string, value: Record<string, unknown>) => unknown) {
  const calls: { operation: string; body: Record<string, unknown> }[] = [];
  let next = 0;
  const transport: UploadTransport = async <T>(path: string, raw: object) => {
    const operation = path.split("/").pop()!;
    const body = raw as Record<string, unknown>;
    calls.push({ operation, body });
    if (operation === "chunk") next = Number(body.chunkIndex) + 1;
    const value = operation === "commit" ? { ref: ref(f), status: "committed" }
      : { ref: ref(f), status: "pending", nextChunkIndex: next, uploadedBytes: Math.min(next * ATTACHMENT_CHUNK_BYTES, f.size) };
    return (mutate ? mutate(operation, value) : value) as T;
  };
  return { calls, transport };
}
function input(f: File, transport: UploadTransport): UploadInput {
  return { owner, file: f, origin: "file", uploadId: "fixed-upload", signal: new AbortController().signal, isCurrent: () => true, transport };
}

test("large attachment uses bounded chunks, hashed draft identity and reference-only commit", async () => {
  const f = file(900000);
  const { calls, transport } = fixture(f);
  const progress: number[] = [];
  assert.deepEqual(await uploadComposerAttachment({ ...input(f, transport), onProgress: p => progress.push(p.uploadedBytes) }), ref(f));
  assert.deepEqual(calls.map(call => call.operation), ["begin", "chunk", "chunk", "chunk", "commit"]);
  assert.match(String(calls[0].body.draftId), /^[a-f0-9]{64}$/);
  assert.match(String(calls[0].body.checksum), /^sha256:[a-f0-9]{64}$/);
  assert.equal(calls[0].body.totalChunks, 3);
  for (const call of calls.filter(call => call.operation === "chunk")) assert.ok(JSON.stringify(call.body).length < 600000);
  assert.equal("data" in calls.at(-1)!.body, false);
  assert.deepEqual(progress, [0, 393216, 786432, 900000]);
});

test("empty file commits without a chunk", async () => {
  const f = file(0); const { calls, transport } = fixture(f);
  await uploadComposerAttachment(input(f, transport));
  assert.deepEqual(calls.map(call => call.operation), ["begin", "commit"]);
});

test("network retry retransmits identical mutation without changing upload identity", async () => {
  const f = file(); const { transport, calls } = fixture(f);
  let once = true;
  const retry: UploadTransport = async <T>(path: string, body: object, signal?: AbortSignal) => {
    const result = await transport<T>(path, body, signal);
    if (once) { once = false; throw new TypeError("network lost after begin"); }
    return result;
  };
  await uploadComposerAttachment(input(f, retry));
  assert.deepEqual(calls[0], calls[1]);
});

test("strict progress and commit identity validation reject untrusted responses", async () => {
  for (const mutation of [
    (op: string, value: Record<string, unknown>) => op === "chunk" ? { ...value, uploadedBytes: 0 } : value,
    (op: string, value: Record<string, unknown>) => op === "commit" ? { ...value, ref: ref(file(), "b".repeat(32)) } : value,
    (op: string, value: Record<string, unknown>) => op === "begin" ? { ...value, nextChunkIndex: -1 } : value,
  ]) {
    const f = file(); const { transport } = fixture(f, mutation);
    await assert.rejects(uploadComposerAttachment(input(f, transport)), /Invalid attachment/);
  }
});

test("owner invalidation during hashing/begin prevents further requests", async () => {
  const f = file(); const { transport, calls } = fixture(f);
  let current = true;
  const wrapped: UploadTransport = async <T>(path: string, body: object, signal?: AbortSignal) => {
    const result = await transport<T>(path, body, signal); current = false; return result;
  };
  await assert.rejects(uploadComposerAttachment({ ...input(f, wrapped), isCurrent: () => current }), /owner changed/);
  assert.equal(calls.length, 1);
});

test("two active uploads, third queued; selection order and commit-only 100 percent", async () => {
  const pending: { input: UploadInput; resolve: (value: AttachmentRef) => void }[] = [];
  const store = new ComposerAttachmentUploadStore(owner, { upload: i => new Promise(resolve => pending.push({ input: i, resolve })) });
  store.setContext({ enabled: true, generation: 1 });
  store.enqueue([file(), file(), file()]);
  assert.deepEqual(store.getSnapshot().map(i => i.state), ["uploading", "uploading", "queued"]);
  assert.equal(store.hasUnready(), true);
  pending[0].input.onProgress?.({ ref: ref(pending[0].input.file), status: "pending", nextChunkIndex: 1, uploadedBytes: 10 });
  assert.equal(store.getSnapshot()[0].progress, 99);
  assert.deepEqual(store.readyAttachments(), []);
  pending[1].resolve(ref(pending[1].input.file, "b".repeat(32))); await settle();
  assert.equal(pending.length, 3);
  assert.deepEqual(store.getSnapshot().map(i => i.state), ["uploading", "ready", "uploading"]);
  pending[0].resolve(ref(pending[0].input.file)); pending[2].resolve(ref(pending[2].input.file, "c".repeat(32))); await settle();
  assert.equal(store.hasUnready(), false);
  assert.deepEqual(store.readyAttachments().map(i => i.ref!.id), ["a".repeat(32), "b".repeat(32), "c".repeat(32)]);
  assert.ok(store.getSnapshot().every(i => i.progress === 100));
});

test("disable aborts current work, never starts queued work or cleanup; explicit retry retains identity", async () => {
  const uploads: UploadInput[] = [];
  const store = new ComposerAttachmentUploadStore(owner, { upload: async i => {
    uploads.push(i);
    await new Promise<void>((_, reject) => i.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    return ref(i.file);
  } });
  store.setContext({ enabled: true, generation: 1 }); store.enqueue([file(), file(), file()]);
  store.setContext({ enabled: false, generation: 2 }); await settle();
  assert.ok(uploads.every(i => i.signal.aborted));
  assert.equal(uploads.length, 2);
  assert.ok(store.getSnapshot().every(i => i.state === "failed"));
  store.setContext({ enabled: true, generation: 2 });
  store.retry(store.getSnapshot()[0].id);
  assert.equal(uploads[2].uploadId, uploads[0].uploadId);
  store.invalidate(); await settle();
});

test("failed upload cannot become inline data; remount retains store and committed removal never releases", async () => {
  const store = new ComposerAttachmentUploadStore(owner, { upload: async () => { throw new Error("offline"); } });
  store.setContext({ enabled: true, generation: 1 }); store.enqueue([file()]); await settle();
  assert.equal(store.getSnapshot()[0].state, "failed"); assert.equal(store.hasUnready(), true);
  assert.deepEqual(store.readyAttachments(), []);
  assert.ok(store.getFile(store.getSnapshot()[0].id));
  assert.equal(getComposerAttachmentUploadStore(owner), getComposerAttachmentUploadStore({ ...owner }));
  let calls = 0;
  const ready = new ComposerAttachmentUploadStore(owner, { transport: async <T>() => { calls++; return {} as T; } });
  ready.setContext({ enabled: true, generation: 1 }); ready.syncReadyRefs([ref(file())]); ready.remove(ready.getSnapshot()[0].id);
  assert.equal(calls, 0);
});

test("cancellation at begin, chunk and commit never publishes or sends another request", async () => {
  for (const phase of ["begin", "chunk", "commit"]) {
    const f = file(); const { calls, transport } = fixture(f);
    const controller = new AbortController();
    const wrapped: UploadTransport = async <T>(path: string, body: object, signal?: AbortSignal) => {
      const value = await transport<T>(path, body, signal);
      if (path.endsWith(`/${phase}`)) controller.abort();
      return value;
    };
    await assert.rejects(uploadComposerAttachment({ ...input(f, wrapped), signal: controller.signal }), { name: "AbortError" });
    assert.equal(calls.at(-1)!.operation, phase);
  }
});

test("begin replay of a committed upload returns without another mutation", async () => {
  const f = file(); const { calls, transport } = fixture(f, (_op, value) => ({ ...value, status: "committed", nextChunkIndex: 1, uploadedBytes: 10 }));
  assert.deepEqual(await uploadComposerAttachment(input(f, transport)), ref(f));
  assert.deepEqual(calls.map(call => call.operation), ["begin"]);
});

test("failed request retries are bounded and server errors are not blindly retried", async () => {
  for (const [error, expected] of [[new TypeError("offline"), 2], [new Error("HTTP 409"), 1]] as const) {
    let calls = 0;
    const transport: UploadTransport = async () => { calls++; throw error; };
    await assert.rejects(uploadComposerAttachment(input(file(), transport)), error);
    assert.equal(calls, expected);
  }
});

test("remove cancels uploading item and aborts pending token, never releases a committed reference", async () => {
  setComposerAttachmentLifecycleEnabled(true);
  const requests: string[] = [];
  const store = new ComposerAttachmentUploadStore(owner, {
    transport: async <T>(path: string) => { requests.push(path); return { ok: true, status: "aborted" } as T; },
    upload: async i => {
      i.onProgress?.({ ref: ref(i.file), status: "pending", nextChunkIndex: 0, uploadedBytes: 0 });
      await new Promise<void>((_, reject) => i.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
      return ref(i.file);
    },
  });
  store.setDisposalGuard(() => false);
  store.setContext({ enabled: true, generation: 1 }); store.enqueue([file()]);
  store.remove(store.getSnapshot()[0].id); await settle();
  assert.deepEqual(store.getSnapshot(), []);
  assert.deepEqual(requests, ["/api/composer/attachments/abort"]);
});

test("durable selection limits include existing committed refs and text cap", () => {
  const store = new ComposerAttachmentUploadStore(owner, { upload: async () => new Promise(() => {}) });
  store.setContext({ enabled: true, generation: 1 });
  const tooLargeText = new File([new Uint8Array(65537)], "large.txt", { type: "text/plain" });
  assert.equal(store.enqueue([tooLargeText]).accepted, 0);
  store.syncReadyRefs([1, 2, 3].map(i => ref(file(20 * 1024 * 1024), String(i).repeat(32))));
  assert.equal(store.enqueue([file(4 * 1024 * 1024), file(1)]).accepted, 1);
  store.invalidate();
});

test("never-resolving response has a bounded deadline and exact bounded retry", async () => {
  const calls: { body: object; signal?: AbortSignal }[] = [];
  const transport: UploadTransport = async (_path, body, signal) => {
    calls.push({ body, signal }); return new Promise(() => {});
  };
  await assert.rejects(uploadComposerAttachment({ ...input(file(), transport), requestTimeoutMs: 5 }), { name: "TimeoutError" });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].body, calls[1].body);
  assert.ok(calls.every(call => call.signal?.aborted));
});

test("abort settles noncooperative transport immediately and late response cannot publish", async () => {
  let resolveResponse: ((value: unknown) => void) | undefined;
  let started!: () => void;
  const beginning = new Promise<void>(resolve => { started = resolve; });
  let progress = 0;
  const f = file(); const controller = new AbortController();
  const transport: UploadTransport = async <T>() => {
    started(); return new Promise<unknown>(resolve => { resolveResponse = resolve; }) as Promise<T>;
  };
  const uploading = uploadComposerAttachment({ ...input(f, transport), signal: controller.signal, onProgress: () => { progress++; } });
  await beginning; controller.abort();
  await assert.rejects(uploading, { name: "AbortError" });
  resolveResponse?.({ ref: ref(f), status: "committed", nextChunkIndex: 1, uploadedBytes: 10 });
  await settle(); assert.equal(progress, 0);
});

test("timeouts free both scheduler slots and queued work can finish", async () => {
  let started = 0;
  const store = new ComposerAttachmentUploadStore(owner, { upload: i => {
    started++;
    if (started > 2) return Promise.resolve(ref(i.file));
    return uploadComposerAttachment({ ...i, requestTimeoutMs: 5, transport: async () => new Promise(() => {}) });
  } });
  store.setContext({ enabled: true, generation: 1 }); store.enqueue([file(), file(), file()]);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { stop(); reject(new Error("scheduler remained pinned")); }, 1000);
    const stop = store.subscribe(() => {
      if (store.getSnapshot()[2].state === "ready" && store.getSnapshot().every(item => item.state !== "uploading")) { clearTimeout(timer); stop(); resolve(); }
    });
  });
  assert.deepEqual(store.getSnapshot().map(item => item.state), ["failed", "failed", "ready"]);
});

test("invalidate frees scheduler slots even when transport ignores AbortSignal", async () => {
  let started = 0;
  let notify!: () => void;
  const beginning = new Promise<void>(resolve => { notify = resolve; });
  const store = new ComposerAttachmentUploadStore(owner, { transport: async () => {
    started++; if (started === 2) notify(); return new Promise(() => {});
  } });
  store.setContext({ enabled: true, generation: 1 }); store.enqueue([file(), file(), file()]);
  await beginning; store.invalidate(); await settle();
  const ids = store.getSnapshot().map(item => item.id);
  for (const id of ids) store.remove(id);
  store.setContext({ enabled: true, generation: 2 }); store.enqueue([file()]);
  await settle(); await settle();
  assert.equal(started, 3);
  store.invalidate(); await settle();
});

test("cache only evicts disabled empty unobserved stores, retaining observers and refs", () => {
  const emptyOwner = { ...owner, draftKey: "eviction-empty" };
  const empty = getComposerAttachmentUploadStore(emptyOwner);
  empty.setContext({ enabled: true, generation: 1 }); empty.invalidate();
  assert.notEqual(getComposerAttachmentUploadStore(emptyOwner), empty);
  const observedOwner = { ...owner, draftKey: "eviction-observed" };
  const observed = getComposerAttachmentUploadStore(observedOwner);
  const stop = observed.subscribe(() => {});
  observed.setContext({ enabled: true, generation: 1 }); observed.invalidate();
  assert.equal(getComposerAttachmentUploadStore(observedOwner), observed);
  stop(); assert.notEqual(getComposerAttachmentUploadStore(observedOwner), observed);
  const retainedOwner = { ...owner, draftKey: "eviction-ref" };
  const retained = getComposerAttachmentUploadStore(retainedOwner);
  retained.syncReadyRefs([ref(file())]); retained.setContext({ enabled: true, generation: 1 }); retained.invalidate();
  assert.equal(getComposerAttachmentUploadStore(retainedOwner), retained);
});

test("eight transaction images prepare only committed ids and retain compact persisted refs", async () => {
  const { attachmentPayloadForSend, attachmentsFromRefs, persistedAttachmentFields, parseStoredAttachmentRefs } = await import('./composerAttachmentRef');
  const refs: AttachmentRef[] = [];
  for (let i = 0; i < 8; i++) {
    const f = file(i === 0 ? 3 * 1024 * 1024 : 32);
    const expected = ref(f, String(i).repeat(32));
    const mock = fixture(f, (_operation, value) => ({ ...value, ref: expected }));
    refs.push(await uploadComposerAttachment(input(f, mock.transport)));
    assert.ok(mock.calls.filter(call => call.operation === 'chunk').every(call => JSON.stringify(call.body).length < 600000));
    assert.equal('data' in mock.calls.at(-1)!.body, false);
  }
  const attachments = attachmentsFromRefs(refs);
  const payload = attachmentPayloadForSend(attachments, true);
  assert.deepEqual(payload, { attachments: [], attachmentRefs: refs.map(({ id }) => ({ id })) });
  const fields = persistedAttachmentFields(attachments);
  assert.equal(parseStoredAttachmentRefs(fields.attachmentRefs).length, 8);
  assert.ok(JSON.stringify(fields).length < 3000);
  assert.ok(JSON.stringify(payload).length < 500);
});

test("quota policy rejects ninth image and preserves non-image limits", () => {
  const store = new ComposerAttachmentUploadStore(owner, { upload: async () => new Promise(() => {}) });
  store.setContext({ enabled: true, generation: 1 });
  assert.equal(store.enqueue(Array.from({ length: 8 }, () => file(1))).accepted, 8);
  assert.match(store.enqueue([file(1)]).rejected[0], /8 total/);
  store.invalidate();
  const other = new ComposerAttachmentUploadStore(owner, { upload: async () => new Promise(() => {}) });
  other.setContext({ enabled: true, generation: 1 });
  const pdf = (size: number) => new File([new Uint8Array(size)], 'doc.pdf', { type: 'application/pdf' });
  assert.equal(other.enqueue([pdf(2 * 1024 * 1024 + 1)]).accepted, 0);
  assert.equal(other.enqueue([pdf(2 * 1024 * 1024), pdf(2 * 1024 * 1024), pdf(1)]).accepted, 2);
  assert.equal(other.enqueue([file(20 * 1024 * 1024 + 1)]).accepted, 0);
  other.invalidate();
});

test("default HTTP transport uploads eight images and prepares a byte-free selection", async () => {
  const { prepareComposer } = await import('../../xuenessComposer');
  const { attachmentPayloadForSend, attachmentsFromRefs } = await import('./composerAttachmentRef');
  const previous = globalThis.fetch;
  const refs: AttachmentRef[] = [];
  const records = new Map<string, { ref: AttachmentRef; next: number; bytes: number }>();
  let prepareBody: Record<string, unknown> | undefined;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url);
    if (path === '/api/csrf') return new Response(JSON.stringify({ csrfToken: 'fixture' }));
    const body = JSON.parse(String(init?.body));
    let response: unknown;
    if (path.endsWith('/begin')) {
      const id = String(records.size).repeat(32);
      const record = { ref: { id, token: id, name: body.name, size: body.size, mimeType: body.mimeType, origin: body.origin, source: 'upload' as const }, next: 0, bytes: 0 };
      records.set(id, record);
      response = { ref: record.ref, status: 'pending', nextChunkIndex: 0, uploadedBytes: 0 };
    } else if (path.endsWith('/chunk')) {
      assert.ok(String(init?.body).length < 600000);
      const record = records.get(body.id)!;
      assert.equal(body.chunkIndex, record.next);
      record.next++; record.bytes += Buffer.from(body.data, 'base64').length;
      response = { ref: record.ref, status: 'pending', nextChunkIndex: record.next, uploadedBytes: record.bytes };
    } else if (path.endsWith('/commit')) {
      assert.equal('data' in body, false);
      const record = records.get(body.id)!;
      assert.equal(record.bytes, record.ref.size);
      response = { ref: record.ref, status: 'committed' };
    } else if (path === '/api/composer/prepare') {
      prepareBody = body; response = { token: 'prepared', text: 'prompt' };
    } else throw new Error(`Unexpected request ${path}`);
    return new Response(JSON.stringify(response));
  }) as typeof fetch;
  try {
    for (let i = 0; i < 8; i++) refs.push(await uploadComposerAttachment({ owner, file: file(i === 0 ? 3 * 1024 * 1024 : 16), origin: 'file', uploadId: `http-${i}`, signal: new AbortController().signal, isCurrent: () => true }));
    await prepareComposer('prompt', { ...attachmentPayloadForSend(attachmentsFromRefs(refs), true), files: [], sessions: [], skills: [], plugins: [], goal: false }, { root: owner.root });
    assert.deepEqual((prepareBody?.input as Record<string, unknown>)?.attachmentRefs, refs.map(({ id }) => ({ id })));
    assert.deepEqual((prepareBody?.input as Record<string, unknown>)?.attachments, []);
    assert.ok(JSON.stringify(prepareBody).length < 750);
  } finally { globalThis.fetch = previous; }
});
