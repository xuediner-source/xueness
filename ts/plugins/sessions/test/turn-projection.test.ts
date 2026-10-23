import assert from 'node:assert/strict';
import { it } from 'node:test';
import { currentTurnToolIds, turnId } from '@xueness/agent';
import { publicTurnState, publicBackgroundTasks } from '../src/public-turn.ts';
import { requiresEvidence } from '../src/completion-policy.ts';
import { sessionsTurnRuntimeExtension } from '../src/turn-runtime.ts';
import { call, fixture } from '../../../packages/agent/test/fixtures.ts';

it('projects only bounded turn and background facts, excluding private file paths and payloads', () => {
  const turn = publicTurnState({ id: 'turn-1', traceId: 'trace-1', phase: 'streaming', startedAt: '2026-10-22T00:00:00Z',
    requestCount: 2, textChars: 13, reasoningChars: 4, prompt: 'private prompt', signature: 'private signature',
    tools: [{ id: 't1', name: 'read', status: 'running', input: 'private input' }] });
  assert.ok(turn);
  assert.equal(turn.requestCount, 2);
  assert.deepEqual(turn.tools, [{ id: 't1', name: 'read', status: 'running' }]);
  const tasks = publicBackgroundTasks([{ id: 'bg_a', state: 'exited', exitCode: 0, outputOpen: false,
    stdoutBytes: 12, stderrBytes: 0, durationMs: 5, stdoutPath: 'private/path', output: 'private output', command: 'private argv' }]);
  assert.deepEqual(tasks, [{ id: 'bg_a', state: 'exited', exitCode: 0, outputOpen: false, stdoutBytes: 12, stderrBytes: 0, durationMs: 5 }]);
  assert.equal(JSON.stringify([turn, tasks]).includes('private'), false);
  assert.equal(publicTurnState({ id: 'a', traceId: 'b', phase: 'made-up' }), null);
});

it('keeps a synthetic background notice within the human turn and retains its successful tool evidence', () => {
  const session = { messages: [{ role: 'user', content: '请修改文件' }, { role: 'assistant', content: '', tool_calls: [call('read-1')] },
    { role: 'tool', tool_call_id: 'read-1', content: '{"ok":true}' },
    { role: 'user', content: 'Background task finished', _input_kind: 'background_notice' }], results: { 'read-1': { ok: true } } };
  assert.equal(turnId(session), 'turn-1');
  assert.deepEqual(currentTurnToolIds(session), ['read-1']);
  assert.equal(requiresEvidence(session, currentTurnToolIds(session)), true);
  assert.equal(requiresEvidence({ messages: [{ role: 'user', content: 'search the web for latest news' }, session.messages.at(-1)] }), true);
});

it('keeps deferred approval waiting in the paused turn snapshot instead of marking the tool failed', async () => {
  const local = fixture([{ content: '', tool_calls: [call('ask-1')] }], [{ ok: false, awaiting_approval: true, error: { code: 'approval_required' } }]);
  local.hooks.extensions = [sessionsTurnRuntimeExtension()];
  try {
    await local.runner.run(local.session);
    assert.equal(local.session.status, 'paused');
    const runtime = local.session.runtime_turn as Record<string, unknown>;
    assert.equal(runtime.resultType, 'paused');
    assert.deepEqual(runtime.tools, [{ id: 'ask-1', name: 'read', status: 'waiting_permission' }]);
  } finally { local.close(); }
});
