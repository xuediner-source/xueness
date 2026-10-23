import test from 'node:test';
import assert from 'node:assert/strict';
import type { Result, SessionSummary } from '../../xuenessWorkbench';
import { loadSidebarSessions, mergeSessionsIndex, parseSessionsIndex, normalizeRemoteSummary } from './sessionsIndex';

const session = (id: string, patch: Partial<SessionSummary> = {}): SessionSummary => ({
  id, task: `Task ${id}`, title: `Title ${id}`, status: 'completed', ...patch,
});
const success = (value: SessionSummary[]): Result<SessionSummary[]> => ({ ok: true, value });
const failure = (error: string): Result<SessionSummary[]> => ({ ok: false, error });
function rows(result: Result<SessionSummary[]>): SessionSummary[] {
  if (!result.ok) assert.fail(result.error);
  return result.value;
}

test('sessions index caps valid rows and deduplicates identities without accepting malformed entries', () => {
  const entries = Array.from({ length: 205 }, (_, index) => session(index.toString(16).padStart(32, '0')));
  const result = parseSessionsIndex({ sessions: [null, {}, { id: '' }, [], entries[0], entries[0], ...entries.slice(1)] });
  assert.equal(result.length, 200);
  assert.equal(new Set(result.map(item => item.id)).size, 200);
  assert.equal(result[0].id, entries[0].id);
  assert.equal(result[199].id, entries[199].id);
});

test('sessions index rejects malformed envelopes so callers can fall back to the legacy list', () => {
  for (const payload of [null, [], {}, { sessions: null }, { sessions: {} }, { items: 'invalid' }]) {
    assert.throws(() => parseSessionsIndex(payload), /sessions.index|snapshot/i);
  }
  assert.deepEqual(parseSessionsIndex({ sessions: [] }), []);
  assert.equal(parseSessionsIndex({ items: [session('legacy-envelope')] })[0].id, 'legacy-envelope');
});

test('sessions index bounds user-visible text and preserves valid permission and user-input attention', () => {
  const result = parseSessionsIndex({ sessions: [
    { ...session('permission'), title: 'T'.repeat(400), changeSummary: 'C'.repeat(400), pendingInteraction: { kind: 'permission', label: 'P'.repeat(400), interactionId: 'approval' } },
    { ...session('question'), pendingInteraction: { kind: 'userInput', interactionId: 'question' } },
  ] });
  assert.equal(result.length, 2);
  assert.equal(result[0].title, 'T'.repeat(120));
  assert.equal(result[0].changeSummary, 'C'.repeat(120));
  assert.ok(result[0].pendingInteraction);
  assert.ok(result[1].pendingInteraction);
  const serialized = JSON.stringify(result[0].pendingInteraction);
  assert.ok(serialized.includes('permission'));
  assert.ok(!serialized.includes('P'.repeat(121)), 'a tooltip must not retain the unbounded label');
  assert.ok(JSON.stringify(result[1].pendingInteraction).includes('userInput'));
});

test('sessions index drops empty and malformed pending attention instead of inventing a waiting state', () => {
  const invalid = [{}, [], { kind: 'unknown' }, 42, false, '', '   '];
  const result = parseSessionsIndex({ sessions: invalid.map((pendingInteraction, index) => ({
    ...session(`quiet-${index}`), pendingInteraction,
  })) });
  assert.equal(result.length, invalid.length);
  for (const item of result) assert.ok(!item.pendingInteraction, `${item.id} must remain quiet`);
});

test('sessions index keeps sidecar display fields while removing prompts, tool bodies, and unknown keys', () => {
  const [result] = parseSessionsIndex({ sessions: [{
    ...session('nested'),
    sidecar: {
      workspacePath: '/workspace/project', workspaceName: 'Project', purpose: 'conversation',
      unread: true, pendingInteraction: { kind: 'userInput', interactionId: 'question', question: 'private question' },
      changeSummary: { files: 3 }, messages: [{ content: 'private message' }], toolOutput: 'private output',
    },
    arbitrary: 'private top-level value',
  }] });
  const serialized = JSON.stringify(result);
  assert.ok(serialized.includes('/workspace/project'));
  assert.ok(serialized.includes('conversation'));
  assert.ok(serialized.includes('userInput'));
  assert.doesNotMatch(serialized, /private|messages|toolOutput|arbitrary|question"\s*:/);
});

test('sessions index bounds change counters and omits absent or invalid change summaries', () => {
  const result = parseSessionsIndex({ sessions: [
    { ...session('changed'), changeSummary: { added: 1e20, removed: 2, files: 3 } },
    { ...session('invalid'), changeSummary: { added: -1, removed: Number.NaN, files: Infinity } },
    session('quiet'),
  ] });
  const summary = result[0].changeSummary;
  assert.ok(summary && typeof summary === 'object');
  assert.ok(typeof summary.added === 'number' && summary.added > 0 && summary.added <= 1_000_000);
  assert.equal(summary.removed, 2);
  assert.equal(summary.files, 3);
  assert.ok(!result[1].changeSummary);
  assert.ok(!result[2].changeSummary);
});

test('index preserves exact workspace paths and rejects malformed unread timestamps', () => {
  const path = '/workspace/project  name ';
  const result = parseSessionsIndex({ sessions: [
    { ...session('path'), root:path, workspacePath:path, unreadAt:'invalid' },
    { ...session('negative'), unreadAt:-1 },
    { ...session('long-path'), workspacePath:'x'.repeat(4097) },
  ] });
  assert.equal(result[0].root, path);
  assert.equal(result[0].workspacePath, path);
  assert.equal(result[0].unreadAt, undefined);
  assert.equal(result[1].unreadAt, undefined);
  assert.equal(result[2].workspacePath, undefined);
});

test('sessions index falls back to the complete legacy list when the index endpoint is unavailable', () => {
  const previous = [session('old')];
  const legacy = [session('new'), session('outside-index')];
  assert.deepEqual(rows(mergeSessionsIndex(previous, success(legacy), failure('404'))), legacy);
  assert.deepEqual(mergeSessionsIndex(previous, failure('legacy unavailable'), failure('index unavailable')),
    failure('legacy unavailable'));
});

test('a malformed successful index response falls back to the complete legacy API list', async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  const legacy = [session('existing'), session('outside-index')];
  globalThis.fetch = async input => {
    const path = String(input);
    requests.push(path);
    assert.ok(path === '/api/sessions' || path === '/api/sessions/index');
    return new Response(JSON.stringify(path === '/api/sessions' ? { sessions: legacy } : { sessions: {} }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  };
  try {
    assert.deepEqual(rows(await loadSidebarSessions([session('old')])), legacy);
    assert.deepEqual(new Set(requests), new Set(['/api/sessions', '/api/sessions/index']));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('bounded sessions index augments the authoritative legacy list and respects its archive removals', () => {
  const previous = [session('archived'), session('indexed')];
  const legacy = [session('indexed', { title: 'Fresh legacy title' }), session('outside-index')];
  const result = rows(mergeSessionsIndex(previous, success(legacy), success([
    session('indexed', { title: 'Fresh indexed title', unread: true }),
  ])));
  assert.deepEqual(new Set(result.map(item => item.id)), new Set(['indexed', 'outside-index']));
  assert.equal(result.find(item => item.id === 'indexed')?.title, 'Fresh indexed title');
  assert.equal(result.find(item => item.id === 'indexed')?.unread, true);
});

test('a stale index snapshot cannot resurrect a row removed from the complete legacy list', () => {
  const archived = session('archived');
  const existing = session('existing');
  const result = rows(mergeSessionsIndex([archived, existing], success([existing]), success([
    archived, session('existing', { unread: true }), session('newer-than-legacy'),
  ])));
  assert.deepEqual(result.map(item => item.id), ['existing']);
  assert.equal(result[0].unread, true);
  assert.deepEqual(rows(mergeSessionsIndex([archived], success([]), success([archived]))), []);
});

test('a legacy refresh failure preserves existing rows omitted by the bounded index', () => {
  const previous = [session('indexed'), session('large-journal'), session('older-than-limit')];
  const result = rows(mergeSessionsIndex(previous, failure('temporary disconnection'), success([
    session('indexed', { status: 'awaiting_user', pendingInteraction: { kind: 'userInput' } }),
  ])));
  assert.deepEqual(new Set(result.map(item => item.id)), new Set(previous.map(item => item.id)));
  assert.equal(result.find(item => item.id === 'indexed')?.status, 'awaiting_user');
  assert.ok(result.find(item => item.id === 'indexed')?.pendingInteraction);
  assert.deepEqual(result.find(item => item.id === 'large-journal'), previous[1]);
});

test('a fresh indexed row clears resolved attention at both top level and inside the previous sidecar', () => {
  const stale = session('indexed', {
    unread: true, pendingInteraction: { kind: 'permission' }, changeSummary: { added: 2 },
    sidecar: { unread: true, pendingInteraction: { kind: 'permission' }, changeSummary: { files: 1 } },
  });
  for (const legacy of [failure('temporary disconnection'), success([stale])]) {
    const [result] = rows(mergeSessionsIndex([stale], legacy, success([session('indexed')])));
    assert.ok(!result.unread);
    assert.ok(!result.pendingInteraction);
    assert.ok(!result.changeSummary);
    assert.ok(!result.sidecar?.unread);
    assert.ok(!result.sidecar?.pendingInteraction);
    assert.ok(!result.sidecar?.changeSummary);
  }
});

test('sidebar refresh shares its cancellation signal with both independent read requests', async () => {
  const controller = new AbortController();
  const calls: { endpoint: string; signal?: AbortSignal }[] = [];
  const result = await loadSidebarSessions([], controller.signal, {
    legacy: async signal => { calls.push({ endpoint: 'legacy', signal }); return success([session('one'), session('two')]); },
    index: async signal => { calls.push({ endpoint: 'index', signal }); return success([session('one', { unread: true })]); },
  });
  assert.deepEqual(new Set(calls.map(call => call.endpoint)), new Set(['legacy', 'index']));
  assert.ok(calls.every(call => call.signal === controller.signal));
  assert.deepEqual(new Set(rows(result).map(item => item.id)), new Set(['one', 'two']));
  assert.equal(rows(result).find(item => item.id === 'one')?.unread, true);
});

test('remote sidecars accept bounded configuration facts and drop private fields and invented lifecycle states', () => {
  const states = ['configured', 'changed', 'missing', 'unavailable', 'unsupported'];
  const parsed = parseSessionsIndex({ sessions: states.map(configuration => ({
    ...session(configuration), sidecar: { remote: {
      connectionId: 'lab-1', configuration, connectionState: 'unknown',
      digest: 'private digest', host: 'private host', argv: ['private command'], reconnecting: true,
    } },
  })) });
  for (const [index, row] of parsed.entries()) {
    assert.deepEqual(row.remote, { connectionId: 'lab-1', configuration: states[index], connectionState: 'unknown' });
    assert.deepEqual(row.sidecar?.remote, row.remote);
  }
  assert.doesNotMatch(JSON.stringify(parsed), /private|digest|host|argv|reconnecting/);
  const valid = { connectionId: 'lab', configuration: 'configured', connectionState: 'unknown' };
  for (const remote of [null, [], {}, true, { ...valid, connectionId: '' },
    { ...valid, connectionId: 'x'.repeat(65) }, { ...valid, connectionId: 'lab\n' },
    { ...valid, configuration: 'connected' }, { ...valid, connectionState: 'retrying' },
    { ...valid, connectionState: 'online' }, { ...valid, connectionState: true },
    { ...valid, connectionState: undefined }]) {
    assert.equal(normalizeRemoteSummary(remote), undefined);
  }
});

test('remote sidecars accept the four recorded connection phases and still drop private fields', () => {
  const phases = ['pending', 'reconnecting', 'connected', 'disconnected'] as const;
  const parsed = parseSessionsIndex({ sessions: phases.map(connectionState => ({
    ...session(connectionState), sidecar: { remote: {
      connectionId: 'lab', configuration: 'configured', connectionState,
      digest: 'private digest', host: 'private host', argv: ['private command'], reconnecting: true,
    } },
  })) });
  for (const [index, row] of parsed.entries()) {
    assert.deepEqual(row.remote, { connectionId: 'lab', configuration: 'configured', connectionState: phases[index] });
    assert.deepEqual(row.sidecar?.remote, row.remote);
  }
  assert.doesNotMatch(JSON.stringify(parsed), /private|digest|host|argv/);
  assert.equal(JSON.stringify(parsed).includes('"reconnecting":true'), false);
});

test('fresh index omissions clear remote summaries and index outage keeps complete legacy rows without remote guesses', () => {
  const stale = session('remote', { remote: { connectionId: 'lab', configuration: 'configured', connectionState: 'unknown' },
    sidecar: { remote: { connectionId: 'lab', configuration: 'configured', connectionState: 'unknown' } } });
  for (const legacy of [failure('temporary outage'), success([stale])]) {
    const [fresh] = rows(mergeSessionsIndex([stale], legacy, success([session('remote')])));
    assert.equal(fresh.remote, undefined);
    assert.equal(fresh.sidecar?.remote, undefined);
  }
  const [fallback] = rows(mergeSessionsIndex([stale], success([session('remote')]), failure('index unavailable')));
  assert.equal(fallback.id, 'remote');
  assert.equal(fallback.remote, undefined);
});
