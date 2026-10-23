'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createDesktopStateStore } = require('../src/desktop-state-store.cjs');

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'xueness-desktop-state-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, file: join(directory, 'desktop-state-v1.json') };
}

test('desktop storage persists only fixed workbench keys and preserves future entries', t => {
  const { directory, file } = fixture(t);
  writeFileSync(file, JSON.stringify({ version: 1, entries: { 'future:key': 'keep me' } }));
  const store = createDesktopStateStore(file);
  const draftKey = 'xueness:composer-drafts:v1:workspace%3Aone';
  const draft = JSON.stringify({ version: 1, scopes: { 'new-task': { text: 'continue tomorrow', attachmentRefs: [{ id: 'a'.repeat(32) }] } } });
  store.setItem(draftKey, draft);
  store.setItem('xueness:chat-prompt-history:workspace%3Aone', JSON.stringify(['check the logs']));
  store.setItem('xueness.sessions.pane-layout.v2', JSON.stringify({ v: 2, groups: [], activeGroupId: null }));
  assert.equal(store.getItem(draftKey), draft);
  assert.equal(store.getItem('future:key'), null, 'unknown entries are never exposed to the renderer');

  const persisted = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(persisted.entries['future:key'], 'keep me', 'updates retain opaque future records');
  assert.equal(persisted.entries[draftKey], draft);
  assert.deepEqual(readdirSync(directory), ['desktop-state-v1.json'], 'atomic updates leave no temporary file');

  const restarted = createDesktopStateStore(file);
  assert.equal(restarted.getItem(draftKey), draft, 'a new host process can hydrate the same state');
  restarted.removeItem(draftKey);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).entries['future:key'], 'keep me');
  assert.equal(restarted.getItem(draftKey), null);
});

test('writing an unchanged desktop preference does not touch its backing file', t => {
  const { file } = fixture(t);
  const store = createDesktopStateStore(file);
  const key = 'xueness.sidebar-collapsed.v1';
  const value = JSON.stringify({ collapsed: true });
  store.setItem(key, value);
  const oldTime = new Date('2020-01-01T00:00:00.000Z');
  utimesSync(file, oldTime, oldTime);
  const prior = statSync(file);

  store.setItem(key, value);

  const current = statSync(file);
  assert.equal(current.mtimeMs, prior.mtimeMs);
  assert.deepEqual(readdirSync(join(file, '..')), ['desktop-state-v1.json']);
});

test('desktop storage rejects unknown keys, unencoded workspace keys, oversized values, and attachment bodies', t => {
  const { file } = fixture(t);
  const store = createDesktopStateStore(file);
  assert.throws(() => store.setItem('xueness:arbitrary-plugin-state', 'value'), /Unsupported/);
  assert.throws(() => store.setItem('xueness:composer-drafts:v1:bad%escape', '{}'), /Unsupported/);
  assert.throws(() => store.setItem('xueness.sessions.pane-layout.v2', 'x'.repeat(128 * 1024 + 1)), /limit/);
  assert.throws(() => store.setItem('xueness:composer-drafts:v1:ws', JSON.stringify({ version: 1, scopes: {
    draft: { text: 'draft', attachments: [{ name: 'secret.txt', data: 'file bytes' }] },
  } })), /Invalid composer draft/);
  assert.equal(readdirSync(join(file, '..')).length, 0, 'rejected values do not create storage files');
});

test('corrupt or unsupported state files are preserved and become read-only', t => {
  const { file } = fixture(t);
  const corrupt = '{not valid state';
  writeFileSync(file, corrupt);
  const store = createDesktopStateStore(file);
  assert.equal(store.getItem('xueness.sessions.pane-layout.v2'), null);
  assert.throws(() => store.setItem('xueness.sessions.pane-layout.v2', '{}'), /unavailable/);
  assert.equal(readFileSync(file, 'utf8'), corrupt, 'a failed read never turns into an empty rewrite');

  const unsupported = JSON.stringify({ version: 2, entries: { future: 'keep' } });
  writeFileSync(file, unsupported);
  const newerStore = createDesktopStateStore(file);
  assert.throws(() => newerStore.removeItem('xueness.sidebar-widths.v1'), /unavailable/);
  assert.equal(readFileSync(file, 'utf8'), unsupported);
});
