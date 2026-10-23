import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createAppProtocolGoals } from '../src/app-protocol-goal.ts';
import type { AppProtocolPort, ProtocolRow } from '../src/app-protocol-types.ts';

function fixture(enabled = true) {
  const calls: { method: string; path: string; data?: ProtocolRow }[] = [];
  const authorized: string[] = [];
  const port: AppProtocolPort = {
    workspaceIdentity: 'workspace',
    async ask(method, path, data) { calls.push({ method, path, data }); return { method, path }; },
    async authorize(sessionId) { authorized.push(sessionId); },
    enabled: () => enabled,
  };
  return { calls, authorized, port };
}

it('maps scoped goal operations to the planning HTTP owner', async () => {
  const f = fixture(), methods = createAppProtocolGoals(f.port), sessionId = 'a'.repeat(32);
  const scope = { workspaceIdentity: 'workspace', sessionId };
  await methods['goal/read']!(scope);
  assert.deepEqual(f.calls.at(-1), { method: 'GET', path: `/api/sessions/${sessionId}/goal`, data: undefined });
  await methods['goal/set']!({ ...scope, text: 'finish the release', replace: true,
    budget: { maxRounds: 4, maxWallSeconds: 300, maxTokens: 10000 } });
  assert.deepEqual(f.calls.at(-1), { method: 'POST', path: `/api/sessions/${sessionId}/goal`, data: {
    text: 'finish the release', replace: true, budget: { maxRounds: 4, maxWallSeconds: 300, maxTokens: 10000 },
  } });
  await methods['goal/pause']!(scope);
  assert.deepEqual(f.calls.at(-1), { method: 'POST', path: `/api/sessions/${sessionId}/goal`, data: { action: 'pause' } });
  await methods['goal/resume']!(scope);
  assert.deepEqual(f.calls.at(-1), { method: 'POST', path: `/api/sessions/${sessionId}/goal`, data: { action: 'resume' } });
  await methods['goal/clear']!(scope);
  assert.deepEqual(f.calls.at(-1), { method: 'DELETE', path: `/api/sessions/${sessionId}/goal`, data: undefined });
  await methods['goal/budget']!({ ...scope, budget: {} });
  assert.deepEqual(f.calls.at(-1), { method: 'POST', path: `/api/sessions/${sessionId}/goal`, data: { action: 'budget', budget: {} } });
  assert.deepEqual(f.authorized, Array(6).fill(sessionId));
});

it('rejects invalid scope, extra method fields, malformed budget, and disabled planning', async () => {
  const f = fixture(), methods = createAppProtocolGoals(f.port), sessionId = 'b'.repeat(32);
  await assert.rejects(methods['goal/read']!({ workspaceIdentity: 'other', sessionId }), /workspace identity mismatch/);
  await assert.rejects(methods['goal/read']!({ workspaceIdentity: 'workspace', sessionId, payload: {} }), /unexpected keys/);
  await assert.rejects(methods['goal/set']!({ workspaceIdentity: 'workspace', sessionId, text: 'goal', replace: 'yes' }), /replace must be a boolean/);
  await assert.rejects(methods['goal/set']!({ workspaceIdentity: 'workspace', sessionId, text: 'goal', budget: { rounds: 3 } }), /unexpected keys/);
  await assert.rejects(methods['goal/budget']!({ workspaceIdentity: 'workspace', sessionId, budget: null }), /budget must be an object/);
  const disabled = createAppProtocolGoals(fixture(false).port);
  await assert.rejects(disabled['goal/read']!({ workspaceIdentity: 'workspace', sessionId }), /plugin disabled/);
});
