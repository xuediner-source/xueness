import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { appendUserTurn } from '@xueness/agent';
import { NativeFileLocks, SessionStore } from '@xueness/sessions';
import { applyConversationRewind } from '../src/forking.ts';
import { indexRow } from '../src/index-rows.ts';
import { messageRevision } from '../src/journal-http.ts';
import { markViewed } from '../src/read-state.ts';
import { createRewindApi } from '../src/rewind-api.ts';
import { createSessionRuntimeEventLog } from '../src/runtime-event-log.ts';
type Row = Record<string, any>;
const sid = 'a'.repeat(32), firstSid = 'b'.repeat(32);

it('rewinds under a lease, survives coldload, invalidates stale reads and preserves no removed execution effects', async () => {
  const root = mkdtempSync(join(tmpdir(), 'xueness-rewind-')), store = new SessionStore(root), other = new NativeFileLocks();
  try {
    const session = await store.new('rewind example', root, { sessionId: sid }), messages = session.messages as Row[];
    messages[1]!._turn_id = 'turn-1';
    messages.push(
      { role: 'assistant', content: '', _turn_id: 'turn-1', tool_calls: [{ id: 'kept-call', type: 'function', function: { name: 'read', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'kept-call', content: 'kept result', _turn_id: 'turn-1' },
      { role: 'assistant', content: 'first answer', _turn_id: 'turn-1' },
      { role: 'user', content: 'guide', _input_kind: 'guide', _turn_id: 'turn-1' },
      { role: 'user', content: 'task notice', _input_kind: 'background_notice', _meta_source: 'task_status', _background_task_notice: 'bg-kept:exited', _turn_id: 'turn-1' },
      { role: 'user', content: 'summary row', _input_kind: 'summary', _summary: true },
      { role: 'user', content: 'synthetic source row', _meta_source: 'task_status' },
      { role: 'user', content: 'rewind from here', _turn_id: 'turn-3' },
      { role: 'assistant', content: '', _turn_id: 'turn-3', tool_calls: [{ id: 'removed-call', type: 'function', function: { name: 'exec', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'removed-call', content: 'background started', _turn_id: 'turn-3' },
      { role: 'assistant', content: 'removed answer', _turn_id: 'turn-3' },
    );
    const target = messages[9]!;
    Object.assign(session, { status: 'completed', steps: 99, active_turn_id: 'turn-3', completion: { old: true }, pending_question: 'old question', streaming: { status: 'streaming' }, runtime_turn: { phase: 'streaming' }, runtime_activity: { old: true }, tool_activity: [{ call_id: 'removed-call' }], results: { 'kept-call': { ok: true, output: 'kept result' }, 'removed-call': { ok: true, data: { id: 'bg-removed' } }, unrelated: { secret: true } }, background_tasks: [{ id: 'bg-kept', state: 'exited' }, { id: 'bg-removed', state: 'running' }], message_annotations: { '1': { rating: 'good' }, '10': { rating: 'old' } }, reasoning_history: [{ message_index: 4 }, { message_index: 9 }], completion_history: [{ turn_id: 'turn-1' }, { turn_id: 'turn-3' }] });
    await store.save(session);
    const saved = await store.load(sid), savedTarget = (saved.messages as Row[]).find((row) => row.content === 'rewind from here')!;
    assert.equal(target._message_id, savedTarget._message_id);
    await markViewed(store, sid);
    const options = { store, stateDir: root, projectDir: root, webRuns: root, enabled: (id: string) => id === 'sessions' }, api = createRewindApi(options);
    const listed = await api.dispatch('GET', ['api', 'sessions', sid, 'rewind-targets'], {}, {});
    assert.equal(listed?.[0], 200);
    const listing = listed![1] as Row, targets = listing.targets as Row[];
    assert.deepEqual(targets.map((row) => row.preview), ['rewind example', 'rewind from here']);
    const body = { messageId: savedTarget._message_id, revision: listing.revision, confirmed: true };
    const result = await api.dispatch('POST', ['api', 'sessions', sid, 'rewind'], {}, body);
    assert.equal(result?.[0], 200); assert.deepEqual((result![1] as Row).removedMessageIds.length, 4);
    const cold = await store.load(sid), coldMessages = cold.messages as Row[], branch = (cold.rewind_history as Row[]).at(-1)!;
    assert.equal(cold.status, 'paused'); assert.equal(coldMessages.length, 9); assert.equal(cold.steps, 2);
    assert.equal(branch.targetMessageId, savedTarget._message_id); assert.equal(branch.previousRevision, listing.revision); assert.deepEqual(branch.removedMessageIds, (result![1] as Row).removedMessageIds);
    assert.deepEqual(Object.keys(cold.results as Row), ['kept-call']); assert.deepEqual(cold.message_annotations, { '1': { rating: 'good' } });
    assert.deepEqual(cold.reasoning_history, [{ message_index: 4 }]); assert.deepEqual(cold.completion_history, [{ turn_id: 'turn-1' }]);
    for (const key of ['active_turn_id', 'completion', 'pending_question', 'streaming', 'runtime_turn', 'runtime_activity', 'tool_activity']) assert.equal(Object.hasOwn(cold, key), false, key);
    const removedTask = (cold.background_tasks as Row[]).find((row) => row.id === 'bg-removed')!;
    assert.equal(removedTask.state, 'running'); assert.equal(removedTask.branch_removed, true);
    const reset = createSessionRuntimeEventLog(root, sid).readPage({ limit: 50 }).events.findLast((event) => event.type === 'HistoryReset');
    assert.ok(reset); assert.deepEqual(reset.payload.reason, 'conversation_rewind'); assert.deepEqual(reset.payload.revision, (result![1] as Row).revision);
    assert.equal(reset.payload.generation, 1); assert.deepEqual(reset.payload.removedMessageIds, (result![1] as Row).removedMessageIds);
    const stat = statSync(store.pathFor(sid), { bigint: true }), row = indexRow(store, cold, Number(stat.mtimeMs), stat.mtimeNs, () => true, new Set());
    assert.equal(row?.unread, true, 'the saved rewind makes the pre-rewind read marker stale');
    const after = readFileSync(store.pathFor(sid));
    assert.equal((await api.dispatch('POST', ['api', 'sessions', sid, 'rewind'], {}, body))?.[0], 409);
    assert.deepEqual(readFileSync(store.pathFor(sid)), after, 'stale revision does not write');
    const held = await other.tryAcquire(store.lockDirectory, sid + '.lock');
    try {
      const fresh = messageRevision(cold);
      assert.equal((await api.dispatch('POST', ['api', 'sessions', sid, 'rewind'], {}, { ...body, revision: fresh }))?.[0], 409);
      assert.deepEqual(readFileSync(store.pathFor(sid)), after, 'busy lease does not write');
    } finally { await held.release(); }

    const first = await store.new('first prompt', root, { sessionId: firstSid }), firstUser = (first.messages as Row[])[1]!;
    const firstResult = await applyConversationRewind(store, firstSid, { messageId: firstUser._message_id, revision: messageRevision(first), confirmed: true });
    const empty = await store.load(firstSid); assert.equal((empty.messages as Row[]).length, 1); assert.equal(firstResult.steps, 0);
    await appendUserTurn(empty, store, 'next prompt');
    assert.equal((empty.messages as Row[]).at(-1)?.content, 'next prompt'); assert.equal(empty.status, 'pending');
  } finally { await other.close(); rmSync(root, { recursive: true, force: true }); }
});
