import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { ComposerWorkspaceSelect } from './ComposerWorkspaceSelect';
import { createComposerCatalogLoader, clearWorkspaceComposerCatalog } from './composerCatalogLifecycle';
import { emptyComposerCatalog, type ComposerCatalog } from '../../xuenessComposer';

test('workspace menu stays clickable during catalog loading and locks only for a real task or branch change', () => {
  const render = (busy: boolean) => renderToStaticMarkup(<ComposerWorkspaceSelect busy={busy} loading value="/runs"><option value="/runs">runs</option></ComposerWorkspaceSelect>);
  const trigger = (html: string) => html.match(/<button[^>]*role="combobox"[^>]*>/)?.[0] ?? '';
  assert.match(trigger(render(false)), /aria-busy="true"/);
  assert.doesNotMatch(trigger(render(false)), /disabled/);
  assert.match(trigger(render(true)), /disabled/);
});

test('a fast second workspace wins even when the first request ignores abort and finishes later', async () => {
  const requests: Array<{ root?: string; signal?: AbortSignal; resolve: (value: ComposerCatalog) => void }> = [];
  const loader = createComposerCatalogLoader({ read: (root, _session, signal) => new Promise(resolve => requests.push({ root, signal, resolve })) });
  const applied: string[] = [], loading: boolean[] = [], errors: unknown[] = [];
  const options = { onCatalog: (catalog: ComposerCatalog) => applied.push(catalog.root!), onLoading: (value: boolean) => loading.push(value), onError: (value: unknown) => errors.push(value) };
  const first = loader.load({ ...options, root: '/runs' });
  const second = loader.load({ ...options, root: '/project' });
  assert.equal(requests[0].signal?.aborted, true);
  assert.equal(requests[1].signal?.aborted, false);
  requests[1].resolve({ ...emptyComposerCatalog, root: '/project' });
  await second;
  requests[0].resolve({ ...emptyComposerCatalog, root: '/runs' });
  await first;
  assert.deepEqual(applied, ['/project']);
  assert.deepEqual(loading, [true, true, false]);
  assert.deepEqual(errors, []);
});

test('timeout releases loading without waiting for a transport that ignores cancellation', async () => {
  let expire!: () => void, resolve!: (value: ComposerCatalog) => void;
  let signal: AbortSignal | undefined;
  const loading: boolean[] = [], errors: unknown[] = [], applied: unknown[] = [];
  const loader = createComposerCatalogLoader({
    read: (_root, _session, value) => { signal = value; return new Promise(done => { resolve = done; }); },
    schedule: callback => { expire = callback; return 1; }, clear: () => {},
  });
  const pending = loader.load({ onLoading: value => loading.push(value), onCatalog: value => applied.push(value), onError: value => errors.push(value) });
  expire();
  assert.equal(signal?.aborted, true);
  assert.deepEqual(loading, [true, false]);
  assert.match(String(errors[0]), /加载超时/);
  resolve(emptyComposerCatalog); await pending;
  assert.deepEqual(applied, []);
});

test('unmount or plugin disable cancels the request, timer and all late callbacks', async () => {
  let resolve!: (value: ComposerCatalog) => void, expire!: () => void;
  const applied: unknown[] = [], cancelled: unknown[] = [];
  const loader = createComposerCatalogLoader({ read: () => new Promise(done => { resolve = done; }),
    schedule: callback => { expire = callback; return 1; }, clear: timer => cancelled.push(timer) });
  const pending = loader.load({ onLoading: value => applied.push(value), onCatalog: value => applied.push(value), onError: value => applied.push(value) });
  loader.cancel(); expire(); resolve(emptyComposerCatalog); await pending;
  assert.deepEqual(applied, [true]);
  assert.ok(cancelled.includes(1));
});

test('switching clears folder-specific context while preserving global model and root choices', () => {
  const previous = { ...emptyComposerCatalog, root: '/old', roots: [{ path: '/new', name: 'new' }], files: [{ id: 'private.txt', label: 'private' }], sessions: [{ id: 'old', label: 'old' }], git: { branch: 'old', branches: ['old'] }, backgroundCount: 1 };
  const next = clearWorkspaceComposerCatalog(previous);
  assert.deepEqual(next.files, []); assert.deepEqual(next.sessions, []); assert.equal(next.git, undefined);
  assert.equal(next.root, null); assert.equal(next.backgroundCount, undefined);
  assert.equal(next.roots, previous.roots); assert.equal(next.models, previous.models);
});
