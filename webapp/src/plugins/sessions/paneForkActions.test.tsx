import test from 'node:test';
import assert from 'node:assert/strict';
import { PaneForkCommand } from './paneForkActions';
import { CommandDeliveryUnconfirmedError, type SessionCommandClient } from './commandClient';
const source = 'a'.repeat(32);
const result = { sourceId: source, session: { id: 'b'.repeat(32) }, boundary: { turn: 1, preview: 'done' }, historyTruncated: false, truncationReason: null };
test('uncertain fork only queries original ID even after changed dialog intent', async () => {
  let posts = 0; let queries = 0; let id = '';
  const client = { submit: async (_sid: string, _type: string, _body: unknown, _fallback: unknown, commandId: string) => {
    posts++; id = commandId; throw new CommandDeliveryUnconfirmedError(id);
  }, query: async (sid: string, commandId: string) => { assert.equal(sid, source); assert.equal(commandId, id); queries++; return { status: 'accepted', result }; } } as unknown as SessionCommandClient;
  const command = new PaneForkCommand(client, source);
  await assert.rejects(command.submit({ boundary: 'first' }), CommandDeliveryUnconfirmedError);
  assert.deepEqual(await command.submit({ boundary: 'second' }), result);
  assert.deepEqual(await command.submit({ boundary: 'third' }), result);
  assert.equal(posts, 1); assert.equal(queries, 2);
});
test('foreign child receipt remains unknown and cannot admit a new fork', async () => {
  let posts = 0; let queries = 0;
  const client = { submit: async () => { posts++; return { ...result, sourceId: 'foreign' }; },
    query: async () => { queries++; return 'unknown'; } } as unknown as SessionCommandClient;
  const command = new PaneForkCommand(client, source);
  await assert.rejects(command.submit({}), CommandDeliveryUnconfirmedError);
  await assert.rejects(command.submit({}), CommandDeliveryUnconfirmedError);
  assert.equal(posts, 1); assert.equal(queries, 1);
});

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { usePrimaryForkCommand } from './primaryForkCommand';
import type { forkSession } from '../../xuenessWorkbench';
test('primary dialog retries reconcile the same durable fork without raw fallback', async () => {
  let posts = 0; let queries = 0; let captured = '';
  const fullResult = { ...result, session: { ...result.session, status: 'pending', root: '/work', title: 'fork' } };
  const client = { isEffective: () => true, submit: async (_sid: string, _type: string, _body: unknown, _fallback: unknown, id: string) => {
    posts++; captured = id; throw new CommandDeliveryUnconfirmedError(id);
  }, query: async (_sid: string, id: string) => { assert.equal(id, captured); queries++; return { status: 'accepted', result: fullResult }; } } as unknown as SessionCommandClient;
  let create: typeof forkSession;
  function Primary() { create = usePrimaryForkCommand(client, true, source); return null; }
  renderToStaticMarkup(<Primary />);
  assert.equal((await create!(source, 'boundary', 'revision')).ok, false);
  const recovered = await create!(source, 'different-boundary', 'different-revision');
  assert.equal(recovered.ok, true); assert.equal(posts, 1); assert.equal(queries, 1);
});

test('a refused preflight does not retain an ID that was never transmitted', async () => {
  let calls = 0;
  const client = { submit: async () => { calls++; if (calls === 1) throw Object.assign(new Error('another pane operation'), { requestNotSent: true }); return result; },
    query: async () => { throw new Error('must not query unsent ID'); } } as unknown as SessionCommandClient;
  const command = new PaneForkCommand(client, source);
  await assert.rejects(command.submit({}), /another pane operation/);
  assert.deepEqual(await command.submit({}), result);
  assert.equal(calls, 2);
});

test('primary fork rechecks effectiveness after loading admission code', async () => {
  let effective = true; let posts = 0;
  const client = { isEffective: () => effective, submit: async () => { posts++; return result; } } as unknown as SessionCommandClient;
  let create: typeof forkSession;
  function Primary() { create = usePrimaryForkCommand(client, true, source); return null; }
  renderToStaticMarkup(<Primary />);
  const opening = create!(source, 'boundary', 'revision');
  effective = false;
  assert.equal((await opening).ok, false);
  assert.equal(posts, 0);
});

test('concurrent primary fork clicks share one lazily loaded command', async () => {
  let posts = 0;
  const fullResult = { ...result, session: { ...result.session, status: 'pending', root: '/work', title: 'fork' } };
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const client = { isEffective: () => true, submit: async () => { posts++; await held; return fullResult; } } as unknown as SessionCommandClient;
  let create: typeof forkSession;
  function Primary() { create = usePrimaryForkCommand(client, true, source); return null; }
  renderToStaticMarkup(<Primary />);
  const first = create!(source, 'boundary', 'revision');
  const second = create!(source, 'boundary', 'revision');
  assert.equal((await second).ok, false);
  release();
  assert.equal((await first).ok, true);
  assert.equal(posts, 1);
});

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
test('primary fork startup entry loads command admission only when used', () => {
  let source = '';
  for (const root of ['src', 'webapp/src']) {
    try { source = readFileSync(resolve(root, 'plugins/sessions/primaryForkCommand.ts'), 'utf8'); break; }
    catch { /* Support both frontend and repository test working directories. */ }
  }
  assert.ok(source, 'primary fork entry must be readable');
  source = source.replace(/^\s*import\s+type\b[^;]*;\s*$/gmu, '');
  assert.doesNotMatch(source, /from\s+['"]\.\/(?:commandClient|paneHistoryActions|paneForkActions)['"]/);
  assert.match(source, /import\(\s*['"]\.\/paneForkActions['"]\s*\)/);
});
