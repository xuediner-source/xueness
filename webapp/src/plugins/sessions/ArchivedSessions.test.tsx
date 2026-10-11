import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ArchivedSessions, ArchivedSessionDeleteDialog } from './ArchivedSessions';

const entry = { id: 'a'.repeat(32), title: '<script>archived title</script>', task: 'fixture', revision: 'b'.repeat(64) };
test('archive deletion confirmation names and escapes its target and explains recovery and workspace scope', () => {
  const html = renderToStaticMarkup(<ArchivedSessionDeleteDialog entry={entry} onCancel={() => {}} onConfirm={() => {}} />);
  assert.match(html, /role="alertdialog"[^>]*aria-modal="true"/);
  assert.match(html, /永久删除归档会话？/);
  assert.match(html, /&lt;script&gt;archived title&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /无法恢复。工作区文件不会删除。/);
  assert.match(html, /xn-archived-delete-cancel/);
  assert.match(html, /xn-archived-delete-confirm/);
});

test('a pending deletion disables duplicate confirmation while failure remains readable', () => {
  const html = renderToStaticMarkup(<ArchivedSessionDeleteDialog entry={entry} busy error="fixture failure" onCancel={() => {}} onConfirm={() => {}} />);
  assert.equal((html.match(/disabled=""/g) ?? []).length, 2);
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /role="alert">fixture failure/);
  assert.match(html, /正在删除…/);
});

test('closed archives do not mount controls or a delete confirmation', () => {
  assert.equal(renderToStaticMarkup(<ArchivedSessions open={false} onClose={() => {}} onRestored={() => {}} />), '');
});
