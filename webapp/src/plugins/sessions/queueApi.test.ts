import test from 'node:test';
import assert from 'node:assert/strict';
import { queueTurn, loadSession, sendTurn, createSession } from '../../xuenessWorkbench';

test('lost queue acknowledgement replays one identity and the same one-use context; a separate send has a new identity', async () => {
  const previous = globalThis.fetch;
  const bodies: Record<string, string>[] = [];
  globalThis.fetch = async (path, init) => {
    if (path === '/api/csrf') return Response.json({ csrfToken: 'fixture' });
    bodies.push(JSON.parse(String(init?.body)));
    if (bodies.length === 1) throw new TypeError('connection lost after acceptance');
    return Response.json({ id: 'queue-one', item: { id: 'queue-one', text: 'hello', status: 'queued', position: 1 } });
  };
  try {
    assert.equal((await queueTurn('session', 'hello', 'prepared')).ok, true);
    assert.equal(bodies.length, 2); assert.deepEqual(bodies[0], bodies[1]);
    assert.match(bodies[0].request_id, /^[a-f0-9]{32}$/u);
    await queueTurn('session', 'hello', 'prepared');
    assert.notEqual(bodies[1].request_id, bodies[2].request_id);
  } finally { globalThis.fetch = previous; }
});

test('ordinary turns and session creation keep ambiguous acceptance explicit and never auto-run or replay', async () => {
  const previous = globalThis.fetch;
  try {
    for (const action of [() => sendTurn('session', 'hello'), () => createSession('hello')]) {
      const mutations: string[] = [];
      globalThis.fetch = async path => {
        if (path === '/api/csrf') return Response.json({ csrfToken: 'fixture' });
        mutations.push(String(path)); throw new TypeError('connection lost after acceptance');
      };
      const result = await action();
      assert.equal(result.ok, false); assert.equal(result.outcomeUnknown, true);
      assert.equal(mutations.length, 1); assert.equal(mutations.some(path => path.endsWith('/run')), false);
    }
  } finally { globalThis.fetch = previous; }
});

test('refusing a queue replay cannot erase uncertainty about the original request', async () => {
  const previous = globalThis.fetch; let calls = 0;
  globalThis.fetch = async path => {
    if (path === '/api/csrf') return Response.json({ csrfToken: 'fixture' });
    if (++calls === 1) throw new TypeError('original response lost');
    return Response.json({ error: 'plugin disabled during retry' }, { status: 403 });
  };
  try { const result = await queueTurn('session', 'hello'); assert.equal(result.outcomeUnknown, true); assert.equal(calls, 2); }
  finally { globalThis.fetch = previous; }
});

test('a failed CSRF read is known unsent and does not trigger automatic queue replays', async () => {
  const previous = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; throw new TypeError('preflight unavailable'); };
  try { const result = await queueTurn('session', 'hello'); assert.equal(result.outcomeUnknown, undefined); assert.equal(calls, 1); }
  finally { globalThis.fetch = previous; }
});

test('queue permission/conflict errors are not replayed, and repeated transport failure is explicitly unconfirmed', async () => {
  const previous = globalThis.fetch;
  try {
    for (const status of [400, 403, 409, 503]) {
      let calls = 0;
      globalThis.fetch = async path => {
        if (path === '/api/csrf') return Response.json({ csrfToken: 'fixture' });
        calls++; return Response.json({ error: 'fixture refusal' }, { status });
      };
      const result = await queueTurn('session', 'hello');
      assert.equal(result.ok, false);
      assert.equal(calls, status === 503 ? 2 : 1);
      if (!result.ok && status === 503) assert.match(result.error, /无法确认|could not be confirmed/u);
    }
  } finally { globalThis.fetch = previous; }
});

test('switching sessions aborts the actual in-flight fetch even with a read deadline', async () => {
  const previous = globalThis.fetch;
  const controller = new AbortController();
  let attached = false;
  globalThis.fetch = async (_path, init) => new Promise((_resolve, reject) => {
    attached = true; init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
  });
  try {
    const result = loadSession('old', controller.signal);
    assert.equal(attached, true); controller.abort(new DOMException('switch', 'AbortError'));
    assert.deepEqual(await result, { ok: false, error: 'switch' });
  } finally { globalThis.fetch = previous; }
});

import { editQueuedMessage, cancelQueuedMessage, reorderQueuedMessages } from './queueApi';
import { SessionCommandClient, CommandDeliveryUnconfirmedError, CommandRefusedError } from './commandClient';
import { cancelQueuedTurn, createSessionCommandClient } from '../../xuenessWorkbench';

const unused = async (): Promise<never> => { throw new Error('unexpected legacy mutation or read'); };
const accepted = (commandId: string, result: unknown) => ({ commandId, status: 'accepted', result });
const queueCases = [
  { type: 'edit_queue', payload: { queueId: 'q/1', text: ' next ', expectedText: 'old', expectedRevision: 4 },
    result: { id: 'q/1', item: { id: 'q/1', text: 'next' } },
    call: (client: SessionCommandClient) => editQueuedMessage('s/1', 'q/1', ' next ', 'old', client, 4) },
  { type: 'cancel_queue', payload: { queueId: 'q/1', expectedText: 'old', expectedRevision: 4 },
    result: { id: 'q/1', removed: true, remaining: 0 },
    call: (client: SessionCommandClient) => cancelQueuedMessage('s/1', 'q/1', 'old', client, 4) },
  { type: 'reorder_queue', payload: { ids: ['b', 'a'], expectedIds: ['a', 'b'], expectedRevision: 4 },
    result: { ids: ['b', 'a'] },
    call: (client: SessionCommandClient) => reorderQueuedMessages('s/1', ['b', 'a'], ['a', 'b'], client, 4) },
];

for (const fixture of queueCases) {
  test(`${fixture.type} sends its CAS payload and a later confirmed explicit action has a fresh identity`, async () => {
    const identities: string[] = [];
    const client = new SessionCommandClient({ isEffective: () => true, get: unused,
      post: async (path, body) => {
        assert.equal(path, '/api/sessions/s%2F1/commands');
        const command = body as { type: string; commandId: string; payload: unknown };
        assert.equal(command.type, fixture.type); assert.deepEqual(command.payload, fixture.payload);
        identities.push(command.commandId); return accepted(command.commandId, fixture.result);
      },
    });
    try { await fixture.call(client); await fixture.call(client); assert.equal(identities.length, 2); assert.notEqual(identities[0], identities[1]); }
    finally { client.dispose(); }
  });

  test(`${fixture.type} lost acknowledgement retries only the original query, never another mutation`, async () => {
    let writes = 0; let reads = 0; let identity = '';
    const client = new SessionCommandClient({ isEffective: () => true, queryAttempts: 1,
      post: async (_path, body) => { writes++; identity = (body as { commandId: string }).commandId; throw new TypeError('lost ACK'); },
      get: async path => {
        reads++; assert.equal(path, `/api/sessions/s%2F1/commands/${identity}`);
        return { result: reads === 1 ? 'unknown' : accepted(identity, fixture.result) };
      },
    });
    try {
      await assert.rejects(fixture.call(client), error => error instanceof CommandDeliveryUnconfirmedError && error.commandId === identity);
      await fixture.call(client); assert.equal(writes, 1); assert.equal(reads, 2);
    } finally { client.dispose(); }
  });

  test(`${fixture.type} malformed receipt remains unknown until an original-identity read validates it`, async () => {
    let writes = 0; let reads = 0; let identity = '';
    const client = new SessionCommandClient({ isEffective: () => true,
      post: async (_path, body) => { writes++; identity = (body as { commandId: string }).commandId; return accepted(identity, { id: 'wrong', ids: [], removed: true }); },
      get: async path => { reads++; assert.ok(path.endsWith(identity)); return { result: accepted(identity, fixture.result) }; },
    });
    try {
      await assert.rejects(fixture.call(client), CommandDeliveryUnconfirmedError);
      await fixture.call(client); assert.equal(writes, 1); assert.equal(reads, 1);
    } finally { client.dispose(); }
  });
}

test('a different queue action can reconcile but cannot claim an unknown earlier intent', async () => {
  let writes = 0; let reads = 0; let identity = '';
  const client = new SessionCommandClient({ isEffective: () => true, queryAttempts: 1,
    post: async (_path, body) => { writes++; identity = (body as { commandId: string }).commandId; throw new TypeError('lost'); },
    get: async () => ({ result: ++reads === 1 ? 'unknown' : accepted(identity, queueCases[0].result) }),
  });
  try {
    await assert.rejects(queueCases[0].call(client), CommandDeliveryUnconfirmedError);
    await assert.rejects(queueCases[1].call(client), /earlier queue change was confirmed/u);
    assert.equal(writes, 1); assert.equal(reads, 2);
  } finally { client.dispose(); }
});

test('unknown queue intents survive eviction, disabled plugins and query denials without REST fallback', async () => {
  let enabled = true; let writes = 0; let reads = 0;
  const client = new SessionCommandClient({ isEffective: () => enabled, queryAttempts: 1, maxRemembered: 1,
    post: async () => { writes++; throw new TypeError('lost'); },
    get: async () => { reads++; throw Object.assign(new Error('forbidden'), { status: 403 }); },
  });
  try {
    await assert.rejects(queueCases[0].call(client), CommandDeliveryUnconfirmedError);
    await assert.rejects(editQueuedMessage('other', 'q', 'next', 'old', client, 4), /Too many unconfirmed queue/u);
    enabled = false;
    await assert.rejects(queueCases[0].call(client), CommandDeliveryUnconfirmedError);
    assert.equal(writes, 1); assert.equal(reads, 1);
    enabled = true;
    await assert.rejects(queueCases[0].call(client), CommandDeliveryUnconfirmedError);
    assert.equal(writes, 1); assert.equal(reads, 2);
  } finally { client.dispose(); }
});

test('cancel adapter reports unknown command ID and refuses a missing observed text before admission', async () => {
  let writes = 0;
  const client = new SessionCommandClient({ isEffective: () => true, queryAttempts: 1,
    post: async () => { writes++; throw new TypeError('lost'); }, get: async () => ({ result: 'unknown' }),
  });
  try {
    const missing = await cancelQueuedTurn('s', 'q', undefined, client, 4);
    assert.equal(missing.ok, false); assert.equal(writes, 0);
    const result = await cancelQueuedTurn('s', 'q', 'observed', client, 4);
    assert.equal(result.ok, false); assert.equal(result.outcomeUnknown, true); assert.match(result.commandId!, /^c_/u);
    assert.equal(writes, 1);
  } finally { client.dispose(); }
});

test('queue conflicts are definitive and a corrected explicit action may submit a new command', async () => {
  const ids: string[] = [];
  const client = new SessionCommandClient({ isEffective: () => true, get: unused,
    post: async (_path, body) => {
      const { commandId } = body as { commandId: string }; ids.push(commandId);
      return { commandId, status: 'rejected', reasonCode: 'state_conflict', message: 'claimed' };
    },
  });
  try {
    await assert.rejects(queueCases[0].call(client), CommandRefusedError);
    await assert.rejects(queueCases[0].call(client), CommandRefusedError);
    assert.equal(ids.length, 2); assert.notEqual(ids[0], ids[1]);
  } finally { client.dispose(); }
});

test('lazy queue admission canceled on session switch or disable cannot start any request', async () => {
  const previous = globalThis.fetch; let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error('must not fetch'); };
  try {
    for (const change of ['cancel', 'disable', 'dispose']) {
      let enabled = true;
      const client = createSessionCommandClient(() => enabled);
      const pending = queueCases[0].call(client);
      if (change === 'cancel') client.cancelPending();
      else if (change === 'dispose') client.dispose();
      else enabled = false;
      await assert.rejects(pending, /cancelled|disposed/u);
      assert.equal(requests, 0); client.dispose();
    }
  } finally { globalThis.fetch = previous; }
});

test('an earlier unknown edit cannot create a phantom pending withdrawal under its command identity', async () => {
  let writes = 0;
  const client = new SessionCommandClient({ isEffective: () => true, queryAttempts: 1,
    post: async () => { writes++; throw new TypeError('lost'); }, get: async () => ({ result: 'unknown' }),
  });
  try {
    await assert.rejects(queueCases[0].call(client), CommandDeliveryUnconfirmedError);
    const result = await cancelQueuedTurn('s/1', 'q/1', 'old', client, 4);
    assert.equal(result.ok, false); assert.equal(result.outcomeUnknown, true);
    assert.equal(result.commandId, undefined, 'the unsent withdrawal cannot claim the earlier edit command');
    assert.equal(writes, 1);
  } finally { client.dispose(); }
});

test('revision-bound command mutations refuse missing or malformed revisions before any request', async () => {
  let requests = 0;
  const client = new SessionCommandClient({ isEffective: () => true,
    post: async () => { requests++; throw new Error('must not send'); },
    get: async () => { requests++; throw new Error('must not query'); },
  });
  try {
    for (const revision of [undefined, null, true, '4', -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      const value = revision as number | undefined;
      for (const call of [
        () => editQueuedMessage('s', 'q', 'new', 'old', client, value),
        () => cancelQueuedMessage('s', 'q', 'old', client, value),
        () => reorderQueuedMessages('s', ['b', 'a'], ['a', 'b'], client, value),
      ]) await assert.rejects(call(), error => error instanceof Error && 'requestNotSent' in error && error.requestNotSent === true);
    }
    assert.equal(requests, 0);
  } finally { client.dispose(); }
});

test('changed revision on an uncertain queue action only queries its original command ID', async () => {
  let writes = 0; let reads = 0; let identity = '';
  const client = new SessionCommandClient({ isEffective: () => true, queryAttempts: 1,
    post: async (_path, body) => {
      writes++; identity = (body as { commandId: string }).commandId;
      assert.equal((body as { payload: { expectedRevision: number } }).payload.expectedRevision, 4);
      throw new TypeError('lost ACK');
    },
    get: async path => {
      reads++; assert.ok(path.endsWith(identity));
      return { result: reads < 3 ? 'unknown' : accepted(identity, queueCases[0].result) };
    },
  });
  try {
    await assert.rejects(queueCases[0].call(client), CommandDeliveryUnconfirmedError);
    await assert.rejects(editQueuedMessage('s/1', 'q/1', ' next ', 'old', client, 6), CommandDeliveryUnconfirmedError);
    await assert.rejects(editQueuedMessage('s/1', 'q/1', ' next ', 'old', client, 6), /earlier queue change was confirmed/u);
    assert.equal(writes, 1); assert.equal(reads, 3);
  } finally { client.dispose(); }
});

import { parseConversationSnapshot } from '../../xuenessWorkbench';

const snapshotWithRevision = (fields: Record<string, unknown>) => ({
  session: { id: 's', status: 'idle', ...fields },
  journal: { id: 's', status: 'idle', message_revision: `sha256:${'ab'.repeat(32)}`, messages: [] },
  timeline: { schema: 'xueness.events.v1', protocolVersion: 1, sessionId: 's', status: 'idle', steps: 0, mode: 'agent',
    events: [], cursor: 0, nextCursor: 0, head: 0, hasMore: false },
});

test('both session snapshot parsers preserve valid queue revisions, allow legacy absence, and reject malformed presence', async () => {
  const previous = globalThis.fetch;
  try {
    for (const fields of [{}, { queue_revision: 0 }, { queue_revision: 7 }, { queue_revision: Number.MAX_SAFE_INTEGER }]) {
      globalThis.fetch = async () => Response.json({ id: 's', status: 'idle', ...fields });
      const loaded = await loadSession('s');
      assert.equal(loaded.ok, true);
      if (loaded.ok) assert.equal(loaded.value.queue_revision, fields.queue_revision);
      assert.equal(parseConversationSnapshot('s', snapshotWithRevision(fields)).session.queue_revision, fields.queue_revision);
    }
    for (const revision of [null, true, '4', -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      globalThis.fetch = async () => Response.json({ id: 's', status: 'idle', queue_revision: revision });
      const loaded = await loadSession('s');
      assert.equal(loaded.ok, false);
      assert.throws(() => parseConversationSnapshot('s', snapshotWithRevision({ queue_revision: revision })), /invalid queue revision/u);
    }
    assert.throws(() => parseConversationSnapshot('s', snapshotWithRevision({ queue_revision: undefined })), /invalid queue revision/u);
  } finally { globalThis.fetch = previous; }
});

import { reserveQueuedMessageNow } from './steeringApi';

test('send-now reservation sends its observed revision and does not replay a stale-row conflict', async () => {
  const previous = globalThis.fetch; const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = async (path, init) => {
    if (path === '/api/csrf') return Response.json({ csrfToken: 'fixture' });
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({ error: 'queue revision changed' }, { status: 409 });
  };
  try {
    const result = await reserveQueuedMessageNow('s', 'q', 'active-turn', 4);
    assert.equal(result.ok, false); assert.equal(result.outcomeUnknown, undefined);
    assert.equal(bodies.length, 1); assert.equal(bodies[0].expectedRevision, 4);
    assert.equal(bodies[0].expected_turn_id, 'active-turn');
    assert.match(String(bodies[0].request_id), /^[a-f0-9]{32}$/u);
  } finally { globalThis.fetch = previous; }
});

import { withdrawQueuedMessage, listQueueWithdrawals, getQueueWithdrawal, dismissQueueWithdrawal } from './queueApi';
const escrow = { id: 'c_escrow', queueId: 'q', sessionId: 's', root: '/workspace', hasContext: true,
  expectedRevision: 4, createdAt: 1000, expiresAt: 86401000 };

test('durable withdrawal uses distinct atomic command and never a cancellation fallback', async () => {
  let writes = 0;
  const client = new SessionCommandClient({ isEffective: () => true, get: unused,
    post: async (_path, body) => {
      writes++; const value = body as { commandId: string; type: string; payload: unknown };
      assert.equal(value.type, 'withdraw_queue');
      assert.deepEqual(value.payload, { queueId: 'q', expectedText: 'original', expectedRevision: 4 });
      return accepted(value.commandId, { removed: true, id: 'q', recoveryId: value.commandId });
    },
  });
  try { assert.match(await withdrawQueuedMessage('s', 'q', 'original', 4, client), /^c_/u); assert.equal(writes, 1); }
  finally { client.dispose(); }
  const disabled = new SessionCommandClient({ isEffective: () => false, get: unused, post: unused });
  try { await assert.rejects(withdrawQueuedMessage('s', 'q', 'original', 4, disabled), /requires session commands/u); }
  finally { disabled.dispose(); }
});

test('escrow discovery is metadata only and repeated plain-text reads do not consume or resend', async () => {
  const previous = globalThis.fetch; const requests: string[] = [];
  globalThis.fetch = async (path, init) => {
    requests.push(`${init?.method ?? 'GET'} ${path}`);
    return Response.json(String(path).endsWith('/queue-withdrawals')
      ? { withdrawals: [{ ...escrow, text: 'must not import from list' }] }
      : { withdrawal: { ...escrow, text: '  <b>original</b>\n exact text  ', attachments: [{ data: 'RAW_PRIVATE_BYTES' }] } });
  };
  try {
    const rows = await listQueueWithdrawals('s', '/workspace');
    assert.equal('text' in rows[0], false);
    for (let i = 0; i < 2; i++) {
      const recovered = await getQueueWithdrawal('s', '/workspace', escrow.id);
      assert.equal(recovered.text, '  <b>original</b>\n exact text  ');
      assert.equal('attachments' in recovered, false);
    }
    assert.ok(requests.every(value => value.startsWith('GET ')));
    await assert.rejects(getQueueWithdrawal('other-session', '/workspace', escrow.id), /identity/u);
    await assert.rejects(getQueueWithdrawal('s', '/other-root', escrow.id), /identity/u);
    await assert.rejects(getQueueWithdrawal('s', '/workspace', 'another-id'), /text/u);
    globalThis.fetch = async () => Response.json({}, { status: 404 });
    await assert.rejects(getQueueWithdrawal('s', '/workspace', escrow.id), /不能证明|does not establish/u);
  } finally { globalThis.fetch = previous; }
});

test('explicit escrow dismiss validates acknowledgement and rechecks plugin admission after CSRF', async () => {
  const previous = globalThis.fetch; const calls: string[] = []; let enabled = true;
  globalThis.fetch = async (path, init) => {
    calls.push(String(path));
    if (path === '/api/csrf') { enabled = false; return Response.json({ csrfToken: 'fixture' }); }
    assert.equal(init?.method, 'DELETE'); return Response.json({ dismissed: true, id: escrow.id });
  };
  try {
    await assert.rejects(dismissQueueWithdrawal('s', escrow.id, undefined, () => enabled), /no longer enabled/u);
    assert.deepEqual(calls, ['/api/csrf']);
    await dismissQueueWithdrawal('s', escrow.id);
    assert.equal(calls.at(-1), '/api/sessions/s/queue-withdrawals/c_escrow');
  } finally { globalThis.fetch = previous; }
});

test('authoritative escrow settles only the exact unknown withdrawal and releases later queue actions', async () => {
  let writes = 0; let identity = '';
  const client = new SessionCommandClient({ isEffective: () => true, queryAttempts: 1,
    post: async (_path, body) => {
      writes++; const value = body as { commandId: string; type: string };
      if (writes === 1) { identity = value.commandId; throw new TypeError('crash before ACK journal'); }
      return accepted(value.commandId, { id: 'q2', item: { id: 'q2', text: 'next' } });
    }, get: async () => ({ result: 'unknown' }),
  });
  try {
    await assert.rejects(withdrawQueuedMessage('s', 'q', 'original', 4, client), CommandDeliveryUnconfirmedError);
    const copy = { ...escrow, id: identity, text: 'original' };
    assert.equal(client.confirmQueueWithdrawal('s', '/other-root', copy), false);
    assert.equal(client.confirmQueueWithdrawal('s', '/workspace', { ...copy, text: 'different' }), false);
    assert.equal(client.confirmQueueWithdrawal('s', '/workspace', { ...copy, expectedRevision: 5 }), false);
    assert.equal(client.confirmQueueWithdrawal('s', '/workspace', copy), true);
    await editQueuedMessage('s', 'q2', 'next', 'old', client, 5);
    assert.equal(writes, 2);
  } finally { client.dispose(); }
});

test('a withdrawal escrow cannot settle an unrelated unknown cancellation or edit identity', async () => {
  for (const action of [cancelQueuedMessage, async (s: string, q: string, text: string, client: SessionCommandClient, revision: number) =>
    editQueuedMessage(s, q, 'next', text, client, revision)]) {
    let identity = '';
    const client = new SessionCommandClient({ isEffective: () => true, queryAttempts: 1,
      post: async (_path, body) => { identity = (body as { commandId: string }).commandId; throw new TypeError('lost'); },
      get: async () => ({ result: 'unknown' }),
    });
    try {
      await assert.rejects(action('s', 'q', 'original', client, 4), CommandDeliveryUnconfirmedError);
      assert.equal(client.confirmQueueWithdrawal('s', '/workspace', { ...escrow, id: identity, text: 'original' }), false);
    } finally { client.dispose(); }
  }
});

test('malformed escrow timestamps and non-original text fail closed before rendering or restoration', async () => {
  const previous = globalThis.fetch;
  try {
    for (const invalid of [{ createdAt: 1e20 }, { expiresAt: 1e20 }, { createdAt: -1 },
      { expiresAt: 1000 }, { expiresAt: 1.5 }, { text: '' }, { text: 'bad\0text' }]) {
      globalThis.fetch = async () => Response.json({ withdrawal: { ...escrow, text: 'original', ...invalid } });
      await assert.rejects(getQueueWithdrawal('s', '/workspace', escrow.id));
    }
  } finally { globalThis.fetch = previous; }
});
