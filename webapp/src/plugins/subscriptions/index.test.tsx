import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QuotaCard, filterAccounts } from './index';
import { safeAuthorizeUrl, parseModelIds, type SubscriptionAccount } from './api';
import { setLocale } from '../../i18n';

test('unavailable quota is distinct from a reported zero usage or zero balance', () => {
  setLocale('en');
  const unavailable = renderToStaticMarkup(<QuotaCard quota={{ supported: false, windows: [], checkedAt: 1000 }} />);
  assert.match(unavailable, /Unavailable/); assert.doesNotMatch(unavailable, /0%|<progress/);
  const reported = renderToStaticMarkup(<QuotaCard quota={{ supported: true, windows: [{ kind: 'weekly', usedPercent: 0 }, { kind: 'other', remaining: 0, unit: 'credits' }], checkedAt: 1000 }} />);
  assert.match(reported, /100% remaining/); assert.match(reported, /0.*credits/);
  setLocale('zh');
});
test('authorization links refuse script URLs, plaintext endpoints and embedded credentials', () => {
  assert.equal(safeAuthorizeUrl('javascript:alert(1)'), null);
  assert.equal(safeAuthorizeUrl('http://example.test/auth'), null);
  assert.equal(safeAuthorizeUrl('https://user:secret@example.test/auth'), null);
  assert.match(safeAuthorizeUrl('https://auth.openai.com/oauth/authorize?state=fixture')!, /^https:/);
});
test('subscription account search and groups cover account authorization and login credentials', () => {
  const rows = [{ id: 'qoder', name: 'Qoder', mode: 'local', help: 'Subscription account credentials', connected: false }, { id: 'codex', name: 'Codex', mode: 'oauth', connected: true }] as SubscriptionAccount[];
  assert.deepEqual(filterAccounts(rows, 'credentials', 'all').map(row => row.id), ['qoder']);
  assert.deepEqual(filterAccounts(rows, '', 'local').map(row => row.id), ['qoder']);
  assert.deepEqual(filterAccounts(rows, '', 'oauth').map(row => row.id), ['codex']);
  assert.deepEqual(filterAccounts(rows, '', 'connected').map(row => row.id), ['codex']);
  assert.deepEqual(parseModelIds(' a\n b,a，c \n'), ['a', 'b', 'c']);
});
