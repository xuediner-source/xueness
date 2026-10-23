import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { SessionStore } from '@xueness/sessions';
import type { AgentContext, Row } from '@xueness/agent';
import { filesHistoryExtension } from '../src/file-history.ts';
import { applyFileRewind, previewFileRewind } from '../src/file-rewind.ts';
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
