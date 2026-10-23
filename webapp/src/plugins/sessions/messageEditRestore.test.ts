import test from 'node:test';
import assert from 'node:assert/strict';
import { MESSAGE_RESTORE_STORAGE_KEY, disposeMessageRestore, recoverMessageRestoreCleanup, restoreLocalMessageDraft, type MessageRestoreIdentity } from './messageEditRestore';
import { setComposerAttachmentLifecycleEnabled } from './composerAttachmentLifecycle';
import { flushComposerAttachmentReleases } from './composerAttachmentCleanup';
const storage = new Map<string, string>();
Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
} });
const input = { sessionId: 'session', messageIndex: 1, revision: `sha256:${'b'.repeat(64)}` };
const result = { root: '/workspace', text: 'private text stays out of storage', refs: [] };
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
function ack(body: Record<string, unknown>, status: string) {
  return { sessionId: body.session_id, root: '/workspace', restoreId: body.restoreId,
    restoreEpoch: body.restoreEpoch, messageIndex: body.messageIndex, revision: body.revision, status,
    ...(status === 'committed' ? { result } : {}), cleanupComplete: status === 'aborted' };
}

test('lost restore response queries exact persisted identity and never allocates another restore', async () => {
  const previous = globalThis.fetch; const calls: { path: string; body: Record<string, unknown> }[] = [];
  setComposerAttachmentLifecycleEnabled(false); storage.clear();
  globalThis.fetch = async (path, init) => {
    if (path === '/api/csrf') return Response.json({ csrfToken: 'fixture' });
    if (String(path).endsWith('/restore-epoch')) return Response.json({ sessionId: input.sessionId, root: '/workspace', restoreEpoch: 1 });
    const body = JSON.parse(String(init?.body)); calls.push({ path: String(path), body });
    assert.equal(JSON.parse(storage.get(MESSAGE_RESTORE_STORAGE_KEY)!)[0].restoreId, body.restoreId);
    if (String(path).endsWith('/restore')) throw new TypeError('lost committed restore response');
    return Response.json(ack(body, String(path).endsWith('restore-status') ? 'committed' : 'aborted'));
  };
  try {
    const restored = await restoreLocalMessageDraft(input, () => true);
    assert.deepEqual(restored.result, result);
    assert.deepEqual(calls.map(call => call.path), ['/api/composer/attachments/restore', '/api/composer/attachments/restore-status']);
    assert.deepEqual(calls[0].body, calls[1].body);
    assert.doesNotMatch(storage.get(MESSAGE_RESTORE_STORAGE_KEY)!, /private text|refs/u);
    disposeMessageRestore(restored.identity);
    assert.equal(calls.length, 2);
    setComposerAttachmentLifecycleEnabled(true); await settle();
    assert.equal(calls[2].path, '/api/composer/attachments/restore-abort');
    assert.deepEqual(calls[2].body, calls[0].body);
    assert.deepEqual(JSON.parse(storage.get(MESSAGE_RESTORE_STORAGE_KEY)!), []);
  } finally { globalThis.fetch = previous; setComposerAttachmentLifecycleEnabled(false); }
});

test('unknown/preparing restore is aborted under original identity, not retried', async () => {
  const previous = globalThis.fetch; const calls: string[] = [];
  storage.clear(); setComposerAttachmentLifecycleEnabled(false);
  globalThis.fetch = async (path, init) => {
    if (path === '/api/csrf') return Response.json({ csrfToken: 'fixture' });
    if (String(path).endsWith('/restore-epoch')) return Response.json({ sessionId: input.sessionId, root: '/workspace', restoreEpoch: 1 });
    calls.push(String(path)); const body = JSON.parse(String(init?.body));
    if (String(path).endsWith('/restore')) throw new TypeError('lost response');
    return Response.json(ack(body, String(path).endsWith('restore-status') ? 'preparing' : 'aborted'));
  };
  try {
    await assert.rejects(restoreLocalMessageDraft(input, () => true), /unresolved/u);
    assert.equal(JSON.parse(storage.get(MESSAGE_RESTORE_STORAGE_KEY)!).length, 1);
    setComposerAttachmentLifecycleEnabled(true); await settle();
    assert.equal(calls.filter(path => path.endsWith('/restore')).length, 1);
    assert.equal(calls.at(-1), '/api/composer/attachments/restore-abort');
    assert.deepEqual(JSON.parse(storage.get(MESSAGE_RESTORE_STORAGE_KEY)!), []);
  } finally { globalThis.fetch = previous; setComposerAttachmentLifecycleEnabled(false); }
});

test('same-tab reload ownership recovery aborts abandoned receipt and retains failed cleanup', async () => {
  const previous = globalThis.fetch; let confirmed = false; let calls = 0;
  const identity: MessageRestoreIdentity = { ...input, root: '/workspace', restoreEpoch: 1, restoreId: 'c'.repeat(32) };
  storage.set(MESSAGE_RESTORE_STORAGE_KEY, JSON.stringify([{ ...identity, cleanup: true }]));
  setComposerAttachmentLifecycleEnabled(false);
  globalThis.fetch = async (path, init) => {
    if (path === '/api/csrf') return Response.json({ csrfToken: 'fixture' });
    assert.equal(path, '/api/composer/attachments/restore-abort'); calls++;
    if (!confirmed) throw new TypeError('offline');
    return Response.json(ack(JSON.parse(String(init?.body)), 'aborted'));
  };
  try {
    recoverMessageRestoreCleanup(); assert.equal(calls, 0);
    setComposerAttachmentLifecycleEnabled(true); await settle();
    assert.equal(calls, 1); assert.equal(JSON.parse(storage.get(MESSAGE_RESTORE_STORAGE_KEY)!).length, 1);
    confirmed = true; flushComposerAttachmentReleases(); await settle();
    assert.equal(calls, 2); assert.deepEqual(JSON.parse(storage.get(MESSAGE_RESTORE_STORAGE_KEY)!), []);
  } finally { globalThis.fetch = previous; setComposerAttachmentLifecycleEnabled(false); }
});

test('cancel while restore is in flight persists abort-before-response without replay', async () => {
  const previous = globalThis.fetch; const controller = new AbortController(); let resolve: (value: Response) => void = () => {};
  const calls: string[] = []; storage.clear(); setComposerAttachmentLifecycleEnabled(true);
  globalThis.fetch = async (path, init) => {
    if (path === '/api/csrf') return Response.json({ csrfToken: 'fixture' });
    if (String(path).endsWith('/restore-epoch')) return Response.json({ sessionId: input.sessionId, root: '/workspace', restoreEpoch: 1 });
    calls.push(String(path));
    if (String(path).endsWith('/restore')) return new Promise<Response>(r => { resolve = r; });
    return Response.json(ack(JSON.parse(String(init?.body)), 'aborted'));
  };
  try {
    const promise = restoreLocalMessageDraft(input, () => true, controller.signal);
    await settle(); controller.abort(); await settle();
    assert.deepEqual(calls, ['/api/composer/attachments/restore', '/api/composer/attachments/restore-abort']);
    resolve(Response.json(result)); await assert.rejects(promise); await settle();
    assert.equal(calls.filter(path => path.endsWith('/restore')).length, 1);
  } finally { globalThis.fetch = previous; setComposerAttachmentLifecycleEnabled(false); }
});

test('malformed or unwritable ownership storage fails closed before network', async () => {
  const previous = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('unexpected network'); };
  try {
    storage.set(MESSAGE_RESTORE_STORAGE_KEY, 'not-json');
    await assert.rejects(restoreLocalMessageDraft(input, () => true));
    assert.equal(calls, 0); assert.equal(storage.get(MESSAGE_RESTORE_STORAGE_KEY), 'not-json');
  } finally { storage.clear(); globalThis.fetch = previous; }
});

test('reload or duplicated-tab active ledger never disposes a draft on hydration and only queries it', async () => {
  const previousFetch = globalThis.fetch; const calls: string[] = [];
  const identity: MessageRestoreIdentity = { ...input, root: '/workspace', restoreEpoch: 1, restoreId: 'd'.repeat(32) };
  storage.set(MESSAGE_RESTORE_STORAGE_KEY, JSON.stringify([{ ...identity, cleanup: false }]));
  globalThis.fetch = async (path, init) => {
    if (path === '/api/csrf') return Response.json({ csrfToken: 'fixture' });
    if (String(path).endsWith('/restore-epoch')) return Response.json({ sessionId: input.sessionId, root: '/workspace', restoreEpoch: 1 });
    calls.push(String(path));
    return Response.json(ack(JSON.parse(String(init?.body)), String(path).endsWith('restore-status') ? 'committed' : 'aborted'));
  };
  try {
    setComposerAttachmentLifecycleEnabled(true); recoverMessageRestoreCleanup(); await settle();
    assert.deepEqual(calls, []);
    const restored = await restoreLocalMessageDraft(input, () => true);
    assert.equal(restored.identity.restoreId, identity.restoreId);
    assert.deepEqual(calls, ['/api/composer/attachments/restore-status']);
    assert.equal(JSON.parse(storage.get(MESSAGE_RESTORE_STORAGE_KEY)!)[0].cleanup, false);
    await assert.rejects(restoreLocalMessageDraft(input, () => true), /already owned/u);
    disposeMessageRestore(restored.identity); await settle();
    assert.equal(calls.at(-1), '/api/composer/attachments/restore-abort');
  } finally { globalThis.fetch = previousFetch; setComposerAttachmentLifecycleEnabled(false); }
});

test('retained restore from an older revision cannot populate the newly observed message', async () => {
  const previousFetch = globalThis.fetch; const calls: string[] = [];
  const identity: MessageRestoreIdentity = { ...input, root: '/workspace', restoreEpoch: 1, restoreId: 'e'.repeat(32) };
  storage.set(MESSAGE_RESTORE_STORAGE_KEY, JSON.stringify([{ ...identity, cleanup: false }]));
  globalThis.fetch = async (path, init) => {
    if (path === '/api/csrf') return Response.json({ csrfToken: 'fixture' });
    if (String(path).endsWith('/restore-epoch')) return Response.json({ sessionId: input.sessionId, root: '/workspace', restoreEpoch: 1 });
    calls.push(String(path)); return Response.json(ack(JSON.parse(String(init?.body)), String(path).endsWith('restore-status') ? 'committed' : 'aborted'));
  };
  try {
    setComposerAttachmentLifecycleEnabled(true);
    const restored = await restoreLocalMessageDraft({ ...input, revision: `sha256:${'f'.repeat(64)}` }, () => true);
    assert.equal(restored.result, undefined);
    assert.equal(restored.identity.restoreId, identity.restoreId);
    assert.deepEqual(calls, ['/api/composer/attachments/restore-status']);
    disposeMessageRestore(restored.identity); await settle();
    assert.equal(calls.at(-1), '/api/composer/attachments/restore-abort');
  } finally { globalThis.fetch = previousFetch; setComposerAttachmentLifecycleEnabled(false); }
});

test('deleted-session cleanup uses captured original root and epoch without live-session lookup', async () => {
  const previous = globalThis.fetch; const calls: string[] = [];
  const identity: MessageRestoreIdentity = { ...input, sessionId: 'deleted', root: '/original/deleted-workspace', restoreEpoch: 2, restoreId: '5'.repeat(32) };
  storage.set(MESSAGE_RESTORE_STORAGE_KEY, JSON.stringify([{ ...identity, cleanup: true }]));
  globalThis.fetch = async (path, init) => {
    if (path === '/api/csrf') return Response.json({ csrfToken: 'fixture' });
    calls.push(String(path));
    const body = JSON.parse(String(init?.body));
    assert.equal(body.root, identity.root); assert.equal(body.restoreEpoch, 2);
    return Response.json({ ...identity, status: 'aborted', cleanupComplete: true });
  };
  try {
    setComposerAttachmentLifecycleEnabled(true); recoverMessageRestoreCleanup(); await settle();
    assert.deepEqual(calls, ['/api/composer/attachments/restore-abort']);
    assert.deepEqual(JSON.parse(storage.get(MESSAGE_RESTORE_STORAGE_KEY)!), []);
  } finally { setComposerAttachmentLifecycleEnabled(false); globalThis.fetch = previous; }
});

test('retired epoch query cannot replay restore or erase retained clone without explicit cancellation', async () => {
  const previous = globalThis.fetch; const calls: string[] = [];
  const identity: MessageRestoreIdentity = { ...input, root: '/workspace', restoreEpoch: 0, restoreId: '4'.repeat(32) };
  storage.set(MESSAGE_RESTORE_STORAGE_KEY, JSON.stringify([{ ...identity, cleanup: false }]));
  globalThis.fetch = async (path, init) => {
    if (path === '/api/csrf') return Response.json({ csrfToken: 'fixture' });
    calls.push(String(path)); return Response.json(ack(JSON.parse(String(init?.body)), 'aborted'));
  };
  try {
    setComposerAttachmentLifecycleEnabled(true);
    const restored = await restoreLocalMessageDraft(input, () => true);
    assert.equal(restored.result, undefined); assert.equal(restored.identity.restoreEpoch, 0);
    assert.deepEqual(calls, ['/api/composer/attachments/restore-status']);
    assert.equal(JSON.parse(storage.get(MESSAGE_RESTORE_STORAGE_KEY)!)[0].cleanup, false);
    disposeMessageRestore(restored.identity); await settle();
    assert.deepEqual(calls, ['/api/composer/attachments/restore-status', '/api/composer/attachments/restore-abort']);
  } finally { setComposerAttachmentLifecycleEnabled(false); globalThis.fetch = previous; }
});
