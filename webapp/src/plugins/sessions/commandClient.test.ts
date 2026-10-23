import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CommandDeliveryUnconfirmedError, CommandRefusedError, createSessionCommandId, SessionCommandClient } from './commandClient';
import { approvePending, createSession, createSessionCommandClient, queueTurn, runSession, sendTurn, stopSession, updateConversationMessage } from '../../xuenessWorkbench';
import type { TimelineRow } from '../../xuenessWorkbench';

const unused = async (): Promise<never> => { throw new Error('Unexpected REST fallback'); };
const accepted = (commandId: string, result: unknown = { saved: true }) => ({ commandId, status: 'accepted', result });

test('lost command ACK queries its original identity without replaying the write or prepared input', async () => {
  const writes: { path: string; body: unknown }[] = [];
  const reads: string[] = [];
  const client = new SessionCommandClient({ isEffective: () => true,
    post: async (path, body) => { writes.push({ path, body }); throw new TypeError('Lost response'); },
    get: async path => { reads.push(path); return { result: accepted('original', { saved: true }) }; },
  });
  const result = await client.submit('a/b', 'send', { text: 'hello', prepared_token: 'once' }, unused, 'original');
  assert.deepEqual(result, { saved: true });
  assert.deepEqual(writes, [{ path: '/api/sessions/a%2Fb/commands', body: {
    commandId: 'original', type: 'send', payload: { text: 'hello', prepared_token: 'once' },
  } }]);
  assert.deepEqual(reads, ['/api/sessions/a%2Fb/commands/original']);
  client.dispose();
});

test('a real POST deadline still permits a fresh query to recover accepted delivery', async () => {
  let posts = 0; let queries = 0; let aborted = false;
  const client = new SessionCommandClient({ isEffective: () => true, timeoutMs: 20,
    post: async (_path, _body, signal) => new Promise((_resolve, reject) => {
      posts++; signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true });
    }),
    get: async (_path, signal) => { queries++; assert.equal(signal.aborted, false); return { result: accepted('deadline') }; },
  });
  assert.deepEqual(await client.submit('s', 'send', { text: 'hello' }, unused, 'deadline'), { saved: true });
  assert.equal(aborted, true); assert.equal(posts, 1); assert.equal(queries, 1);
  client.dispose();
});

test('concurrent calls with one command identity share admission, and distinct intent gets a timestamp identity', async () => {
  let writes = 0; let release: (value: unknown) => void = () => undefined;
  const client = new SessionCommandClient({ isEffective: () => true,
    post: async () => { writes++; return new Promise(resolve => { release = resolve; }); }, get: unused,
  });
  const first = client.submit('s', 'queue', { text: 'a' }, unused, 'same');
  const second = client.submit('s', 'queue', { text: 'a' }, unused, 'same');
  assert.equal(first, second); assert.equal(writes, 1);
  await assert.rejects(client.submit('s', 'queue', { text: 'different' }, unused, 'same'), /different input/u);
  release(accepted('same', { id: 'queue' }));
  assert.deepEqual(await first, { id: 'queue' });
  assert.deepEqual(await client.submit('s', 'queue', { text: 'a' }, unused, 'same'), { id: 'queue' });
  assert.equal(writes, 1);
  const id = createSessionCommandId();
  assert.match(id, /^c_[0-9]{13}_[a-f0-9-]{36}$/u); assert.notEqual(id, createSessionCommandId());
  client.dispose();
});

test('duplicate acceptance and duplicate rejection preserve the original decision', async () => {
  for (const originalStatus of ['accepted', 'rejected'] as const) {
    let queries = 0;
    const client = new SessionCommandClient({ isEffective: () => true,
      post: async () => ({ commandId: 'same', status: 'duplicate', originalStatus, result: { saved: true }, message: 'refused' }),
      get: async () => { queries++; return {}; },
    });
    const pending = client.submit('s', 'send', { text: 'a' }, unused, 'same');
    if (originalStatus === 'accepted') assert.deepEqual(await pending, { saved: true });
    else await assert.rejects(pending, CommandRefusedError);
    assert.equal(queries, 0); client.dispose();
  }
});

test('permission refusals and known-unsent preflight failures do not query or replay', async () => {
  for (const error of [Object.assign(new Error('Forbidden'), { status: 403 }),
    Object.assign(new TypeError('CSRF unavailable'), { requestNotSent: true }),
    Object.assign(new DOMException('CSRF aborted', 'AbortError'), { requestNotSent: true })]) {
    let posts = 0; let queries = 0;
    const client = new SessionCommandClient({ isEffective: () => true,
      post: async () => { posts++; throw error; }, get: async () => { queries++; return {}; },
    });
    await assert.rejects(client.submit('s', 'stop', { expected_turn_id: 'turn' }, unused), err => err === error);
    assert.equal(posts, 1); assert.equal(queries, 0); client.dispose();
  }
});

test('unknown or malformed query results stay uncertain after at most three reads', async () => {
  for (const response of [{ result: 'unknown' }, { result: accepted('different') },
    { result: { commandId: 'identity', status: 'duplicate' } }]) {
    let posts = 0; let queries = 0;
    const client = new SessionCommandClient({ isEffective: () => true, queryAttempts: 100,
      post: async () => { posts++; throw new TypeError('Lost ACK'); }, get: async () => { queries++; return response; },
    });
    await assert.rejects(client.submit('s', 'queue', { text: 'a' }, unused, 'identity'), error =>
      error instanceof CommandDeliveryUnconfirmedError && error.commandId === 'identity');
    assert.equal(posts, 1); assert.equal(queries, 3); client.dispose();
  }
});

test('failed admission may have persisted effects and remains unconfirmed without replay', async () => {
  for (const ack of [{ commandId: 'identity', status: 'failed' },
    { commandId: 'identity', status: 'duplicate', originalStatus: 'failed' }]) {
    const client = new SessionCommandClient({ isEffective: () => true, post: async () => ack, get: unused });
    await assert.rejects(client.submit('s', 'send', { text: 'a' }, unused, 'identity'), CommandDeliveryUnconfirmedError);
    client.dispose();
  }
});

test('a terminal failed run preserves its provider message and allows only a later explicit send', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ values: {} });
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  const writes: { type: string; text?: string }[] = [];
  let runCount = 0;
  let acceptedCount = 0;
  const client = new SessionCommandClient({ receiptScope: 'terminal-provider-failure', receiptStorage: storage, isEffective: () => true,
    post: async (_path, value) => {
      const body = value as { commandId: string; type: string; payload: { text?: string } };
      writes.push({ type: body.type, ...(body.payload.text ? { text: body.payload.text } : {}) });
      if (body.type === 'send') return accepted(body.commandId, { id: 's', status: 'ready' });
      assert.equal(body.type, 'run');
      if (++runCount === 1) return { commandId: body.commandId, status: 'failed', reasonCode: 'provider_rate_limited',
        message: 'The model service rate-limited the request (HTTP 429).', result: { error: 'provider rate limited' } };
      return accepted(body.commandId, { id: 's', status: 'ready' });
    }, get: unused,
  });
  try {
    const first = await sendTurn('s', 'first question', undefined, undefined, () => { acceptedCount++; }, client);
    assert.equal(first.ok, false);
    if (first.ok) assert.fail('the provider refusal must be visible');
    assert.equal(first.accepted, true);
    assert.equal(first.outcomeUnknown, undefined);
    assert.match(first.error, /rate-limited the request/iu);
    assert.deepEqual(writes, [{ type: 'send', text: 'first question' }, { type: 'run' }], 'the failed prompt is sent once and the run is never retried');
    assert.equal(client.pendingCommands().length, 0, 'a terminal run ACK releases its fence');
    assert.equal(acceptedCount, 1);

    const next = await sendTurn('s', 'next question', undefined, undefined, () => { acceptedCount++; }, client);
    assert.deepEqual(next, { ok: true, value: undefined });
    assert.deepEqual(writes, [
      { type: 'send', text: 'first question' }, { type: 'run' },
      { type: 'send', text: 'next question' }, { type: 'run' },
    ]);
    assert.equal(acceptedCount, 2);
    assert.equal(client.pendingCommands().length, 0);
  } finally {
    client.dispose();
    globalThis.fetch = previousFetch;
  }
});

test('disabled command support makes one REST write and never replays uncertain delivery', async () => {
  let writes = 0;
  const client = new SessionCommandClient({ isEffective: () => false, post: unused, get: unused });
  const fallback = async () => { writes++; throw new TypeError('Lost REST response'); };
  await assert.rejects(client.submit('s', 'queue', { text: 'a' }, fallback, 'identity'), CommandDeliveryUnconfirmedError);
  await assert.rejects(client.submit('s', 'queue', { text: 'a' }, fallback, 'identity'), CommandDeliveryUnconfirmedError);
  assert.equal(writes, 1);
  await assert.rejects(client.query('s', 'identity'), CommandDeliveryUnconfirmedError);
  client.dispose();
});

test('disable during a lost response starts no query and never switches the submitted write to REST', async () => {
  let enabled = true; let posts = 0;
  const client = new SessionCommandClient({ isEffective: () => enabled,
    post: async () => { posts++; enabled = false; throw new TypeError('Lost ACK'); }, get: unused,
  });
  await assert.rejects(client.submit('s', 'send', { text: 'a' }, unused, 'identity'), CommandDeliveryUnconfirmedError);
  await assert.rejects(client.submit('s', 'send', { text: 'a' }, unused, 'identity'), CommandDeliveryUnconfirmedError);
  assert.equal(posts, 1); client.dispose();
});

test('unmount cancels the actual request, rejects admission, and releases the pending capacity', async () => {
  let attached = false; let cancelled = false;
  const client = new SessionCommandClient({ isEffective: () => true, maxPending: 1,
    post: async (_path, body, signal) => {
      if (attached) return accepted((body as { commandId: string }).commandId);
      attached = true;
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
        cancelled = true; reject(signal.reason);
      }, { once: true }));
    }, get: unused,
  });
  const first = client.submit('s', 'send', { text: 'a' }, unused, 'first');
  await assert.rejects(client.submit('s', 'send', { text: 'b' }, unused, 'second'), /Too many pending/u);
  client.cancelPending();
  await assert.rejects(first, CommandDeliveryUnconfirmedError); assert.equal(cancelled, true);
  assert.deepEqual(await client.submit('s', 'send', { text: 'c' }, unused, 'third'), { saved: true });
  client.dispose();
  await assert.rejects(client.submit('s', 'send', { text: 'd' }, unused), /disposed/u);
});

test('explicit query can reconcile an unconfirmed command but never sends it again', async () => {
  let known = false; let posts = 0;
  const client = new SessionCommandClient({ isEffective: () => true,
    post: async () => { posts++; throw new TypeError('Lost ACK'); },
    get: async () => ({ result: known ? accepted('identity') : 'unknown' }),
  });
  await assert.rejects(client.submit('s', 'send', { text: 'a' }, unused, 'identity'), CommandDeliveryUnconfirmedError);
  known = true;
  assert.deepEqual(await client.query('s', 'identity'), accepted('identity')); assert.equal(posts, 1);
  client.dispose();
});

test('workbench command adapters preserve run admission and stop turn identity while using existing projection refresh', async () => {
  const previous = globalThis.fetch;
  const mutations: { path: string; body: Record<string, unknown> }[] = [];
  globalThis.fetch = async (path, init) => {
    if (path === '/api/csrf') return Response.json({ csrfToken: 'fixture' });
    if (!init?.method) return Response.json({});
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    mutations.push({ path: String(path), body });
    if (String(path).endsWith('/commands')) return Response.json(accepted(String(body.commandId),
      body.type === 'stop' ? { stopping: true } : body.type === 'queue'
        ? { id: 'q1', item: { id: 'q1', text: 'queued', status: 'queued', position: 1 } } : { id: 's', status: 'paused', steps: 0 }));
    return Response.json({});
  };
  const client = createSessionCommandClient(() => true);
  try {
    assert.equal((await sendTurn('s', 'sent', undefined, 'prepared', undefined, client)).ok, true);
    assert.equal((await queueTurn('s', 'queued', undefined, client)).ok, true);
    assert.deepEqual(await stopSession('s', 'turn-1', client), { ok: true, value: { stopping: true } });
    assert.deepEqual(mutations.map(row => row.path), ['/api/sessions/s/commands', '/api/sessions/s/commands',
      '/api/sessions/s/commands', '/api/sessions/s/commands']);
    assert.deepEqual(mutations.map(row => row.body.type), ['send', 'run', 'queue', 'stop']);
    assert.notEqual(mutations[0].body.commandId, mutations[1].body.commandId);
    assert.deepEqual(mutations[0].body.payload, { text: 'sent', prepared_token: 'prepared' });
    assert.deepEqual(mutations[3].body.payload, { expected_turn_id: 'turn-1' });
  } finally { client.dispose(); globalThis.fetch = previous; }
});

test('creation recovers its collection receipt without replaying the prepared token, independently of session commands', async () => {
  const writes: { path: string; body: unknown }[] = []; const reads: string[] = [];
  const result = { id: 'a'.repeat(32), status: 'paused', root: '/fixture' };
  const client = new SessionCommandClient({ isEffective: () => true,
    post: async (path, body) => { writes.push({ path, body }); throw new TypeError('Lost ACK'); },
    get: async path => { reads.push(path); return { result: accepted('identity', result) }; },
  });
  const body = { task: 'create', prepared_token: 'one-use' };
  const first = client.submitCreate(body, unused, 'identity');
  assert.equal(client.submitCreate(body, unused, 'identity'), first);
  assert.deepEqual(await first, result);
  await assert.rejects(client.submitCreate({ task: 'changed' }, unused, 'identity'), /different input/u);
  assert.deepEqual(await client.queryCreate('identity'), accepted('identity', result));
  await client.submit('a'.repeat(32), 'run', {}, unused, 'identity');
  assert.deepEqual(writes.map(row => row.path), ['/api/sessions/commands', `/api/sessions/${'a'.repeat(32)}/commands`]);
  assert.deepEqual(writes[0].body, { commandId: 'identity', type: 'create_session', payload: body });
  assert.deepEqual(reads.slice(0, 2), ['/api/sessions/commands/identity', '/api/sessions/commands/identity']);
  client.dispose();
});

test('workbench creation and its run use separate queryable identities and never invoke legacy mutations', async () => {
  const previous = globalThis.fetch; const id = 'b'.repeat(32);
  const mutations: { path: string; body: Record<string, unknown> }[] = []; const reads: string[] = [];
  const receipts = new Map<string, unknown>(); let createdLocally = '';
  const client = createSessionCommandClient(() => true);
  globalThis.fetch = async (path, init) => {
    if (path === '/api/csrf') return Response.json({ csrfToken: 'fixture' });
    if (!init?.method) {
      reads.push(String(path));
      return Response.json({ result: receipts.get(String(path)) ?? 'unknown' });
    }
    const body = JSON.parse(String(init.body)); mutations.push({ path: String(path), body });
    assert.ok(String(path).endsWith('/commands'));
    const ack = accepted(body.commandId, body.type === 'create_session'
      ? { id, status: 'paused', root: '/fixture' } : { id, status: 'completed', steps: 1 });
    if (body.type === 'run') assert.equal(createdLocally, id);
    receipts.set(`${path}/${body.commandId}`, ack);
    throw new TypeError('Lost committed response');
  };
  try {
    assert.deepEqual(await createSession('hello', { provider: 'real', mode: 'plan' },
      { root: '/fixture', prepared_token: 'prepared-once' }, created => { createdLocally = created; }, client), { ok: true, value: id });
    assert.deepEqual(mutations.map(row => row.path), ['/api/sessions/commands', `/api/sessions/${id}/commands`]);
    assert.deepEqual(mutations.map(row => row.body.type), ['create_session', 'run']);
    assert.notEqual(mutations[0].body.commandId, mutations[1].body.commandId);
    assert.deepEqual(mutations[0].body.payload, { task: 'hello', root: '/fixture', prepared_token: 'prepared-once' });
    assert.equal((mutations[1].body.payload as Record<string, unknown>).mode, 'plan');
    assert.ok(mutations.every(row => reads.includes(`${row.path}/${row.body.commandId}`)));
  } finally { client.dispose(); globalThis.fetch = previous; }
});

test('unknown creation retains its command identity, performs only bounded queries and cannot start a run', async () => {
  const previous = globalThis.fetch; let createdLocally = false;
  const writes: { path: string; body: Record<string, unknown> }[] = []; const reads: string[] = [];
  const client = createSessionCommandClient(() => true);
  globalThis.fetch = async (path, init) => {
    if (path === '/api/csrf') return Response.json({ csrfToken: 'fixture' });
    if (!init?.method) { reads.push(String(path)); return Response.json({ result: 'unknown' }); }
    writes.push({ path: String(path), body: JSON.parse(String(init.body)) }); throw new TypeError('Lost response');
  };
  try {
    const result = await createSession('hello', undefined, undefined, () => { createdLocally = true; }, client);
    assert.equal(result.ok, false); assert.equal(result.outcomeUnknown, true); assert.equal(result.accepted, undefined);
    assert.equal(createdLocally, false); assert.equal(writes.length, 1);
    assert.equal(result.commandId, writes[0].body.commandId);
    assert.deepEqual(reads, Array(3).fill(`/api/sessions/commands/${result.commandId}`));
  } finally { client.dispose(); globalThis.fetch = previous; }
});

test('a long run can stay unknown, later reconcile by query, and never repeat the run write', async () => {
  let settled = false; let writes = 0; const reads: string[] = [];
  const client = new SessionCommandClient({ isEffective: () => true, timeoutMs: 20,
    post: async (_path, _body, signal) => { writes++; return new Promise((_resolve, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })); },
    get: async path => { reads.push(path); return { result: settled ? accepted('run-id', { id: 's', status: 'completed' }) : 'unknown' }; },
  });
  await assert.rejects(client.submit('s', 'run', {}, unused, 'run-id'), CommandDeliveryUnconfirmedError);
  await assert.rejects(client.submit('s', 'run', {}, unused, 'run-id'), CommandDeliveryUnconfirmedError);
  assert.equal(reads.length, 3); settled = true;
  assert.deepEqual(await client.query('s', 'run-id'), accepted('run-id', { id: 's', status: 'completed' }));
  assert.equal(writes, 1); client.dispose();
});

test('a lost run keeps the admitted input acknowledged and exposes the run identity for read-only recovery', async () => {
  const previous = globalThis.fetch; let acceptedLocally = false;
  const writes: Record<string, unknown>[] = []; const reads: string[] = [];
  const client = createSessionCommandClient(() => true);
  globalThis.fetch = async (path, init) => {
    if (path === '/api/csrf') return Response.json({ csrfToken: 'fixture' });
    if (!init?.method) { reads.push(String(path)); return Response.json({ result: 'unknown' }); }
    assert.equal(path, '/api/sessions/s/commands'); const body = JSON.parse(String(init.body)); writes.push(body);
    if (body.type === 'run') throw new TypeError('Lost run response');
    return Response.json(accepted(body.commandId, { id: 's', status: 'paused', steps: 0 }));
  };
  try {
    const result = await sendTurn('s', 'hello', undefined, undefined, () => { acceptedLocally = true; }, client);
    assert.equal(result.ok, false); assert.equal(result.accepted, true); assert.equal(result.outcomeUnknown, true);
    assert.equal(acceptedLocally, true); assert.equal(result.commandId, writes[1].commandId);
    assert.deepEqual(writes.map(row => row.type), ['send', 'run']);
    assert.equal(reads.filter(path => path.endsWith(`/${result.commandId}`)).length, 3);
  } finally { client.dispose(); globalThis.fetch = previous; }
});

test('malformed create and run results are unconfirmed, and creation cannot use a malformed id to start execution', async () => {
  const previous = globalThis.fetch;
  for (const type of ['create_session', 'run']) {
    const writes: Record<string, unknown>[] = []; let createdLocally = false;
    const client = createSessionCommandClient(() => true);
    globalThis.fetch = async (path, init) => {
      if (path === '/api/csrf') return Response.json({ csrfToken: 'fixture' });
      if (!init?.method) return Response.json({});
      const body = JSON.parse(String(init.body)); writes.push(body);
      return Response.json(accepted(body.commandId, { id: 'another-session', status: 'paused' }));
    };
    try {
      const result = type === 'create_session'
        ? await createSession('hello', undefined, undefined, () => { createdLocally = true; }, client)
        : await runSession('s', undefined, undefined, client);
      assert.equal(result.ok, false); assert.equal(result.outcomeUnknown, true);
      assert.equal(result.commandId, writes[0].commandId); assert.equal(createdLocally, false);
      assert.deepEqual(writes.map(row => row.type), [type]);
    } finally { client.dispose(); }
  }
  globalThis.fetch = previous;
});

test('creation stops before running if disabled after its ACK; disabled-at-start create and run use legacy REST once', async () => {
  const previous = globalThis.fetch; const id = 'd'.repeat(32);
  for (const initiallyEnabled of [true, false]) {
    let enabled = initiallyEnabled; const writes: string[] = []; let createdLocally = '';
    const client = createSessionCommandClient(() => enabled);
    globalThis.fetch = async (path, init) => {
      if (path === '/api/csrf') return Response.json({ csrfToken: 'fixture' });
      if (!init?.method) return Response.json({});
      writes.push(String(path)); enabled = false;
      const result = { id, status: 'paused', root: '/fixture', steps: 0 };
      return Response.json(initiallyEnabled ? accepted(JSON.parse(String(init.body)).commandId, result) : result);
    };
    try {
      const result = await createSession('hello', undefined, undefined, created => { createdLocally = created; }, client);
      assert.equal(createdLocally, id);
      if (initiallyEnabled) {
        assert.equal(result.ok, false); assert.equal(result.accepted, true); assert.equal(result.id, id);
        assert.deepEqual(writes, ['/api/sessions/commands']);
      } else {
        assert.deepEqual(result, { ok: true, value: id });
        assert.deepEqual(writes, ['/api/sessions', `/api/sessions/${id}/run`]);
      }
    } finally { client.dispose(); }
  }
  globalThis.fetch = previous;
});

test('disabling a standalone run during opt-in loading prevents both command and legacy preflight writes', async () => {
  const previous = globalThis.fetch; let enabled = true; const paths: string[] = [];
  let release: (response: Response) => void = () => undefined;
  let started: () => void = () => undefined;
  const loading = new Promise<void>(resolve => { started = resolve; });
  const client = createSessionCommandClient(() => enabled);
  globalThis.fetch = async path => {
    paths.push(String(path));
    if (path !== '/api/settings/agent') throw new Error('Unexpected request after disable');
    started(); return new Promise(resolve => { release = resolve; });
  };
  try {
    const pending = runSession('s', undefined, undefined, client);
    await loading; enabled = false; release(Response.json({ values: {} }));
    assert.equal((await pending).ok, false);
    assert.deepEqual(paths, ['/api/settings/agent']);
  } finally { client.dispose(); globalThis.fetch = previous; }
});

test('run commands retain permission acknowledgement and queue reservation; a known refusal allows a new intent', async () => {
  const previous = globalThis.fetch; const writes: Record<string, unknown>[] = []; let queries = 0;
  const client = createSessionCommandClient(() => true);
  globalThis.fetch = async (path, init) => {
    if (path === '/api/csrf') return Response.json({ csrfToken: 'fixture' });
    if (!init?.method) {
      if (String(path).includes('/commands/')) queries++;
      return Response.json({ values: { allowMcp: true, allowSubagents: false } });
    }
    assert.equal(path, '/api/sessions/s/commands'); const body = JSON.parse(String(init.body)); writes.push(body);
    return Response.json(writes.length === 1
      ? { commandId: body.commandId, status: 'rejected', reasonCode: 'state_conflict', message: 'session is in use by another process' }
      : accepted(body.commandId, { id: 's', status: 'completed', steps: 1 }));
  };
  try {
    const choices = { provider: 'real', mode: 'build', permission_mode: 'yolo', acknowledge_yolo: true } as const;
    const options = { continueQueue: true, promotionRequestId: 'reservation' };
    const refused = await runSession('s', choices, options, client);
    assert.equal(refused.ok, false); assert.equal(refused.outcomeUnknown, undefined);
    assert.equal((await runSession('s', choices, options, client)).ok, true);
    assert.equal(queries, 0); assert.equal(writes.length, 2);
    assert.notEqual(writes[0].commandId, writes[1].commandId);
    assert.equal(writes[0].type, 'run');
    assert.deepEqual(writes[0].payload, { ...choices, allow_mcp: true, allow_subagents: false,
      allow_hooks: false, continue_queue: true, promotion_request_id: 'reservation' });
  } finally { client.dispose(); globalThis.fetch = previous; }
});

test('admitted send cannot start the run after plugin disabling, and its draft remains acknowledged', async () => {
  const previous = globalThis.fetch; let enabled = true; let acceptedLocally = false; const writes: string[] = [];
  const client = createSessionCommandClient(() => enabled);
  globalThis.fetch = async (path, init) => {
    if (path === '/api/csrf') return Response.json({ csrfToken: 'fixture' });
    if (!init?.method) return Response.json({});
    writes.push(String(path)); const envelope = JSON.parse(String(init.body)); enabled = false;
    return Response.json(accepted(envelope.commandId, { id: 's', status: 'paused', steps: 0 }));
  };
  try {
    const result = await sendTurn('s', 'hello', undefined, undefined, () => { acceptedLocally = true; }, client);
    assert.equal(result.ok, false); assert.equal(result.accepted, true); assert.equal(acceptedLocally, true);
    assert.deepEqual(writes, ['/api/sessions/s/commands']);
  } finally { client.dispose(); globalThis.fetch = previous; }
});

test('disabling during the run CSRF preflight cannot start execution after admitted delivery', async () => {
  const previous = globalThis.fetch; let enabled = true; let csrfReads = 0; const writes: string[] = [];
  let releaseCsrf: (response: Response) => void = () => undefined;
  let preflightStarted: () => void = () => undefined;
  const preflight = new Promise<void>(resolve => { preflightStarted = resolve; });
  const client = createSessionCommandClient(() => enabled);
  globalThis.fetch = async (path, init) => {
    if (path === '/api/csrf') {
      if (++csrfReads === 2) {
        preflightStarted(); return new Promise(resolve => { releaseCsrf = resolve; });
      }
      return Response.json({ csrfToken: 'fixture' });
    }
    if (!init?.method) return Response.json({});
    writes.push(String(path));
    return Response.json(accepted(JSON.parse(String(init.body)).commandId, { id: 's', status: 'paused', steps: 0 }));
  };
  try {
    const pending = sendTurn('s', 'hello', undefined, undefined, undefined, client);
    await preflight; enabled = false; releaseCsrf(Response.json({ csrfToken: 'fixture' }));
    const result = await pending;
    assert.equal(result.ok, false); assert.equal(result.accepted, true);
    assert.deepEqual(writes, ['/api/sessions/s/commands']);
  } finally { client.dispose(); globalThis.fetch = previous; }
});

test('malformed send admission never starts a run or reports a known refusal', async () => {
  const previous = globalThis.fetch; const writes: string[] = [];
  const client = createSessionCommandClient(() => true);
  globalThis.fetch = async (path, init) => {
    if (path === '/api/csrf') return Response.json({ csrfToken: 'fixture' });
    writes.push(String(path));
    return Response.json(accepted(JSON.parse(String(init?.body)).commandId, { id: 'another-session', status: 'paused' }));
  };
  try {
    const result = await sendTurn('s', 'hello', undefined, undefined, undefined, client);
    assert.equal(result.ok, false); assert.equal(result.outcomeUnknown, true); assert.equal(result.accepted, undefined);
    assert.deepEqual(writes, ['/api/sessions/s/commands']);
  } finally { client.dispose(); globalThis.fetch = previous; }
});

const editRevision = `sha256:${'a'.repeat(64)}`;
const editedRevision = `sha256:${'b'.repeat(64)}`;
const editRow: Extract<TimelineRow, {kind: 'user'}> = {
  kind: 'user', seq: 1, turnId: 'turn-1', text: 'old task', messageIndex: 0, messageRevision: editRevision,
};
const editResult = { id: 's', messageIndex: 0, action: 'edit', revision: editedRevision };

test('editing recovers a lost ACK by its identity before admitting a separate permission-bound run', async () => {
  const previous = globalThis.fetch; const writes: Record<string, unknown>[] = []; const reads: string[] = [];
  const receipts = new Map<string, unknown>(); let admitted = false;
  const client = createSessionCommandClient(() => true);
  globalThis.fetch = async (path, init) => {
    if (path === '/api/csrf') return Response.json({ csrfToken: 'fixture' });
    if (!init?.method) {
      reads.push(String(path));
      return Response.json({ result: receipts.get(String(path)) ?? 'unknown' });
    }
    assert.equal(path, '/api/sessions/s/commands');
    const body = JSON.parse(String(init.body)); writes.push(body);
    if (body.type === 'run') { assert.equal(admitted, true); return Response.json(accepted(body.commandId, { id: 's', status: 'completed' })); }
    assert.equal(admitted, false);
    receipts.set(`${path}/${body.commandId}`, accepted(body.commandId, editResult));
    throw new TypeError('Lost committed edit response');
  };
  try {
    const updated = await updateConversationMessage('s', editRow, { action: 'edit', text: 'replacement task' }, client);
    assert.equal(updated.ok, true); assert.equal(updated.commandId, writes[0].commandId);
    if (updated.ok) { admitted = true; assert.equal((await runSession('s', { provider: 'real', mode: 'build', permission_mode: 'yolo', acknowledge_yolo: true }, undefined, client)).ok, true); }
    assert.deepEqual(writes.map(row => row.type), ['edit_message', 'run']);
    assert.notEqual(writes[0].commandId, writes[1].commandId);
    assert.deepEqual(writes[0].payload, { revision: editRevision, messageIndex: 0, action: 'edit', text: 'replacement task' });
    assert.equal((writes[1].payload as Record<string, unknown>).acknowledge_yolo, true);
    assert.equal((writes[1].payload as Record<string, unknown>).permission_mode, 'yolo');
    assert.deepEqual(reads.filter(path => path.includes('/commands/')), [`/api/sessions/s/commands/${updated.commandId}`]);
  } finally { client.dispose(); globalThis.fetch = previous; }
});

test('another Save of an unknown edit only queries; changing its draft cannot create a new write', async () => {
  const previous = globalThis.fetch; let known = false; let writes = 0; const reads: string[] = []; let commandId = '';
  const client = createSessionCommandClient(() => true);
  globalThis.fetch = async (path, init) => {
    if (path === '/api/csrf') return Response.json({ csrfToken: 'fixture' });
    if (!init?.method) { reads.push(String(path)); return Response.json({ result: known ? accepted(commandId, editResult) : 'unknown' }); }
    writes++; commandId = JSON.parse(String(init.body)).commandId; throw new TypeError('Lost edit ACK');
  };
  try {
    const first = await updateConversationMessage('s', editRow, { action: 'edit', text: 'new task' }, client);
    assert.equal(first.ok, false); assert.equal(first.outcomeUnknown, true); assert.equal(first.commandId, commandId);
    assert.equal(reads.length, 3);
    const repeated = await updateConversationMessage('s', editRow, { action: 'edit', text: 'new task' }, client);
    assert.equal(repeated.outcomeUnknown, true); assert.equal(repeated.commandId, commandId); assert.equal(reads.length, 4);
    const changed = await updateConversationMessage('s', editRow, { action: 'edit', text: 'different task' }, client);
    assert.equal(changed.ok, false); assert.equal(changed.outcomeUnknown, true); assert.equal(changed.commandId, commandId);
    assert.equal(reads.length, 5); assert.equal(writes, 1);
    const refreshedRow = { ...editRow, messageRevision: editedRevision };
    const refreshed = await updateConversationMessage('s', refreshedRow, { action: 'edit', text: 'new task' }, client);
    assert.equal(refreshed.outcomeUnknown, true); assert.equal(refreshed.commandId, commandId);
    const shifted = await updateConversationMessage('s', { ...refreshedRow, messageIndex: 2 }, { action: 'edit', text: 'other row' }, client);
    assert.equal(shifted.outcomeUnknown, true); assert.equal(shifted.commandId, commandId);
    assert.equal(reads.length, 7); assert.equal(writes, 1);
    known = true;
    const recovered = await updateConversationMessage('s', refreshedRow, { action: 'edit', text: 'new task' }, client);
    assert.deepEqual(recovered, { ok: true, value: undefined, commandId });
    const repeatedRecovery = await updateConversationMessage('s', refreshedRow, { action: 'edit', text: 'new task' }, client);
    assert.equal(repeatedRecovery.ok, false); assert.equal(repeatedRecovery.outcomeUnknown, undefined);
    assert.match(repeatedRecovery.ok ? '' : repeatedRecovery.error, /already confirmed/u);
    const settled = await updateConversationMessage('s', editRow, { action: 'edit', text: 'new task' }, client);
    assert.equal(settled.ok, false); assert.equal(settled.outcomeUnknown, undefined);
    assert.match(settled.ok ? '' : settled.error, /already confirmed/u);
    assert.equal(writes, 1); assert.equal(reads.length, 8);
    assert.ok(reads.every(path => path === `/api/sessions/s/commands/${commandId}`));
  } finally { client.dispose(); globalThis.fetch = previous; }
});

test('querying an earlier accepted edit for a changed draft cannot acknowledge or execute that draft', async () => {
  let known = false; let writes = 0; let commandId = '';
  const client = new SessionCommandClient({ isEffective: () => true,
    post: async (_path, body) => { writes++; commandId = (body as { commandId: string }).commandId; throw new TypeError('Lost response'); },
    get: async () => ({ result: known ? accepted(commandId, editResult) : 'unknown' }),
  });
  const body = { revision: editRevision, messageIndex: 0, action: 'edit' as const, text: 'original draft' };
  await assert.rejects(client.submitEdit('s', body, unused), CommandDeliveryUnconfirmedError);
  known = true;
  await assert.rejects(client.submitEdit('s', { ...body, revision: editedRevision, messageIndex: 2, text: 'changed draft' }, unused), /earlier edit was confirmed/u);
  assert.equal(writes, 1);
  client.dispose();
});

test('malformed edit acceptance retains its query identity and cannot acknowledge another target or start a run', async () => {
  const previous = globalThis.fetch;
  try {
    for (const result of [null, [], { ...editResult, id: 'other' }, { ...editResult, messageIndex: 1 },
      { ...editResult, action: 'feedback' }, { ...editResult, revision: 'invalid' }, { ...editResult, revision: undefined }]) {
      let commandId = ''; let writes = 0; let queries = 0; let admitted = false;
      const client = createSessionCommandClient(() => true);
      globalThis.fetch = async (path, init) => {
        if (path === '/api/csrf') return Response.json({ csrfToken: 'fixture' });
        if (!init?.method) { queries++; return Response.json({ result: accepted(commandId, result) }); }
        writes++; const body = JSON.parse(String(init.body)); assert.equal(body.type, 'edit_message');
        commandId = body.commandId; return Response.json(accepted(commandId, result));
      };
      try {
        const updated = await updateConversationMessage('s', editRow, { action: 'edit', text: 'new task' }, client);
        if (updated.ok) { admitted = true; await runSession('s', undefined, undefined, client); }
        assert.equal(updated.ok, false); assert.equal(updated.outcomeUnknown, true); assert.equal(updated.commandId, commandId);
        assert.equal(admitted, false); assert.equal(queries, 0);
        const repeated = await updateConversationMessage('s', editRow, { action: 'edit', text: 'new task' }, client);
        assert.equal(repeated.outcomeUnknown, true); assert.equal(repeated.commandId, commandId);
        assert.equal(writes, 1); assert.equal(queries, 1);
      } finally { client.dispose(); }
    }
  } finally { globalThis.fetch = previous; }
});

test('a revision or lease refusal is known, does not query, and allows a fresh edit intent', async () => {
  const previous = globalThis.fetch; const writes: Record<string, unknown>[] = [];
  const client = createSessionCommandClient(() => true);
  globalThis.fetch = async (path, init) => {
    if (path === '/api/csrf') return Response.json({ csrfToken: 'fixture' });
    assert.equal(path, '/api/sessions/s/commands'); const body = JSON.parse(String(init?.body)); writes.push(body);
    return Response.json({ commandId: body.commandId, status: 'rejected', reasonCode: 'state_conflict', message: 'session is in use by another process' });
  };
  try {
    const first = await updateConversationMessage('s', editRow, { action: 'edit', text: 'new task' }, client);
    assert.equal(first.ok, false); assert.equal(first.outcomeUnknown, undefined);
    const second = await updateConversationMessage('s', editRow, { action: 'edit', text: 'different task' }, client);
    assert.equal(second.ok, false); assert.equal(writes.length, 2); assert.notEqual(writes[0].commandId, writes[1].commandId);
  } finally { client.dispose(); globalThis.fetch = previous; }
});

test('disabled edit commands choose legacy PATCH once, while feedback remains on its existing REST route', async () => {
  const previous = globalThis.fetch; const writes: { path: string; method: string; body: Record<string, unknown> }[] = [];
  const client = createSessionCommandClient(() => false);
  globalThis.fetch = async (path, init) => {
    if (path === '/api/csrf') return Response.json({ csrfToken: 'fixture' });
    writes.push({ path: String(path), method: String(init?.method), body: JSON.parse(String(init?.body)) });
    return Response.json(writes.length === 1 ? editResult : {});
  };
  try {
    const updated = await updateConversationMessage('s', editRow, { action: 'edit', text: 'new task' }, client);
    assert.equal(updated.ok, true); assert.ok(updated.commandId);
    const assistantRow: Extract<TimelineRow, {kind: 'assistant'}> = { kind: 'assistant', seq: 2, turnId: 'turn-1', text: 'answer', messageIndex: 1, messageRevision: editedRevision };
    assert.deepEqual(await updateConversationMessage('s', assistantRow, { action: 'feedback', feedback: 'like' }, client), { ok: true, value: undefined });
    assert.deepEqual(writes.map(row => [row.path, row.method]), Array(2).fill(['/api/sessions/s/message-actions', 'PATCH']));
    assert.deepEqual(writes[0].body, { revision: editRevision, messageIndex: 0, action: 'edit', text: 'new task' });
    assert.deepEqual(writes[1].body, { revision: editedRevision, messageIndex: 1, action: 'feedback', feedback: 'like' });
  } finally { client.dispose(); globalThis.fetch = previous; }
});

test('unknown legacy edits and disable after command loss cannot resend or start a new query while disabled', async () => {
  const previous = globalThis.fetch;
  try {
    for (const initiallyEnabled of [false, true]) {
      let enabled = initiallyEnabled; let writes = 0; let queries = 0; let commandId = '';
      const client = createSessionCommandClient(() => enabled);
      globalThis.fetch = async (path, init) => {
        if (path === '/api/csrf') return Response.json({ csrfToken: 'fixture' });
        if (!init?.method) { queries++; return Response.json({ result: 'unknown' }); }
        assert.equal(path, initiallyEnabled ? '/api/sessions/s/commands' : '/api/sessions/s/message-actions');
        writes++; if (initiallyEnabled) commandId = JSON.parse(String(init.body)).commandId;
        enabled = false; throw new TypeError('Lost edit response');
      };
      try {
        const first = await updateConversationMessage('s', editRow, { action: 'edit', text: 'new task' }, client);
        assert.equal(first.outcomeUnknown, true); assert.ok(first.commandId);
        if (initiallyEnabled) assert.equal(first.commandId, commandId);
        const repeated = await updateConversationMessage('s', editRow, { action: 'edit', text: 'new task' }, client);
        assert.equal(repeated.outcomeUnknown, true); assert.equal(repeated.commandId, first.commandId);
        assert.equal(writes, 1); assert.equal(queries, 0);
        enabled = true;
        assert.equal((await updateConversationMessage('s', editRow, { action: 'edit', text: 'new task' }, client)).commandId, first.commandId);
        assert.equal(writes, 1); assert.equal(queries, 1);
      } finally { client.dispose(); }
    }
  } finally { globalThis.fetch = previous; }
});

test('disabling during edit CSRF preflight prevents both ACK admission and legacy fallback', async () => {
  const previous = globalThis.fetch; let enabled = true; const paths: string[] = [];
  let release: (response: Response) => void = () => undefined; let started: () => void = () => undefined;
  const preflight = new Promise<void>(resolve => { started = resolve; });
  const client = createSessionCommandClient(() => enabled);
  globalThis.fetch = async path => {
    paths.push(String(path)); assert.equal(path, '/api/csrf'); started();
    return new Promise(resolve => { release = resolve; });
  };
  try {
    const pending = updateConversationMessage('s', editRow, { action: 'edit', text: 'new task' }, client);
    await preflight; enabled = false; release(Response.json({ csrfToken: 'fixture' }));
    const updated = await pending;
    assert.equal(updated.ok, false); assert.equal(updated.outcomeUnknown, undefined);
    assert.deepEqual(paths, ['/api/csrf']);
  } finally { client.dispose(); globalThis.fetch = previous; }
});

test('unknown edit guards remain bounded without evicting identities, and disposal stops recovery', async () => {
  let writes = 0; let reads = 0;
  const client = new SessionCommandClient({ isEffective: () => true, maxRemembered: 1,
    post: async () => { writes++; throw new TypeError('Lost ACK'); },
    get: async () => { reads++; return { result: 'unknown' }; },
  });
  const body = { revision: editRevision, messageIndex: 0, action: 'edit' as const, text: 'new task' };
  let identity = '';
  await assert.rejects(client.submitEdit('s', body, unused), error => {
    if (!(error instanceof CommandDeliveryUnconfirmedError)) return false;
    identity = error.commandId; return true;
  });
  await assert.rejects(client.submitEdit('other', body, unused), /Too many unconfirmed edits/u);
  assert.equal(writes, 1); assert.equal(reads, 3);
  await assert.rejects(client.submitEdit('s', body, unused), error => error instanceof CommandDeliveryUnconfirmedError && error.commandId === identity);
  assert.equal(writes, 1); assert.equal(reads, 4);
  client.dispose();
  await assert.rejects(client.submitEdit('s', body, unused), /disposed/u);
  assert.equal(writes, 1); assert.equal(reads, 4);
});

test('cold approval loading shares one promise and starts one admission after loading', async () => {
  let writes = 0; let commandId = '';
  let release: (value: unknown) => void = () => undefined;
  let started: () => void = () => undefined;
  const posting = new Promise<void>(resolve => { started = resolve; });
  const client = new SessionCommandClient({ isEffective: () => true,
    post: async (_path, body) => {
      writes++; commandId = (body as { commandId: string }).commandId;
      return new Promise(resolve => { release = resolve; started(); });
    }, get: unused,
  });
  const payload = { kind: 'write', tool_call_id: 'cold-call' };
  const first = client.submitApproval('s', 'approve', payload, unused);
  const second = client.submitApproval('s', 'approve', payload, unused);
  assert.equal(first, second);
  assert.equal(writes, 0, 'approval policy must load before admission');
  let enabled = true;
  const cancelled = new SessionCommandClient({ isEffective: () => true, post: unused, get: unused });
  const disabled = new SessionCommandClient({ isEffective: () => enabled, post: unused, get: unused });
  const toggled = new SessionCommandClient({ isEffective: () => true, post: unused, get: unused });
  const cancelledResult = assert.rejects(cancelled.submitApproval('s', 'approve', payload, unused), /cancelled/u);
  const disabledResult = assert.rejects(disabled.submitApproval('s', 'approve', payload, unused), /cancelled/u);
  const toggledResult = assert.rejects(toggled.submitApproval('s', 'approve', payload, unused), /cancelled/u);
  cancelled.dispose(); enabled = false;
  toggled.cancelPending();
  await posting;
  await Promise.all([cancelledResult, disabledResult, toggledResult]);
  disabled.dispose(); toggled.dispose();
  assert.equal(writes, 1);
  assert.equal(client.submitApproval('s', 'approve', payload, unused), first,
    'cold callers must keep sharing their promise after the module loads');
  release(accepted(commandId, { approved: payload }));
  await first;
  client.dispose();
});

test('lost approval ACK queries its original identity without replaying approval', async () => {
  const writes: { path: string; body: unknown }[] = [];
  const reads: string[] = [];
  const client = new SessionCommandClient({ isEffective: () => true,
    post: async (path, body) => { writes.push({ path, body }); throw new TypeError('Lost response'); },
    get: async path => {
      reads.push(path);
      const commandId = decodeURIComponent(path.split('/').pop()!);
      return { result: accepted(commandId, { approved: { kind: 'write', tool_call_id: 'call_1' } }) };
    },
  });
  const result = await client.submitApproval('s', 'approve', { kind: 'write', tool_call_id: 'call_1' }, unused);
  assert.equal(result.commandId.startsWith('c_'), true);
  assert.deepEqual(result.result, { approved: { kind: 'write', tool_call_id: 'call_1' } });
  assert.equal(writes.length, 1);
  assert.equal(reads.length, 1);
  client.dispose();
});

test('approvePending uses SessionCommandClient when effective and sends command', async () => {
  const writes: { path: string; body: unknown }[] = [];
  const client = new SessionCommandClient({ isEffective: () => true,
    post: async (path, body) => {
      writes.push({ path, body });
      const record = body as { commandId: string };
      return accepted(record.commandId, { approved: { kind: 'write', tool_call_id: 'c1', subject: 'a.txt' } });
    },
    get: unused,
  });
  const res = await approvePending('session-1', { tool_call_id: 'c1', name: 'write', subject: 'a.txt', preview: '' }, client);
  assert.deepEqual(res, { ok: true, value: 'c1' });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].path, '/api/sessions/session-1/commands');
  const body = writes[0].body as { commandId: string; type: string; payload: Record<string, unknown> };
  assert.equal(body.type, 'approve');
  assert.equal(body.payload.tool_call_id, 'c1');
  assert.equal(body.payload.kind, 'write');
  assert.equal(body.payload.subject, 'a.txt');
  client.dispose();
});

test('re-approval of unconfirmed tool call queries existing commandId without new write', async () => {
  let writes = 0; let reads = 0;
  const client = new SessionCommandClient({ isEffective: () => true, maxRemembered: 1,
    post: async () => { writes++; throw new TypeError('Lost ACK'); },
    get: async path => {
      reads++;
      if (reads < 4) return { result: 'unknown' };
      const commandId = decodeURIComponent(path.split('/').pop()!);
      return { result: accepted(commandId, { approved: { kind: 'exec', tool_call_id: 'c2' } }) };
    },
  });
  const pending = { tool_call_id: 'c2', name: 'exec', subject: '["ls"]', preview: '' };
  const first = await approvePending('s', pending, client);
  assert.equal(first.ok, false);
  assert.equal(first.outcomeUnknown, true);
  assert.equal(writes, 1);
  assert.equal(reads, 3);

  // Second call with same tool_call_id queries the existing commandId
  const second = await approvePending('s', pending, client);
  assert.equal(second.ok, true);
  assert.equal(second.value, 'c2');
  assert.equal(writes, 1);
  assert.equal(reads, 4);
  client.dispose();
});

test('approval refusal via Gate or permission marks refused and throws CommandRefusedError', async () => {
  let writes = 0;
  const client = new SessionCommandClient({ isEffective: () => true,
    post: async (_path, body) => {
      writes++;
      const record = body as { commandId: string };
      return { commandId: record.commandId, status: 'rejected', reasonCode: 'forbidden', message: 'tool plugin disabled' };
    },
    get: unused,
  });
  await assert.rejects(
    client.submitApproval('s', 'approve', { kind: 'write', tool_call_id: 'c3' }, unused),
    CommandRefusedError,
  );
  assert.equal(writes, 1);
  client.dispose();
});

test('approval fallback when client ineffective falls back to REST', async () => {
  let restCalls = 0;
  const client = new SessionCommandClient({ isEffective: () => false,
    post: unused,
    get: unused,
  });
  const res = await client.submitApproval('s', 'approve', { kind: 'write', tool_call_id: 'c4' }, async () => {
    restCalls++;
    return { approved: { kind: 'write', tool_call_id: 'c4' } };
  });
  assert.equal(restCalls, 1);
  assert.deepEqual(res, { commandId: res.commandId, result: { approved: { kind: 'write', tool_call_id: 'c4' } } });
  client.dispose();
});

test('concurrent approval calls share admission but a settled approval requires a fresh backend decision', async () => {
  let writes = 0;
  let postedCommandId = '';
  let release: (value: unknown) => void = () => undefined;
  const client = new SessionCommandClient({
    isEffective: () => true,
    post: async (_path, body) => {
      writes++;
      postedCommandId = (body as { commandId: string }).commandId;
      return new Promise(resolve => { release = resolve; });
    },
    get: unused,
  });
  const payload = { kind: 'write', tool_call_id: 'call-dup-1' };
  const first = client.submitApproval('s', 'approve', payload, unused);
  const second = client.submitApproval('s', 'approve', payload, unused);
  assert.equal(first, second);
  assert.equal(writes, 1);
  release(accepted(postedCommandId, { approved: { tool_call_id: 'call-dup-1', kind: 'write' } }));
  const resolved = await first;
  assert.deepEqual(resolved.result, { approved: { tool_call_id: 'call-dup-1', kind: 'write' } });
  const thirdPromise = client.submitApproval('s', 'approve', payload, unused);
  assert.equal(writes, 2);
  assert.notEqual(postedCommandId, resolved.commandId);
  release(accepted(postedCommandId, { approved: payload }));
  const third = await thirdPromise;
  assert.deepEqual(third.result, { approved: payload });
  client.dispose();
});

test('confirmed approve and reject decisions use separate admissions and never reuse an obsolete grant', async () => {
  const decisions: string[] = [];
  const client = new SessionCommandClient({ isEffective: () => true,
    post: async (_path, body) => {
      const command = body as { commandId: string; type: string };
      decisions.push(command.type);
      return accepted(command.commandId, { [command.type === 'reject' ? 'rejected' : 'approved']:
        { kind: 'write', tool_call_id: 'decision-call' } });
    }, get: unused,
  });
  const payload = { kind: 'write', tool_call_id: 'decision-call' };
  const approval = await client.submitApproval('s', 'approve', payload, unused);
  const rejection = await client.submitApproval('s', 'reject', payload, unused);
  assert.notEqual(approval.commandId, rejection.commandId);
  assert.deepEqual(rejection.result, { rejected: payload });
  await client.submitApproval('s', 'approve', payload, unused);
  assert.deepEqual(decisions, ['approve', 'reject', 'approve']);
  client.dispose();
});

test('an unresolved approval cannot be claimed by a different decision or payload', async () => {
  let writes = 0;
  let release: (value: unknown) => void = () => undefined;
  let commandId = '';
  const client = new SessionCommandClient({ isEffective: () => true,
    post: async (_path, body) => {
      writes++; commandId = (body as { commandId: string }).commandId;
      return new Promise(resolve => { release = resolve; });
    }, get: unused,
  });
  const payload = { kind: 'write', tool_call_id: 'guarded-call', subject: 'a.txt' };
  const first = client.submitApproval('s', 'approve', payload, unused);
  await assert.rejects(client.submitApproval('s', 'reject', payload, unused), /unconfirmed/u);
  await assert.rejects(client.submitApproval('s', 'approve', { ...payload, subject: 'b.txt' }, unused), /unconfirmed/u);
  assert.equal(writes, 1);
  release(accepted(commandId, { approved: payload }));
  await first;
  client.dispose();
});

test('mismatched approval decisions and capabilities stay unknown and retry only the original query', async () => {
  for (const wrong of [
    { rejected: { kind: 'write', tool_call_id: 'verified-call' } },
    { approved: { kind: 'exec', tool_call_id: 'verified-call' } },
    { approved: { kind: 'write', tool_call_id: 'other-call' } },
    { approved: { kind: 'write', tool_call_id: 'verified-call' }, rejected: {} },
  ]) {
    let writes = 0; let reads = 0; let identity = '';
    const client = new SessionCommandClient({ isEffective: () => true,
      post: async (_path, body) => { writes++; identity = (body as { commandId: string }).commandId; return accepted(identity, wrong); },
      get: async path => {
        reads++; assert.ok(path.endsWith(`/${identity}`));
        return { result: accepted(identity, { approved: { kind: 'write', tool_call_id: 'verified-call' } }) };
      },
    });
    const pending = { tool_call_id: 'verified-call', name: 'write', subject: 'a.txt', preview: '' };
    const first = await approvePending('s', pending, client);
    assert.equal(first.ok, false); assert.equal(first.outcomeUnknown, true); assert.equal(first.commandId, identity);
    const recovered = await approvePending('s', pending, client);
    assert.equal(recovered.ok, true); assert.equal(writes, 1); assert.equal(reads, 1);
    client.dispose();
  }
});

test('approval decision=reject cannot confirm an approved result', async () => {
  let writes = 0; let reads = 0; let identity = '';
  const payload = { kind: 'exec', tool_call_id: 'reject-call', decision: 'reject' };
  const confirmation = { kind: 'exec', tool_call_id: 'reject-call' };
  const client = new SessionCommandClient({ isEffective: () => true,
    post: async (_path, body) => {
      writes++; identity = (body as { commandId: string }).commandId;
      return accepted(identity, { approved: confirmation });
    },
    get: async path => {
      reads++; assert.ok(path.endsWith(`/${identity}`));
      return { result: accepted(identity, { rejected: confirmation }) };
    },
  });
  await assert.rejects(client.submitApproval('s', 'approval', payload, unused), error =>
    error instanceof CommandDeliveryUnconfirmedError && error.commandId === identity);
  const receipt = await client.submitApproval('s', 'approval', payload, unused);
  assert.deepEqual(receipt.result, { rejected: confirmation });
  assert.equal(writes, 1); assert.equal(reads, 1);
  client.dispose();
});

test('unknown approvals survive bounded eviction and disposal prevents new writes', async () => {
  let writes = 0; let reads = 0; let identity = '';
  const client = new SessionCommandClient({ isEffective: () => true, maxRemembered: 1,
    post: async () => { writes++; throw new TypeError('Lost ACK'); },
    get: async () => { reads++; return { result: 'unknown' }; },
  });
  const payload = { kind: 'write', tool_call_id: 'bounded-call' };
  await assert.rejects(client.submitApproval('s', 'approve', payload, unused), error => {
    if (!(error instanceof CommandDeliveryUnconfirmedError)) return false;
    identity = error.commandId; return true;
  });
  await assert.rejects(client.submitApproval('other', 'approve', payload, unused), /Too many unconfirmed approvals/u);
  await assert.rejects(client.submitApproval('s', 'approve', payload, unused), error =>
    error instanceof CommandDeliveryUnconfirmedError && error.commandId === identity);
  assert.equal(writes, 1); assert.equal(reads, 4);
  client.dispose();
  await assert.rejects(client.submitApproval('s', 'approve', payload, unused), /disposed/u);
  assert.equal(writes, 1); assert.equal(reads, 4);
});

function workbenchSource(): string {
  for (const path of [resolve('src/xuenessWorkbench.ts'), resolve('webapp/src/xuenessWorkbench.ts')]) {
    try { return readFileSync(path, 'utf8'); } catch { /* test cwd may be the repo or webapp root */ }
  }
  throw new Error('xuenessWorkbench.ts was not found from the test working directory');
}

test('workbench startup graph keeps command admission and approval policy lazy', () => {
  const source = workbenchSource().replace(/^\s*import\s+type\b[^;]*;\s*$/gmu, '');
  assert.doesNotMatch(source, /from\s+['"]\.\/plugins\/sessions\/commandClient['"]/);
  assert.doesNotMatch(source, /from\s+['"]\.\/plugins\/sessions\/approvalCommands['"]/);
  assert.match(source, /import\(\s*['"]\.\/plugins\/sessions\/commandClient['"]\s*\)/);
  assert.match(source, /import\(\s*['"]\.\/plugins\/sessions\/approvalCommands['"]\s*\)/);
});

test('startup command handle reports effectiveness immediately and does not admit after dispose, cancel, or disable', async () => {
  const previous = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => { fetches += 1; throw new Error('must not fetch'); };
  try {
    let enabled = true;
    const disposed = createSessionCommandClient(() => enabled);
    assert.equal(disposed.isEffective(), true);
    enabled = false;
    assert.equal(disposed.isEffective(), false);
    enabled = true;
    disposed.dispose();
    assert.equal(disposed.isEffective(), false);
    await assert.rejects(disposed.submit('s', 'send', { text: 'disposed' }, async () => { fetches += 1; return {}; }), /disposed/u);

    const cancelled = createSessionCommandClient(() => true);
    const cancelling = cancelled.submit('s', 'send', { text: 'cancel' }, async () => { fetches += 1; return {}; });
    cancelled.cancelPending();
    await assert.rejects(cancelling, /cancelled/u);

    enabled = true;
    const faded = createSessionCommandClient(() => enabled);
    const fading = faded.submit('s', 'send', { text: 'fade' }, async () => { fetches += 1; return {}; });
    enabled = false;
    await assert.rejects(fading, /cancelled/u);
    assert.equal(fetches, 0);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(fetches, 0);
    assert.equal(faded.isEffective(), false);
    faded.dispose();
    cancelled.dispose();
  } finally { globalThis.fetch = previous; }
});

test('disabling or disposing during lazy approval loading starts neither commands nor REST', async () => {
  for (const dispose of [false, true]) {
    let enabled = true; let requests = 0;
    const client = new SessionCommandClient({ isEffective: () => enabled,
      post: async () => { requests++; throw new Error('must not post'); },
      get: async () => { requests++; throw new Error('must not query'); },
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { requests++; throw new Error('must not fall back'); };
    try {
      const approval = approvePending('s', { tool_call_id: 'lazy-call', name: 'write', subject: 'a.txt', preview: '' }, client);
      if (dispose) client.dispose(); else enabled = false;
      const result = await approval;
      assert.equal(result.ok, false); assert.equal(requests, 0);
    } finally { globalThis.fetch = originalFetch; client.dispose(); }
  }
});

test('a later approval observes backend revocation instead of replaying its earlier confirmed ACK', async () => {
  const commandIds: string[] = [];
  const payload = { kind: 'write', tool_call_id: 'revoked-call' };
  const client = new SessionCommandClient({ isEffective: () => true,
    post: async (_path, body) => {
      const { commandId } = body as { commandId: string };
      commandIds.push(commandId);
      return commandIds.length === 1 ? accepted(commandId, { approved: payload })
        : { commandId, status: 'rejected', reasonCode: 'forbidden', message: 'approval revoked' };
    }, get: unused,
  });
  await client.submitApproval('s', 'approve', payload, unused);
  await assert.rejects(client.submitApproval('s', 'approve', payload, unused),
    error => error instanceof CommandRefusedError && error.ack.reasonCode === 'forbidden');
  assert.equal(commandIds.length, 2);
  assert.notEqual(commandIds[0], commandIds[1]);
  client.dispose();
});

test('a new approval after backend restart retains its new uncertain identity without falling back to old confirmation', async () => {
  const commandIds: string[] = [];
  const queriedIds: string[] = [];
  const payload = { kind: 'exec', tool_call_id: 'restart-call' };
  const client = new SessionCommandClient({ isEffective: () => true, queryAttempts: 1,
    post: async (_path, body) => {
      const { commandId } = body as { commandId: string };
      commandIds.push(commandId);
      if (commandIds.length === 1) return accepted(commandId, { approved: payload });
      throw new TypeError('Restart interrupted the response');
    }, get: async path => {
      queriedIds.push(decodeURIComponent(path.split('/').pop()!));
      return { result: 'unknown' };
    },
  });
  await client.submitApproval('s', 'approve', payload, unused);
  await assert.rejects(client.submitApproval('s', 'approve', payload, unused),
    error => error instanceof CommandDeliveryUnconfirmedError && error.commandId === commandIds[1]);
  await assert.rejects(client.submitApproval('s', 'approve', payload, unused),
    error => error instanceof CommandDeliveryUnconfirmedError && error.commandId === commandIds[1]);
  await assert.rejects(client.submitApproval('s', 'reject', payload, unused), /unconfirmed/u);
  assert.equal(commandIds.length, 2);
  assert.notEqual(commandIds[0], commandIds[1]);
  assert.deepEqual(queriedIds, [commandIds[1], commandIds[1]]);
  client.dispose();
});

test('unknown attachment edit only queries original command and changed selection cannot claim acceptance', async () => {
  const previous = globalThis.fetch; let known = false; let writes = 0; let commandId = '';
  const client = createSessionCommandClient(() => true);
  globalThis.fetch = async (path, init) => {
    if (path === '/api/csrf') return Response.json({ csrfToken: 'fixture' });
    if (!init?.method) return Response.json({ result: known ? accepted(commandId, editResult) : 'unknown' });
    writes++; commandId = JSON.parse(String(init.body)).commandId; throw new TypeError('Lost edit ACK');
  };
  try {
    const first = await updateConversationMessage('s', editRow, { action: 'edit', text: 'same text', prepared_token: 'a'.repeat(32) }, client);
    assert.equal(first.outcomeUnknown, true);
    known = true;
    const changed = await updateConversationMessage('s', editRow, { action: 'edit', text: 'same text', prepared_token: 'b'.repeat(32) }, client);
    assert.equal(changed.ok, false);
    assert.match(changed.ok ? '' : changed.error, /earlier edit was confirmed/u);
    assert.equal(writes, 1);
  } finally { client.dispose(); globalThis.fetch = previous; }
});
