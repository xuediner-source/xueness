import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createAppProtocolControls } from '../src/app-protocol-controls.ts';
import { createAppProtocolMedia } from '../src/app-protocol-media.ts';
import type { AppProtocolPort, ProtocolRow } from '../src/app-protocol-types.ts';

function fixture() {
  const calls: { method: string; path: string; data?: ProtocolRow; query?: Record<string, string[]> }[] = [];
  const authorized: string[] = [];
  const port: AppProtocolPort = {
    workspaceIdentity: 'workspace',
    async ask(method, path, data, query) { calls.push({ method, path, data, query }); return { method, path }; },
    async authorize(sessionId) { authorized.push(sessionId); },
    enabled: () => true,
  };
  return { calls, authorized, port };
}

it('maps composer requests to the bound HTTP owner and rejects local routing data', async () => {
  const f = fixture(), methods = createAppProtocolControls(f.port), sid = 'a'.repeat(32);
  await methods['composer/catalog']!({ workspaceIdentity: 'workspace', sessionId: sid });
  assert.deepEqual(f.calls.at(-1), { method: 'GET', path: '/api/composer', data: undefined, query: { root: ['workspace'], session_id: [sid] } });
  await methods['composer/prepare']!({ workspaceIdentity: 'workspace', sessionId: null,
    payload: { text: 'draft', input: { attachments: [], files: [], sessions: [], attachmentRefs: [{ id: 'b'.repeat(32) }] } } });
  assert.deepEqual(f.calls.at(-1), { method: 'POST', path: '/api/composer/prepare', data: {
    text: 'draft', input: { attachments: [], files: [], sessions: [], attachmentRefs: [{ id: 'b'.repeat(32) }] }, root: 'workspace', session_id: null,
  }, query: undefined });
  await assert.rejects(methods['composer/prepare']!({ workspaceIdentity: 'workspace', sessionId: null,
    payload: { text: 'draft', root: 'other' } }), /workspace scope mismatch/);
  await assert.rejects(methods['composer/prepare']!({ workspaceIdentity: 'workspace', sessionId: null,
    payload: { text: 'draft', input: { attachments: [{ name: 'local.png' }] } } }), /local attachments/);
});

it('maps question, guidance, and withdrawal methods to their owning routes with session authorization', async () => {
  const f = fixture(), methods = createAppProtocolControls(f.port), sid = 'c'.repeat(32), questionId = 'q-' + 'd'.repeat(64);
  await methods['question/read']!({ workspaceIdentity: 'workspace', sessionId: sid });
  assert.equal(f.calls.at(-1)?.path, `/api/sessions/${sid}/question`);
  await methods['question/answer']!({ workspaceIdentity: 'workspace', sessionId: sid, payload: { questionId, answer: 'same answer' } });
  assert.deepEqual(f.calls.at(-1), { method: 'POST', path: `/api/sessions/${sid}/answer-question`,
    data: { questionId, answer: 'same answer' }, query: undefined });
  await methods['question/query']!({ workspaceIdentity: 'workspace', sessionId: sid, questionId, payload: { answer: 'same answer' } });
  assert.deepEqual(f.calls.at(-1), { method: 'POST', path: `/api/sessions/${sid}/question-query`,
    data: { questionId, answer: 'same answer' }, query: undefined });
  await methods['guidance/send']!({ workspaceIdentity: 'workspace', sessionId: sid,
    payload: { request_id: 'e'.repeat(32), expected_turn_id: 'turn-1', text: 'continue' } });
  assert.equal(f.calls.at(-1)?.path, `/api/sessions/${sid}/steer`);
  await methods['guidance/read']!({ workspaceIdentity: 'workspace', sessionId: sid });
  assert.equal(f.calls.at(-1)?.path, `/api/sessions/${sid}/steer`);
  await methods['guidance/cancel']!({ workspaceIdentity: 'workspace', sessionId: sid, guidanceId: 'e'.repeat(32) });
  assert.deepEqual(f.calls.at(-1), { method: 'DELETE', path: `/api/sessions/${sid}/steer/${'e'.repeat(32)}`, data: undefined, query: undefined });
  await methods['guidance/promote']!({ workspaceIdentity: 'workspace', sessionId: sid, queueId: 'f'.repeat(32),
    payload: { request_id: '1'.repeat(32), expected_turn_id: 'turn-1' } });
  assert.equal(f.calls.at(-1)?.path, `/api/sessions/${sid}/queue/${'f'.repeat(32)}/send-now`);
  const envelope = { operation: 'cancel', guidanceId: 'e'.repeat(32) };
  await methods['guidance/query']!({ workspaceIdentity: 'workspace', sessionId: sid, payload: envelope });
  assert.deepEqual(f.calls.at(-1), { method: 'POST', path: `/api/sessions/${sid}/steer-query`, data: envelope, query: undefined });
  await methods['withdrawal/list']!({ workspaceIdentity: 'workspace', sessionId: sid });
  assert.equal(f.calls.at(-1)?.path, `/api/sessions/${sid}/queue-withdrawals`);
  const recoveryId = 'c_1234567890123_' + 'a'.repeat(32);
  await methods['withdrawal/get']!({ workspaceIdentity: 'workspace', sessionId: sid, recoveryId });
  assert.equal(f.calls.at(-1)?.path, `/api/sessions/${sid}/queue-withdrawals/${recoveryId}`);
  await methods['withdrawal/dismiss']!({ workspaceIdentity: 'workspace', sessionId: sid, recoveryId });
  assert.deepEqual(f.calls.at(-1), { method: 'DELETE', path: `/api/sessions/${sid}/queue-withdrawals/${recoveryId}`, data: undefined, query: undefined });
  assert.equal(f.authorized.length, 11);
  assert.ok(f.authorized.every(id => id === sid));
});

it('maps media status to one read-only status request', async () => {
  const f = fixture(), methods = createAppProtocolMedia(f.port), sid = null, id = '2'.repeat(32);
  await methods['media/status']!({ workspaceIdentity: 'workspace', sessionId: sid, payload: { id } });
  assert.deepEqual(f.calls, [{ method: 'POST', path: '/api/composer/attachments/status',
    data: { root: 'workspace', session_id: null, id }, query: undefined }]);
  await assert.rejects(methods['media/restore']!({ workspaceIdentity: 'workspace', sessionId: null,
    payload: { restoreId: '3'.repeat(32), messageIndex: 0, revision: 'sha256:' + '4'.repeat(64), restoreEpoch: 0 } }), /sessionId must/);
});
