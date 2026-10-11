import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deleteArchivedSession } from './archiveApi';

const sid = 'a'.repeat(32), revision = 'b'.repeat(64);
test('permanent deletion uses a separate CSRF-protected archive route and displayed revision once', async () => {
  const previous = globalThis.fetch, calls: Array<{ path: string; options?: RequestInit }> = [];
  globalThis.fetch = async (path, options) => {
    calls.push({ path: String(path), options });
    return Response.json(path === '/api/csrf' ? { csrfToken: 'fixture' } : { id: sid, deleted: true, permanent: true });
  };
  try {
    await deleteArchivedSession(sid, revision);
    assert.deepEqual(calls.map(call => call.path), ['/api/csrf', `/api/sessions/archived/${sid}`]);
    assert.equal(calls[1].options?.method, 'DELETE');
    assert.equal((calls[1].options?.headers as Record<string, string>)['X-CSRF-Token'], 'fixture');
    assert.deepEqual(JSON.parse(String(calls[1].options?.body)), { confirmed: true, expectedRevision: revision });
  } finally { globalThis.fetch = previous; }
});

test('invalid archive identity or missing revision starts no request', async () => {
  const previous = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({}); };
  try {
    await assert.rejects(deleteArchivedSession('../outside', revision), /有效版本/);
    await assert.rejects(deleteArchivedSession(sid, ''), /有效版本/);
    assert.equal(calls, 0);
  } finally { globalThis.fetch = previous; }
});

test('stale, restored, busy and already deleted records have actionable errors with no automatic replay', async () => {
  const previous = globalThis.fetch;
  try {
    for (const [status, message, expected] of [[409, 'archived session changed; refresh before deleting', /归档记录已变化/],
      [409, 'session is in use by another process', /其他窗口/], [404, 'archived session not found', /已删除或已恢复/]] as const) {
      let mutations = 0;
      globalThis.fetch = async path => {
        if (path === '/api/csrf') return Response.json({ csrfToken: 'fixture' });
        mutations++; return Response.json({ error: message }, { status });
      };
      await assert.rejects(deleteArchivedSession(sid, revision), expected);
      assert.equal(mutations, 1);
    }
  } finally { globalThis.fetch = previous; }
});

test('a soft archive or wrong-identity response cannot be reported as permanent deletion', async () => {
  const previous = globalThis.fetch;
  try {
    for (const result of [{ id: sid, deleted: true }, { id: 'c'.repeat(32), deleted: true, permanent: true }]) {
      globalThis.fetch = async path => Response.json(path === '/api/csrf' ? { csrfToken: 'fixture' } : result);
      await assert.rejects(deleteArchivedSession(sid, revision), /无法确认/);
    }
  } finally { globalThis.fetch = previous; }
});
