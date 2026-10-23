import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { getLocale, setLocale } from '../../i18n';
import {
  deleteConfirmationReducer, WorkbuddyAccountCard, WorkbuddyEmptyState,
  type DeleteConfirmationAction,
} from './WorkbuddySettings';
import { parseCredentialsJson, readWorkbuddyCredentialsFile, type WorkbuddyAccount } from './api';

const account = (overrides: Partial<WorkbuddyAccount> = {}): WorkbuddyAccount => ({
  id: 'local-account', uid: 'uid-42', nickname: 'Mina', credits: null, cooling: false, disabled: false,
  inFlight: 0, lastSuccess: null, lastError: null, cooldownUntil: null, ...overrides,
});

test('empty accounts and unreported credits have explicit states; a real zero stays zero', () => {
  const previous = getLocale();
  try {
    setLocale('en');
    assert.match(renderToStaticMarkup(<WorkbuddyEmptyState />), /No WorkBuddy accounts yet/);
    const card = (row: WorkbuddyAccount) => renderToStaticMarkup(<WorkbuddyAccountCard account={row}
      gatewayAvailable deleteConfirmation={null} onDeleteRequest={() => {}} onDeleteConfirm={() => {}} onDeleteCancel={() => {}} />);
    assert.match(card(account()), /Not reported/);
    assert.match(card(account()), /data-state="unknown"/);
    assert.match(card(account({ credits: 0 })), /<dd>0<\/dd>/);
  } finally { setLocale(previous); }
});

test('a single JSON credential file is parsed as an object without rendering its contents', async () => {
  const secret = { uid: 'uid-private', access_token: 'token-private' };
  const parsed = await readWorkbuddyCredentialsFile({ name: 'workbuddy.json', text: async () => JSON.stringify(secret) });
  assert.deepEqual(parsed, secret);
  assert.throws(() => parseCredentialsJson('[]'), /workbuddy-file-json/);
  await assert.rejects(readWorkbuddyCredentialsFile({ name: 'workbuddy.txt', text: async () => JSON.stringify(secret) }), /workbuddy-file-extension/);
  const rendered = renderToStaticMarkup(<WorkbuddyAccountCard account={account()} gatewayAvailable deleteConfirmation={null}
    onDeleteRequest={() => {}} onDeleteConfirm={() => {}} onDeleteCancel={() => {}} />);
  assert.doesNotMatch(rendered, /token-private|uid-private/);
});

test('deleting an account requires an inline confirmation and can be cancelled', () => {
  const previous = getLocale();
  try {
    setLocale('en');
    let state = deleteConfirmationReducer(null, { type: 'request', accountId: account().id });
    const confirming = renderToStaticMarkup(<WorkbuddyAccountCard account={account()} gatewayAvailable deleteConfirmation={state}
      onDeleteRequest={() => {}} onDeleteConfirm={() => {}} onDeleteCancel={() => {}} />);
    assert.match(confirming, /Confirm delete/);
    assert.match(confirming, /Cancel/);
    state = deleteConfirmationReducer(state, { type: 'cancel' } satisfies DeleteConfirmationAction);
    assert.equal(state, null);
    state = deleteConfirmationReducer(null, { type: 'request', accountId: account().id });
    state = deleteConfirmationReducer(state, { type: 'complete', accountId: account().id });
    assert.equal(state, null);
  } finally { setLocale(previous); }
});
