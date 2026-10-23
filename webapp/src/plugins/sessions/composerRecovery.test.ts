import test from 'node:test';
import assert from 'node:assert/strict';
import { retainRejectedComposerDraft, recoverComposerDraft, subscribeComposerDrafts, notifyComposerDrafts, relocateEmptyComposerDraft } from './composerRecovery';
import { clearSubmittedComposerDraft, persistDraft, readPersistedDraft, restoredDraft, type ComposerDraftState } from './XuenessWorkbenchView';

const draft = (text: string): ComposerDraftState => ({ text, goal: false, attachments: [], selectedCapabilities: [],
  selectedContext: { files: [], sessions: [], skills: [], plugins: [] }, submissionError: '', attachmentError: '', revision: 2 });

test('late failure retains attachments and context beside newer typing; restoring swaps both drafts', () => {
  const submitted = { ...draft('first'), attachments: [{ name: 'a.txt', data: 'YQ==', mimeType: 'text/plain' }], goal: true,
    selectedContext: { files: ['a.txt'], sessions: [], skills: [], plugins: [] } };
  const result = retainRejectedComposerDraft(draft('new typing'), submitted, 'rejected');
  assert.equal(result.text, 'new typing');
  assert.deepEqual(result.recoverableDrafts?.[0].attachments, submitted.attachments);
  const restored = recoverComposerDraft(result, 0);
  assert.equal(restored.text, 'first');
  assert.equal(restored.goal, true);
  assert.equal(restored.recoverableDrafts?.[0].text, 'new typing');
  assert.equal(restored.recoverableDrafts?.[0].submissionError, '');
  const cleared = clearSubmittedComposerDraft(new Map([['one', restored]]), 'one', restored.revision).get('one')!;
  assert.equal(cleared.recoverableDrafts?.[0].text, 'new typing');
  assert.equal(recoverComposerDraft(cleared, 0).recoverableDrafts?.length, 0);
});

test('recovery text survives reload without storing attachment bytes or crossing workspace scopes', () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  const submitted = { ...draft('recover me'), attachments: [{ name: 'a', data: 'PRIVATE_ATTACHMENT_BYTES', mimeType: 'text/plain' }] };
  const current = retainRejectedComposerDraft(draft('current'), submitted, '');
  persistDraft('workspace-a', 'session-a', current, storage);
  assert.equal(readPersistedDraft('workspace-a', 'session-a', storage)?.recoverableDrafts?.[0].text, 'recover me');
  assert.equal(readPersistedDraft('workspace-a', 'session-a', storage)?.recoverableDrafts?.[0].hadAttachments, true);
  assert.equal(readPersistedDraft('workspace-b', 'session-a', storage), null);
  assert.doesNotMatch([...values.values()].join(''), /PRIVATE_ATTACHMENT_BYTES/);
});

test('reloading during acknowledgement keeps pending input as unconfirmed recovery beside newer typing', () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  const current = { ...draft('typed while sending'), pendingSubmission: { id: 'pending', draft: {
    ...draft('sent before reload'), attachments: [{ name: 'file.txt', data: 'UNSAVED_BYTES', mimeType: 'text/plain' }],
  } } };
  persistDraft('workspace', 'session', current, storage);
  const reloaded = restoredDraft(readPersistedDraft('workspace', 'session', storage)!);
  assert.equal(reloaded.text, 'typed while sending');
  assert.equal(reloaded.pendingSubmission, undefined);
  assert.equal(reloaded.recoverableDrafts?.[0].text, 'sent before reload');
  assert.equal(reloaded.recoverableDrafts?.[0].deliveryUnconfirmed, true);
  assert.equal(reloaded.recoverableDrafts?.[0].hadAttachments, true);
  assert.match(reloaded.recoverableDrafts?.[0].attachmentError ?? '', /附件|reattach/u);
  persistDraft('workspace', 'session', reloaded, storage);
  const again = restoredDraft(readPersistedDraft('workspace', 'session', storage)!);
  assert.equal(again.recoverableDrafts?.length, 1);
  assert.equal(again.recoverableDrafts?.[0].deliveryUnconfirmed, true);
  assert.doesNotMatch([...values.values()].join(''), /UNSAVED_BYTES/);
});

test('remounted composer receives late settlement from the same store; unsubscribed consumers do not', () => {
  const shared = {}, separate = {}; let old = 0, next = 0, other = 0;
  const dispose = subscribeComposerDrafts(shared, () => old++);
  notifyComposerDrafts(shared); dispose();
  const disposeNext = subscribeComposerDrafts(shared, () => next++);
  const disposeOther = subscribeComposerDrafts(separate, () => other++);
  notifyComposerDrafts(shared);
  assert.deepEqual([old, next, other], [1, 1, 0]);
  disposeNext(); disposeOther();
});

test('empty-state draft follows a workspace change and does not clobber text already stored there', () => {
  const store = new Map<string, { text: string; revision: number }>([
    ['default:new-task', { text: 'keep me', revision: 3 }],
  ]);
  assert.equal(relocateEmptyComposerDraft(store, 'default:new-task', '/work:new-task'), true);
  assert.deepEqual(store.get('/work:new-task'), { text: 'keep me', revision: 4 });
  store.set('/work:new-task', { text: 'already there', revision: 1 });
  store.set('default:new-task', { text: 'incoming', revision: 2 });
  assert.equal(relocateEmptyComposerDraft(store, 'default:new-task', '/work:new-task'), false);
  assert.equal(store.get('/work:new-task')?.text, 'already there');
  assert.equal(relocateEmptyComposerDraft(store, 'default:new-task', 'default:new-task'), false);
  assert.equal(store.get('default:new-task')?.revision, 2);
  assert.equal(relocateEmptyComposerDraft(new Map([['a', { text: '', revision: 1 }]]), 'a', 'b'), false);
});

const nontextDrafts: [string, Partial<ComposerDraftState>][] = [
  ['attachment', { attachments: [{ name: 'a.txt', data: 'YQ==', mimeType: 'text/plain' }] }],
  ['lost attachment marker', { hadAttachments: true }],
  ['goal', { goal: true }],
  ['capability', { selectedCapabilities: ['write'] }],
  ['context', { selectedContext: { files: ['a.txt'], sessions: [], skills: [], plugins: [] } }],
  ['structured mention', { editorState: { version: 1, nodes: [{ type: 'mention', kind: 'file', id: 'a.txt', label: 'a.txt' }] } }],
  ['recovery', { recoverableDrafts: [draft('recover me')] }],
  ['pending submission', { pendingSubmission: { id: 'pending', draft: draft('sending') } }],
  ['unconfirmed delivery', { deliveryUnconfirmed: true }],
  ['submission error', { submissionError: 'failed' }],
  ['attachment error', { attachmentError: 'reattach' }],
];

for (const [label, content] of nontextDrafts) {
  test(`workspace migration preserves a ${label}-only target and its conflicting source`, () => {
    const source = draft('incoming');
    const target = { ...draft(''), ...content };
    const store = new Map([['from', source], ['to', target]]);
    assert.equal(relocateEmptyComposerDraft(store, 'from', 'to'), false);
    assert.equal(store.get('from'), source);
    assert.equal(store.get('to'), target);
  });

  if (content.pendingSubmission) continue;
  test(`workspace migration copies a ${label}-only source into an empty target without losing its state`, () => {
    const source = { ...draft(''), ...content };
    const store = new Map([['from', source], ['to', draft('')]]);
    assert.equal(relocateEmptyComposerDraft(store, 'from', 'to'), true);
    assert.deepEqual(store.get('to'), { ...source, revision: source.revision + 1 });
    assert.equal(store.get('from'), source);
    assert.equal(relocateEmptyComposerDraft(store, 'from', 'from'), false);
    assert.equal(relocateEmptyComposerDraft(store, 'from', 'to'), false);
  });
}


for (const text of ['', 'new input while sending']) {
  test(`workspace migration leaves a live send in its original scope (${text || 'empty editor'})`, () => {
    const source = { ...draft(text), pendingSubmission: { id: 'live-send', draft: draft('sending') } };
    const target = draft('');
    const store = new Map<string, ComposerDraftState>([['from', source], ['to', target]]);
    assert.equal(relocateEmptyComposerDraft(store, 'from', 'to'), false);
    assert.equal(store.get('from'), source);
    assert.equal(store.get('to'), target);
    assert.equal(relocateEmptyComposerDraft(store, 'from', 'unused'), false);
    assert.equal(store.has('unused'), false);
    // A late ACK releases only the original key, just as handleSend does.
    store.set('from', { ...source, pendingSubmission: undefined });
    assert.equal(store.get('to')?.pendingSubmission, undefined);
    assert.equal(store.get('from')?.text, text);
  });
}

for (const inRecovery of [false, true]) {
  test(`workspace-bound attachment refs stay in their original ${inRecovery ? 'recovery' : 'active'} draft`, () => {
    const attachment = { name: 'a.txt', data: '', mimeType: 'text/plain', ref: {
      id: 'a'.repeat(32), token: 'a'.repeat(32), name: 'a.txt', mimeType: 'text/plain', size: 1,
      origin: 'file' as const, source: 'upload' as const,
    } };
    const withRef = { ...draft('with attachment'), attachments: [attachment] };
    const source = inRecovery ? { ...draft('new input'), recoverableDrafts: [withRef] } : withRef;
    const target = draft('');
    const store = new Map<string, ComposerDraftState>([['from', source], ['to', target]]);
    assert.equal(relocateEmptyComposerDraft(store, 'from', 'to'), false);
    assert.equal(store.get('from'), source);
    assert.equal(store.get('to'), target);
  });
}
