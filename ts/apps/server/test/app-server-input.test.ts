import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { it } from 'node:test';
import { realpathSync } from 'node:fs';
import { AppServer } from '../src/cli/app-server.ts';
import { serveAppServerInput } from '../src/cli/app-server-input.ts';
import type { Cli } from '../src/cli/host.ts';

type Row = Record<string, unknown>;
type Reply = [number, Row];
type Route = { method: string; path: string; query: Record<string, string[]>; body: Row };
const sid = 'a'.repeat(32);
const identity = realpathSync(process.cwd());
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitFor(check: () => boolean, message: string): Promise<void> {
  const until = Date.now() + 5000;
  while (!check() && Date.now() < until) await delay(10);
  assert.ok(check(), message);
}

function commandId(n: number): string { return `c_1234567890123_${n.toString(16).padStart(32, '0')}`; }
function request(id: string | number, method: string, params: Row): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
}

function harness(options: { initializeGate?: ReturnType<typeof deferred<void>>; holdRuns?: boolean } = {}) {
  const input = new PassThrough(), output = new PassThrough();
  const routes: Route[] = [], frames: Row[] = [];
  let trailing = '';
  output.setEncoding('utf8');
  output.on('data', (chunk: string) => {
    trailing += chunk;
    for (;;) {
      const at = trailing.indexOf('\n');
      if (at < 0) break;
      const line = trailing.slice(0, at); trailing = trailing.slice(at + 1);
      if (line) frames.push(JSON.parse(line) as Row);
    }
  });
  const releases = new Map<string, ReturnType<typeof deferred<Reply>>>();
  const host = {
    async dispatch(method: string, parts: string[], query: Record<string, string[]>, body: Row): Promise<Reply | null> {
      const path = '/' + parts.join('/');
      routes.push({ method, path, query, body });
      if (method === 'GET' && path === '/api/plugins') {
        await options.initializeGate?.promise;
        return [200, { plugins: [] }];
      }
      if (method === 'GET' && path === `/api/sessions/${sid}`) return [200, { root: identity }];
      if (method === 'POST' && path === `/api/sessions/${sid}/commands`) {
        const id = String(body.commandId ?? '');
        if (body.type === 'run' && options.holdRuns) {
          const gate = deferred<Reply>(); releases.set(id, gate); return gate.promise;
        }
        return [200, { accepted: true, commandId: id, type: body.type }];
      }
      if (method === 'GET' && /^\/api\/sessions\/[0-9a-f]{32}\/commands\//.test(path)) return [200, { state: 'unknown' }];
      if (method === 'POST' && path.endsWith('/stop')) return [200, { stopped: true }];
      return [404, { error: `unexpected route ${method} ${path}` }];
    },
    dynamicWorkflows: { async close() {} },
    agent: { async dispose() {} },
  };
  const cli = { enabled: (id: string) => id === 'remote' || id === 'sessions', host: async () => host, store: async () => ({ load: async () => ({ root: identity }) }) } as unknown as Cli;
  const app = new AppServer(cli, (frame) => new Promise<void>((resolve, reject) => {
    output.write(frame, (error) => error ? reject(error) : resolve());
  }), () => {}, identity);
  const serving = serveAppServerInput({ input, handle: (line) => app.handleLine(line), error: (id, code, message, data) => app.error(id, code, message, data), shutdown: () => app.shutdown(), stopping: () => app.stopping });
  return { input, output, app, host, routes, frames, releases, serving };
}

function resultFor(frames: Row[], id: string | number): Row | undefined { return frames.find((frame) => frame.id === id); }

it('holds frames behind initialize while 16 runs are active and still admits reserved stop/query controls', async () => {
  const init = deferred<void>(), h = harness({ initializeGate: init, holdRuns: true });
  try {
    const lines = [request('init', 'initialize', { protocolVersion: 2 })];
    for (let i = 1; i <= 16; i++) lines.push(request(`run-${i}`, 'command/execute', {
      workspaceIdentity: identity, sessionId: sid, commandId: commandId(i), type: 'run', payload: {},
    }));
    lines.push(request('stop', 'command/execute', {
      workspaceIdentity: identity, sessionId: sid, commandId: commandId(17), type: 'stop', payload: {},
    }));
    lines.push(request('query', 'command/query', { workspaceIdentity: identity, sessionId: sid, commandId: commandId(18) }));
    h.input.write(lines.join(''));
    await waitFor(() => h.routes.some((route) => route.path === '/api/plugins'), 'initialize should reach its catalog request');
    assert.equal(h.routes.filter((route) => route.path.endsWith('/commands') && route.body.type === 'run').length, 0,
      'subsequent NDJSON requests must wait for initialize to finish');

    init.resolve();
    await waitFor(() => h.releases.size === 16, 'all long runs should be admitted after initialize');
    await waitFor(() => resultFor(h.frames, 'stop') !== undefined && resultFor(h.frames, 'query') !== undefined,
      'reserved stop/query requests should complete while long runs remain pending');
    assert.equal(h.frames[0]?.id, 'init', 'initialize response must be written before later requests');
    assert.equal(h.frames.filter((frame) => String(frame.id).startsWith('run-')).length, 0,
      'held run responses must remain pending');
    assert.ok(h.routes.some((route) => route.method === 'POST' && route.path.endsWith('/commands') && route.body.type === 'stop'));
    assert.ok(h.routes.some((route) => route.method === 'GET' && route.path.endsWith(`/commands/${commandId(18)}`)));

    for (const gate of h.releases.values()) gate.resolve([200, { done: true }]);
    await waitFor(() => h.frames.filter((frame) => String(frame.id).startsWith('run-')).length === 16,
      'all run replies should arrive after their HTTP owners settle');
  } finally {
    init.resolve();
    for (const gate of h.releases.values()) gate.resolve([200, { done: true }]);
    h.input.end();
    await h.serving;
    h.output.destroy();
  }
});

it('rejects duplicate in-flight ids and oversized frames without corrupting the next legal frame', async () => {
  const h = harness({ holdRuns: true });
  try {
    h.input.write(request('same', 'command/execute', {
      workspaceIdentity: identity, sessionId: sid, commandId: commandId(31), type: 'run', payload: {},
    }));
    await waitFor(() => h.releases.has(commandId(31)), 'first command should be held in flight');
    h.input.write(request('same', 'command/query', { workspaceIdentity: identity, sessionId: sid, commandId: commandId(32) }));

    const oversized = `{"jsonrpc":"2.0","id":"large","method":"ignored","params":{"pad":"${'x'.repeat(1024 * 1024 + 128)}"}}\n`;
    h.input.write(oversized + request('after-large', 'command/query', {
      workspaceIdentity: identity, sessionId: sid, commandId: commandId(33),
    }));
    await waitFor(() => resultFor(h.frames, 'same')?.error !== undefined && resultFor(h.frames, 'after-large') !== undefined,
      'duplicate and post-oversize legal requests should both be answered');
    assert.equal((resultFor(h.frames, 'same')?.error as Row).code, -32600);
    const parseError = h.frames.find((frame) => (frame.error as Row | undefined)?.code === -32700);
    assert.equal(parseError?.id, null, 'oversized input is a frame-level parse error');
    assert.deepEqual(resultFor(h.frames, 'after-large')?.result, { state: 'unknown' });

    h.releases.get(commandId(31))!.resolve([200, { done: true }]);
    await waitFor(() => h.frames.some((frame) => frame.id === 'same' && Object.hasOwn(frame, 'result')),
      'the original command should complete');
    await delay(20);
    h.input.write(request('same', 'command/query', { workspaceIdentity: identity, sessionId: sid, commandId: commandId(34) }));
    await waitFor(() => h.frames.filter((frame) => frame.id === 'same').length === 3,
      'a completed request id should become reusable');
    assert.deepEqual(h.frames.filter((frame) => frame.id === 'same').at(-1)?.result, { state: 'unknown' });
  } finally {
    for (const gate of h.releases.values()) gate.resolve([200, { done: true }]);
    h.input.end();
    await h.serving;
    h.output.destroy();
  }
});
