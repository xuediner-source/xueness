import test from 'node:test';
import assert from 'node:assert/strict';
import { TerminalSessionRegistry, type TerminalApi, type TerminalSurface } from './terminalSessionRegistry';

const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
function fixture(initial = '[]') {
  const calls = { open: [] as string[], close: [] as string[], poll: [] as number[], input: [] as string[], dispose: 0, surfaces: 0, attaches: 0, detaches: 0, output: [] as (string | Uint8Array)[] };
  const storage = { value: initial, getItem() { return this.value; }, setItem(_key: string, value: string) { this.value = value; } };
  const response = deferred<Awaited<ReturnType<TerminalApi['poll']>>>();
  const api: TerminalApi = {
    list: async () => ({ terminals: [] }),
    open: async session => { calls.open.push(session); return { id: `pty-${calls.open.length}` }; },
    poll: async (_id, cursor) => { calls.poll.push(cursor); return response.promise; },
    input: async (_id, text) => { calls.input.push(text); }, resize: async () => {},
    close: async id => { calls.close.push(id); },
  };
  let input!: (text: string) => void;
  const surface = async (_entry: unknown, send: (text: string) => void): Promise<TerminalSurface> => {
    calls.surfaces++; input = send;
    return { write: data => { calls.output.push(data); }, attach: () => { calls.attaches++; }, detach: () => { calls.detaches++; }, configure() {}, dispose: () => { calls.dispose++; } };
  };
  const registry = new TerminalSessionRegistry(api, surface, storage);
  return { api, calls, registry, storage, response, send: (text: string) => input(text) };
}
const host = () => ({} as HTMLElement);

test('detach, remount, workspace switch and session switch preserve one PTY and xterm owner', async () => {
  const f = fixture();
  const a = (await f.registry.create('/a', 'session-a'))!;
  const h = host(); f.registry.attach(a, h); await settle();
  f.registry.detach(a, h);
  const b = (await f.registry.create('/b', 'session-b'))!;
  f.registry.attach(b, host()); await settle();
  f.registry.attach(a, host()); await settle();
  assert.equal(f.calls.surfaces, 2);
  assert.equal(f.calls.open.length, 2);
  assert.equal(f.calls.dispose, 0);
  assert.deepEqual(f.calls.close, []);
  assert.equal(f.registry.tabs('/a')[0], a);
  assert.equal(a.sessionId, 'session-a');
  f.registry.close(a); f.registry.close(a); f.registry.close(b);
  assert.deepEqual(f.calls.close, ['pty-1', 'pty-2']);
  assert.equal(f.calls.dispose, 2);
});

test('close while explicit open is pending closes the late PTY exactly once', async () => {
  const f = fixture(); const pending = deferred<{ id: string }>();
  f.api.open = () => pending.promise;
  const creating = f.registry.create('/a', 's'); await settle();
  const entry = f.registry.tabs('/a')[0]; f.registry.close(entry);
  pending.resolve({ id: 'late' }); await creating;
  assert.deepEqual(f.calls.close, ['late']); assert.equal(f.calls.surfaces, 0);
});

test('workspace removal cancels creation waiting for restore, while a fresh explicit create can re-add it', async () => {
  const f = fixture(JSON.stringify([{ workspaceId: '/a', tabId: 'saved', sessionId: 's', terminalId: 'saved', title: 'Saved' }]));
  const listing = deferred<Awaited<ReturnType<TerminalApi['list']>>>();
  f.api.list = () => listing.promise;
  const stale = f.registry.create('/a', 'old-intent');
  f.registry.removeWorkspace('/a');
  const fresh = f.registry.create('/a', 'fresh-intent');
  listing.resolve({ terminals: [{ id: 'saved', session_id: 's', closed: false }] });
  assert.equal(await stale, undefined);
  const entry = await fresh;
  assert.ok(entry);
  assert.deepEqual(f.calls.open, ['fresh-intent']);
  assert.deepEqual(f.calls.close, ['saved']);
  assert.equal(f.registry.tabs('/a').length, 1);
  f.registry.close(entry);
});

test('disable then re-enable cancels creation waiting for restore without suppressing a fresh click', async () => {
  const f = fixture(JSON.stringify([{ workspaceId: '/a', tabId: 'saved', sessionId: 's', terminalId: 'saved', title: 'Saved' }]));
  const listing = deferred<Awaited<ReturnType<TerminalApi['list']>>>();
  f.api.list = () => listing.promise;
  const stale = f.registry.create('/a', 'old-intent');
  f.registry.setEnabled(false);
  f.registry.setEnabled(true);
  listing.resolve({ terminals: [] });
  assert.equal(await stale, undefined);
  assert.deepEqual(f.calls.open, []);
  assert.deepEqual(f.registry.tabs('/a'), []);
  const fresh = await f.registry.create('/a', 'fresh-intent');
  assert.ok(fresh);
  assert.deepEqual(f.calls.open, ['fresh-intent']);
  f.registry.close(fresh);
});

test('plugin disable stops input/polling and disposes resources even when all views are detached', async () => {
  const f = fixture(); const entry = (await f.registry.create('/a', 's'))!;
  const h = host(); f.registry.attach(entry, h); await settle();
  f.registry.detach(entry, h); f.registry.setEnabled(false); f.registry.setEnabled(false);
  f.send('do not send'); await settle();
  f.response.resolve({ data: 'aGVsbG8=', cursor: 5, truncated: false, closed: false }); await settle();
  assert.equal(entry.controller.signal.aborted, true);
  assert.equal(f.calls.dispose, 1); assert.deepEqual(f.calls.close, ['pty-1']);
  assert.deepEqual(f.calls.input, []); assert.deepEqual(f.calls.output, []);
  assert.equal(await f.registry.create('/a', 's'), undefined);
});

test('remote creation is blocked before calling the local API', async () => {
  const f = fixture(); assert.equal(await f.registry.create('/remote', 's', true), undefined);
  assert.deepEqual(f.calls.open, []);
});

test('restore reconciles descriptors with broker, missing PTYs stay stopped, never spawns shells', async () => {
  const descriptors = [
    { workspaceId: '/a', tabId: 'a', sessionId: 's', terminalId: 'live', title: 'A' },
    { workspaceId: '/b', tabId: 'b', sessionId: 's2', terminalId: 'gone', title: 'B' },
    { workspaceId: '/c', tabId: 'c', sessionId: 'wrong', terminalId: 'foreign', title: 'C' },
  ];
  const f = fixture(JSON.stringify(descriptors));
  f.api.list = async () => ({ terminals: [{ id: 'live', session_id: 's', closed: false }, { id: 'foreign', session_id: 'other', closed: false }] });
  await Promise.all([f.registry.restore(), f.registry.restore()]);
  assert.equal(f.registry.tabs('/a')[0].status, 'running');
  assert.equal(f.registry.tabs('/b')[0].status, 'stopped');
  assert.equal(f.registry.tabs('/c')[0].status, 'stopped');
  assert.deepEqual(f.calls.open, []); assert.deepEqual(f.calls.poll, []);
  f.registry.setEnabled(false);
  assert.deepEqual(f.calls.close, ['live'], 'never close a missing or differently owned saved terminal');
});

test('storage contains descriptors only, never output, cursor, xterm or process handles', async () => {
  const f = fixture(); const entry = (await f.registry.create('/a', 's'))!;
  assert.deepEqual(Object.keys(JSON.parse(f.storage.value)[0]).sort(), ['sessionId', 'tabId', 'terminalId', 'title', 'workspaceId']);
  f.registry.close(entry);
});

test('explicit workspace removal only disposes its own tabs and wins over pending restoration', async () => {
  const f = fixture(); const a = (await f.registry.create('/a', 's'))!;
  const b = (await f.registry.create('/b', 's'))!;
  f.registry.removeWorkspace('/a'); f.registry.removeWorkspace('/a');
  assert.equal(a.disposed, true); assert.equal(b.disposed, false);
  assert.deepEqual(f.calls.close, ['pty-1']); f.registry.close(b);
  const g = fixture(JSON.stringify([{ workspaceId: '/a', tabId: 'a', sessionId: 's', terminalId: 'live', title: 'A' }]));
  const listing = deferred<Awaited<ReturnType<TerminalApi['list']>>>(); g.api.list = () => listing.promise;
  const restoring = g.registry.restore(); g.registry.removeWorkspace('/a');
  listing.resolve({ terminals: [{ id: 'live', session_id: 's', closed: false }] }); await restoring;
  assert.deepEqual(g.registry.tabs('/a'), []);
  assert.deepEqual(g.calls.close, ['live']);
  assert.equal(g.storage.value, '[]');
});

test('async xterm creation completing after close is disposed once without attaching or polling', async () => {
  const f = fixture(); const pending = deferred<TerminalSurface>(); let disposed = 0;
  const registry = new TerminalSessionRegistry(f.api, () => pending.promise);
  const entry = (await registry.create('/a', 's'))!;
  registry.attach(entry, host()); registry.close(entry);
  pending.resolve({ write() {}, attach() { assert.fail('closed surface attached'); }, detach() {}, configure() {}, dispose() { disposed++; } });
  await settle(); assert.equal(disposed, 1); assert.deepEqual(f.calls.poll, []);
});

test('poll cursor and scrollback stay with owner on detach and malformed data never advances cursor', async () => {
  const f = fixture(); const entry = (await f.registry.create('/a', 's'))!;
  const h = host(); f.registry.attach(entry, h); await settle(); f.registry.detach(entry, h);
  f.response.resolve({ data: 'aGVsbG8=', cursor: 5, truncated: false, closed: true }); await settle();
  assert.equal(entry.cursor, 5); assert.equal(f.calls.output.length, 1);
  f.registry.attach(entry, host()); await settle(); assert.equal(f.calls.surfaces, 1);
  f.registry.close(entry);
  const g = fixture(); const invalid = (await g.registry.create('/b', 's'))!;
  g.registry.attach(invalid, host()); await settle();
  const log = console.error; console.error = () => {};
  try { g.response.resolve({ data: '!', cursor: 42, truncated: false, closed: false }); await settle(); }
  finally { console.error = log; }
  assert.equal(invalid.cursor, 0); assert.match(invalid.error, /cursor retained/); g.registry.close(invalid);
});

test('selection survives view changes without becoming a conversation selection', async () => {
  const f = fixture(); const a = (await f.registry.create('/a', 's1'))!; const b = (await f.registry.create('/a', 's2'))!;
  f.registry.select(a); assert.equal(f.registry.selected('/a'), a);
  const h = host(); f.registry.attach(a, h); await settle(); f.registry.detach(a, h);
  assert.equal(f.registry.selected('/a'), a);
  f.registry.close(a); assert.equal(f.registry.selected('/a'), b); f.registry.close(b);
});

test('failed close is visible and is not silently retried by repeated disposal', async () => {
  const f = fixture(); let attempts = 0;
  f.api.close = async () => { attempts++; throw new Error('connection lost'); };
  const entry = (await f.registry.create('/a', 's'))!;
  f.registry.close(entry); f.registry.close(entry); await settle();
  assert.equal(attempts, 1); assert.match(f.registry.error, /close failed.*connection lost/);
});
