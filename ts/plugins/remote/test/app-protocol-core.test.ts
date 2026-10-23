import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { it } from 'node:test';
import { AppProtocolError, type AppProtocolPort, type ProtocolRow } from '../src/app-protocol-types.ts';
import { createAppProtocolCore } from '../src/app-protocol-core.ts';

const identity = 'C:/workspace/project';
const sid = 'a'.repeat(32);
const commandId = 'c_1234567890123_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function fixture(answer: (method: string, path: string, data?: ProtocolRow, query?: Record<string, string[]>) => Promise<ProtocolRow>) {
  const calls: { method: string; path: string; data?: ProtocolRow; query?: Record<string, string[]> }[] = [];
  const port: AppProtocolPort = {
    workspaceIdentity: identity,
    async ask(method, path, data, query) { calls.push({ method, path, data, query }); return answer(method, path, data, query); },
    async authorize(sessionId) { assert.equal(sessionId, sid); },
    enabled: () => true,
  };
  return { core: createAppProtocolCore(port), calls };
}

it('projects only sessions rooted at the selected workspace and maps resume cursors to native query values', async () => {
  const { core, calls } = fixture(async (_method, path) => path.endsWith('/index') ? {
    workspaceId: 'legacy', logEpoch: 'b'.repeat(32), sessions: [
      { id: sid, root: identity, title: 'kept', extra: 7 }, { id: 'c'.repeat(32), root: 'C:/elsewhere', title: 'hidden' },
    ],
  } : { ok: true });
  const index = await core.methods['sessions/index']!({ workspaceIdentity: identity }) as ProtocolRow;
  assert.equal(index.workspaceId, 'legacy');
  assert.deepEqual(index.sessions, [{ id: sid, root: identity, title: 'kept', extra: 7, workspaceIdentity: identity }]);
  await core.methods['conversation/resume']!({ workspaceIdentity: identity, sessionId: sid, logEpoch: 'd'.repeat(32), seq: 12 });
  assert.deepEqual(calls[0], { method: 'GET', path: '/api/sessions/index', data: undefined, query: undefined });
  assert.deepEqual(calls[1]?.query, { logEpoch: ['d'.repeat(32)], seq: ['12'] });
  core.close();
});

it('preserves the command envelope while binding create_session to the sole workspace root', async () => {
  const { core, calls } = fixture(async () => ({ status: 'accepted', result: { id: sid } }));
  await core.methods['command/execute']!({ workspaceIdentity: identity, sessionId: null, commandId, type: 'create_session', payload: { task: 'hello', model_selection: { model: 'm' }, root: identity } });
  assert.deepEqual(calls[0], {
    method: 'POST', path: '/api/sessions/commands', query: undefined,
    data: { commandId, type: 'create_session', payload: { task: 'hello', model_selection: { model: 'm' }, root: identity } },
  });
  await assert.rejects(core.methods['command/execute']!({ workspaceIdentity: identity, sessionId: sid, commandId, type: 'create_session', payload: {} }), AppProtocolError);
  assert.equal(calls.length, 1);
  core.close();
});

it('checks transfer ownership, supports chunk rereads, and expires data after one minute', async () => {
  const { core } = fixture(async () => ({}));
  const originalNow = Date.now; let now = 10_000; Date.now = () => now;
  try {
    const source = { text: 'x'.repeat(800 * 1024) };
    const declaration = await core.transfers.wrap('session/read', sid, source) as ProtocolRow;
    assert.equal(declaration.schema, 'xueness.remote-fragment.v1');
    assert.equal(declaration.totalChunks, 4);
    assert.throws(() => core.transfers.read(identity, 'b'.repeat(32), declaration.transferId, 0), AppProtocolError);
    const first = core.transfers.read(identity, sid, declaration.transferId, 0);
    assert.deepEqual(core.transfers.read(identity, sid, declaration.transferId, 0), first);
    const decoded = Buffer.concat(Array.from({ length: declaration.totalChunks }, (_, chunkIndex) => Buffer.from(core.transfers.read(identity, sid, declaration.transferId, chunkIndex).data, 'base64')));
    assert.equal(decoded.length, declaration.byteLength);
    assert.equal(createHash('sha256').update(decoded).digest('hex'), declaration.sha256);
    now += 60_000;
    assert.throws(() => core.transfers.read(identity, sid, declaration.transferId, 0), (error: unknown) => error instanceof AppProtocolError && error.data?.status === 404);
  } finally { Date.now = originalNow; core.close(); }
});
