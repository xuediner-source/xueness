import test from 'node:test';
import assert from 'node:assert/strict';
import { retainRejectedComposerDraft, recoverComposerDraft, subscribeComposerDrafts, notifyComposerDrafts } from './composerRecovery';
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
