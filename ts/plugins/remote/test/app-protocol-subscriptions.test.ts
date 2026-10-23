import assert from 'node:assert/strict';
import { it } from 'node:test';
import { AppProtocolDeferredReply, AppProtocolSubscriptions } from '../src/app-protocol-subscriptions.ts';
import type { AppProtocolPort, ProtocolRow } from '../src/app-protocol-types.ts';

type Call = { method: string; path: string; data?: ProtocolRow; query?: Record<string, string[]> };
const identity = 'workspace';
const sid = 'a'.repeat(32);
const epoch1 = 'b'.repeat(32);
const epoch2 = 'c'.repeat(32);
const runId = 'd'.repeat(32);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check: () => boolean, message: string): Promise<void> {
  const until = Date.now() + 3000;
  while (!check() && Date.now() < until) await sleep(20);
  assert.ok(check(), message);
}

function conversation(epoch: string, seq: number, mode: string, frames: ProtocolRow[]): ProtocolRow {
  return { schema: 'xueness.conversation-transport.v1', topic: `conversation/${sid}`, mode, logEpoch: epoch, seq, frames };
}

it('defers initial frames until the reply is sent, pauses persistence delivery, falls back after epoch loss, and fences resync/unsubscribe', async () => {
  const calls: Call[] = [], notices: { method: string; params: ProtocolRow }[] = [];
  let current = conversation(epoch1, 1, 'snapshot', [{ kind: 'snapshot', logEpoch: epoch1, fromSeq: 0, toSeq: 1, snapshot: {} }]);
  const port: AppProtocolPort = {
    workspaceIdentity: identity,
    async ask(method, path, data, query) {
      calls.push({ method, path, data, query });
      const requestedEpoch = query?.logEpoch?.[0], requestedSeq = Number(query?.seq?.[0]);
      if (path.endsWith('/conversation-transport')) {
        if (requestedEpoch === current.logEpoch && requestedSeq === current.seq) return { ...current, mode: 'resume', frames: [] };
        return current;
      }
      return {};
    },
    async authorize(id) { assert.equal(id, sid); },
    enabled: () => true,
  };
  const subscriptions = new AppProtocolSubscriptions({ port, version: () => 2, notify: async (method, params) => { notices.push({ method, params }); }, wrap: (_method, _id, result) => result });
  const methods = subscriptions.methods;
  try {
    const initial = await methods['conversation/subscribe']!({ workspaceIdentity: identity, sessionId: sid }) as AppProtocolDeferredReply;
    assert.ok(initial instanceof AppProtocolDeferredReply);
    assert.equal(notices.length, 0, 'subscribe must not publish before its RPC response is sent');
    assert.equal(initial.result.generation, 1);
    await initial.afterResponse();
    assert.equal(notices.length, 1);
    assert.equal(notices[0]?.params.delivery, 'initial');
    assert.equal((notices[0]?.params.envelope as ProtocolRow).mode, 'snapshot');
    const subscriptionId = initial.result.subscriptionId as string;

    await methods['connection/flow']!({ workspaceIdentity: identity, paused: true });
    current = conversation(epoch1, 2, 'resume', [{ kind: 'delta', logEpoch: epoch1, fromSeq: 1, toSeq: 2, operations: [{ op: 'replace', path: '/status', value: 'paused' }] }]);
    await sleep(450);
    assert.equal(notices.length, 1, 'durable changes stay quiet while flow is paused');
    await methods['connection/flow']!({ workspaceIdentity: identity, paused: false });
    await waitFor(() => notices.length === 2, 'resuming flow should publish the pending conversation delta');
    assert.equal(notices[1]?.params.delivery, 'online');
    assert.deepEqual([notices[1]?.params.fromSeq, notices[1]?.params.toSeq], [1, 2]);
    assert.equal((notices[1]?.params.envelope as ProtocolRow).mode, 'resume');

    current = conversation(epoch2, 1, 'snapshot', [{ kind: 'snapshot', logEpoch: epoch2, fromSeq: 0, toSeq: 1, snapshot: { reset: true } }]);
    await waitFor(() => notices.length === 3, 'lost projection epoch should publish a snapshot fallback');
    assert.equal((notices[2]?.params.envelope as ProtocolRow).mode, 'snapshot');
    assert.equal(((notices[2]?.params.envelope as ProtocolRow).frames as ProtocolRow[])[0]?.kind, 'snapshot');

    const recovery = await methods['conversation/resync']!({ workspaceIdentity: identity, subscriptionId, logEpoch: epoch2, seq: 1 }) as AppProtocolDeferredReply;
    assert.equal(recovery.result.generation, 2);
    assert.equal(notices.length, 3, 'resync must wait until its response is sent');
    await recovery.afterResponse();
    assert.equal(notices.length, 4);
    assert.equal(notices[3]?.params.delivery, 'recovery');
    assert.equal(notices[3]?.params.generation, recovery.result.generation);

    await methods['conversation/unsubscribe']!({ workspaceIdentity: identity, subscriptionId });
    current = conversation(epoch2, 2, 'resume', [{ kind: 'delta', logEpoch: epoch2, fromSeq: 1, toSeq: 2, operations: [] }]);
    await sleep(450);
    assert.equal(notices.length, 4, 'unsubscribed projections must not publish later changes');
    assert.ok(calls.some((call) => call.path.endsWith('/conversation-transport') && call.query?.logEpoch?.[0] === epoch1));
  } finally { subscriptions.close(); }
});

it('relays workflow event gaps and status changes without starting workflow or model execution', async () => {
  const calls: Call[] = [], notices: { method: string; params: ProtocolRow }[] = [];
  let page: ProtocolRow = { runId, status: 'paused', oldestSeq: 5, gap: true, events: [{ seq: 6, type: 'node.completed' }] };
  const port: AppProtocolPort = {
    workspaceIdentity: identity,
    async ask(method, path, data, query) {
      calls.push({ method, path, data, query });
      return path.endsWith('/events') ? page : { id: runId, status: page.status };
    },
    async authorize(id) { assert.equal(id, sid); },
    enabled: () => true,
  };
  const subscriptions = new AppProtocolSubscriptions({ port, version: () => 2, notify: async (method, params) => { notices.push({ method, params }); }, wrap: (_method, _id, result) => result });
  try {
    const initial = await subscriptions.methods['workflow/subscribe']!({ workspaceIdentity: identity, sessionId: sid, runId, afterSeq: 2 }) as AppProtocolDeferredReply;
    assert.equal(notices.length, 0);
    await initial.afterResponse();
    assert.equal(notices.length, 1);
    const first = notices[0]?.params.envelope as ProtocolRow;
    assert.equal(first.gap, true);
    assert.equal(first.status, 'paused');
    assert.deepEqual(calls.map((call) => [call.method, call.path]), [
      ['GET', `/api/sessions/${sid}/workflow-scripts/${runId}`],
      ['GET', `/api/sessions/${sid}/workflow-scripts/${runId}/events`],
    ]);
    assert.equal(calls[1]?.query?.afterSeq?.[0], '2');

    page = { runId, status: 'completed', oldestSeq: 5, gap: false, events: [] };
    await waitFor(() => notices.length === 2, 'status-only transitions must be delivered even when no new events exist');
    const next = notices[1]?.params.envelope as ProtocolRow;
    assert.equal(next.status, 'completed');
    assert.deepEqual(next.events, []);
    assert.ok(calls.every((call) => call.method === 'GET' && !call.path.endsWith('/run')), 'watching must remain read-only');
  } finally { subscriptions.close(); }
});

it('retries a controller change when flow pauses during its in-flight projection read', async () => {
  const calls: Call[] = [], notices: { method: string; params: ProtocolRow }[] = [];
  let current: ProtocolRow = { sessions: [{ id: sid, root: identity, status: 'initial' }] };
  let indexReads = 0, startSecond!: () => void, releaseSecond!: (value: ProtocolRow) => void;
  const secondStarted = new Promise<void>((resolve) => { startSecond = resolve; });
  const secondRead = new Promise<ProtocolRow>((resolve) => { releaseSecond = resolve; });
  const port: AppProtocolPort = {
    workspaceIdentity: identity,
    async ask(method, path, data, query) {
      calls.push({ method, path, data, query });
      if (path === '/api/sessions/index') {
        indexReads++;
        if (indexReads === 2) { startSecond(); return secondRead; }
        return current;
      }
      return {};
    },
    async authorize(id) { assert.equal(id, sid); },
    enabled: () => true,
  };
  const subscriptions = new AppProtocolSubscriptions({ port, version: () => 2, notify: async (method, params) => { notices.push({ method, params }); }, wrap: (_method, _id, result) => result });
  try {
    const initial = await subscriptions.methods['controller/subscribe']!({ workspaceIdentity: identity }) as AppProtocolDeferredReply;
    await initial.afterResponse();
    assert.equal(notices.length, 1);
    assert.equal((notices[0]?.params.envelope as ProtocolRow).kind, 'snapshot');

    current = { sessions: [{ id: sid, root: identity, status: 'changed-while-reading' }] };
    await secondStarted;
    await subscriptions.methods['connection/flow']!({ workspaceIdentity: identity, paused: true });
    releaseSecond(current);
    await sleep(30);
    assert.equal(notices.length, 1, 'the in-flight read must not notify after flow has paused');

    await subscriptions.methods['connection/flow']!({ workspaceIdentity: identity, paused: false });
    await waitFor(() => notices.length === 2, 'resume must retry the state observed by the paused read');
    const delivered = notices[1]?.params.envelope as ProtocolRow;
    assert.equal(notices[1]?.params.delivery, 'online');
    assert.equal((delivered.snapshot as ProtocolRow).sessions[0]?.status, 'changed-while-reading');
    assert.ok(indexReads >= 3, 'resume must perform a fresh projection read');
  } finally { subscriptions.close(); }
});
