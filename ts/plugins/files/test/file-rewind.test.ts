import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { SessionStore } from '@xueness/sessions';
import type { AgentContext, Row } from '@xueness/agent';
import { fileImage, filesHistoryExtension } from '../src/file-history.ts';
import { applyFileRewind, previewFileRewind, restoreFileChecked } from '../src/file-rewind.ts';
import { createFileRewindApi } from '../src/file-rewind-api.ts';

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'xueness-file-rewind-')), root = join(directory, 'workspace'); mkdirSync(root);
  const store = new SessionStore(join(directory, 'state')), session = await store.new('change files', root), extension = filesHistoryExtension();
  const context = { session, store, stateDir: store.directory, root, save: () => store.save(session) } as AgentContext;
  const messageId = (session.messages as Row[])[1]!._message_id as string;
  async function change(id: string, path: string, after: string) {
    (session.messages as Row[]).push({ role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name: 'write', arguments: '{}' } }] }); await store.save(session);
    const call = { id, name: 'write', input: { path, content: after } };
    await extension.toolExecutionStarted!(context, call); writeFileSync(join(root, path), after);
    await extension.toolResultRecorded!(context, call, { ok: true });
  }
  return { directory, root, store, session, messageId, context, extension, change, close: () => rmSync(directory, { recursive: true, force: true }) };
}
test('cold file rewind restores original bytes, removes newly created files and merges repeated edits', async () => {
  const f = await fixture(); try {
    writeFileSync(join(f.root, 'old.txt'), '原始🙂\r\n');
    await f.change('one', 'old.txt', 'first'); await f.change('two', 'new.txt', 'new'); await f.change('three', 'old.txt', 'last');
    const cold = await new SessionStore(f.store.directory).load(String(f.session.id));
    const preview = await previewFileRewind(f.store.directory, cold, f.messageId);
    assert.equal(preview.canApply, true); assert.equal((preview.files as Row[]).length, 2);
    assert.equal(JSON.stringify(preview).includes('原始'), false);
    await applyFileRewind(f.store, f.store.directory, cold, f.messageId);
    assert.equal(readFileSync(join(f.root, 'old.txt'), 'utf8'), '原始🙂\r\n'); assert.equal(existsSync(join(f.root, 'new.txt')), false);
    assert.equal((await previewFileRewind(f.store.directory, cold, f.messageId)).canApply, true);
    assert.equal((cold.file_history as Row[]).every(row => row.status === 'rewound'), true);
  } finally { f.close(); }
});
test('external file changes block the entire rewind before another file is touched', async () => {
  const f = await fixture(); try {
    writeFileSync(join(f.root, 'one.txt'), 'old'); await f.change('one', 'one.txt', 'agent'); await f.change('two', 'two.txt', 'created');
    writeFileSync(join(f.root, 'one.txt'), 'operator');
    assert.equal((await previewFileRewind(f.store.directory, f.session, f.messageId)).canApply, false);
    await assert.rejects(applyFileRewind(f.store, f.store.directory, f.session, f.messageId), /Workspace changed/);
    assert.equal(readFileSync(join(f.root, 'two.txt'), 'utf8'), 'created'); assert.equal(readFileSync(join(f.root, 'one.txt'), 'utf8'), 'operator');
  } finally { f.close(); }
});
test('failed session publication compensates files and retains active operation records', async () => {
  const f = await fixture(); try {
    writeFileSync(join(f.root, 'one.txt'), 'old'); await f.change('one', 'one.txt', 'agent');
    const broken = { save: async () => { throw new Error('publication failed'); } } as unknown as SessionStore;
    await assert.rejects(applyFileRewind(broken, f.store.directory, f.session, f.messageId), /publication failed/);
    assert.equal(readFileSync(join(f.root, 'one.txt'), 'utf8'), 'agent'); assert.equal((f.session.file_history as Row[])[0]!.status, 'completed');
  } finally { f.close(); }
});
test('applied rewind publishes per-file outcomes and an append-only trace entry', async () => {
  const f = await fixture(); try {
    writeFileSync(join(f.root, 'kept.txt'), 'base'); await f.change('one', 'kept.txt', 'edited'); await f.change('two', 'made.txt', 'created');
    const applied = await applyFileRewind(f.store, f.store.directory, f.session, f.messageId) as Row;
    const results = applied.results as Row[];
    assert.equal(results.length, 2);
    assert.deepEqual(results.map((row) => row.action).sort(), ['delete', 'restore']);
    for (const row of results) {
      if (row.action === 'restore') assert.match(String(row.restoredHash), /^[0-9a-f]{64}$/);
      else assert.equal(row.restoredHash, null, 'a deleted file has no restored hash');
    }
    const trace = f.session.file_rewind_history as Row[];
    assert.equal(trace.length, 1);
    assert.equal(trace[0]!.messageId, f.messageId);
    assert.deepEqual(trace[0]!.results, results);
    assert.equal((f.session.file_rewind_last as Row).messageId, f.messageId);
    assert.equal(readFileSync(join(f.root, 'kept.txt'), 'utf8'), 'base'); assert.equal(existsSync(join(f.root, 'made.txt')), false);
  } finally { f.close(); }
});
test('the trace keeps only the latest 64 rewind outcomes', async () => {
  const f = await fixture(); try {
    writeFileSync(join(f.root, 'a.txt'), 'base'); await f.change('one', 'a.txt', 'edited');
    f.session.file_rewind_history = Array.from({ length: 64 }, (_, index) => ({ messageId: `old-${index}`, at: '2020-01-01T00:00:00Z' }));
    await applyFileRewind(f.store, f.store.directory, f.session, f.messageId);
    const trace = f.session.file_rewind_history as Row[];
    assert.equal(trace.length, 64);
    assert.equal(trace[63]!.messageId, f.messageId);
    assert.equal(trace[0]!.messageId, 'old-1');
  } finally { f.close(); }
});
test('compare-and-swap restore refuses and leaves the file untouched when the workspace moved on', async () => {
  const f = await fixture(); try {
    const path = join(f.root, 'watched.txt'); writeFileSync(path, 'recorded-after');
    const after = fileImage(path), before = { ...after, bytes: Buffer.from('before-state').toString('base64') };
    writeFileSync(path, 'operator-edited');
    await assert.rejects(restoreFileChecked(path, after, before), /Workspace changed/);
    assert.equal(readFileSync(path, 'utf8'), 'operator-edited');
    writeFileSync(path, 'recorded-after');
    await restoreFileChecked(path, after, before);
    assert.equal(readFileSync(path, 'utf8'), 'before-state');
  } finally { f.close(); }
});
test('mid-rewind divergence on a later file compensates the already restored files', async () => {
  const f = await fixture(); try {
    writeFileSync(join(f.root, 'one.txt'), 'old-one'); writeFileSync(join(f.root, 'two.txt'), 'old-two');
    await f.change('one', 'one.txt', 'agent-one'); await f.change('two', 'two.txt', 'agent-two');
    const plan = await previewFileRewind(f.store.directory, f.session, f.messageId);
    assert.equal((plan.files as Row[]).length, 2);
    writeFileSync(join(f.root, 'two.txt'), 'operator-two');
    await assert.rejects(applyFileRewind(f.store, f.store.directory, f.session, f.messageId), /Workspace changed/);
    assert.equal(readFileSync(join(f.root, 'one.txt'), 'utf8'), 'agent-one');
    assert.equal(readFileSync(join(f.root, 'two.txt'), 'utf8'), 'operator-two');
    assert.equal(f.session.file_rewind_history, undefined, 'a failed rewind leaves no trace entry');
    assert.equal((f.session.file_history as Row[]).every(row => row.status === 'completed'), true);
  } finally { f.close(); }
});
test('a failed rewind restores the previous rewind marker instead of erasing it', async () => {
  const f = await fixture(); try {
    writeFileSync(join(f.root, 'one.txt'), 'old-one'); writeFileSync(join(f.root, 'two.txt'), 'old-two');
    await f.change('one', 'one.txt', 'agent-one'); await f.change('two', 'two.txt', 'agent-two');
    const recorded = { messageId: 'previous-rewind', operationIds: [], at: '2026-01-01T00:00:00.000Z' };
    f.session.file_rewind_last = { ...recorded };
    f.session.file_rewind_history = [{ ...recorded, results: [] }];
    writeFileSync(join(f.root, 'two.txt'), 'operator-two');
    await assert.rejects(applyFileRewind(f.store, f.store.directory, f.session, f.messageId), /Workspace changed/);
    assert.deepEqual(f.session.file_rewind_last, recorded, 'a failed rewind keeps the previously recorded marker');
    assert.equal((f.session.file_rewind_history as Row[]).length, 1, 'and keeps the previous trace');
  } finally { f.close(); }
});
test('file rewind API requires enabled owner, exact revision, confirmation and an idle session', async () => {
  const f = await fixture(); try {
    let enabled = false;
    const api = createFileRewindApi({ store: f.store, stateDir: f.store.directory, enabled: () => enabled, validateSession: async () => {}, revision: () => 'current' });
    const path = ['api', 'sessions', String(f.session.id), 'file-rewind'];
    assert.equal((await api.dispatch('POST', path, {}, {}))![0], 403); enabled = true;
    assert.equal((await api.dispatch('POST', path, {}, { messageId: f.messageId, revision: 'stale', confirmed: true }))![0], 409);
    assert.equal((await api.dispatch('POST', path, {}, { messageId: f.messageId, revision: 'current' }))![0], 400);
    const lease = await f.store.lease(String(f.session.id));
    try { assert.equal((await api.dispatch('POST', path, {}, { messageId: f.messageId, revision: 'current', confirmed: true }))![0], 409); } finally { await lease.release(); }
  } finally { f.close(); }
});
