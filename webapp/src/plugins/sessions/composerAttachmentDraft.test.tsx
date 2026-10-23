import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { Composer, persistDraft, readPersistedDraft, restoredDraft, type ComposerDraftState } from './XuenessWorkbenchView';
import { attachmentOwnerMatches, composerReferenceIsOwned, reconcileComposerUploads, replacementComposerDraftIdentity, hasUnscopedComposerAttachments } from './composerAttachmentDraft';
import { setComposerAttachmentLifecycleEnabled } from './composerAttachmentLifecycle';
import { getComposerAttachmentUploadStore } from './composerAttachmentUploadStore';
const ref = { id: 'a'.repeat(32), token: 'a'.repeat(32), name: 'a.png', size: 10, origin: 'file' as const, mimeType: 'image/png' };
const attachment = { name: ref.name, mimeType: ref.mimeType, data: '', ref };
const draft = (id: string): ComposerDraftState => ({ draftId: id, text: 'hello', attachments: [], goal: false,
  selectedContext: { files: [], sessions: [], skills: [], plugins: [] }, attachmentError: '', submissionError: '', revision: 0 });
test('upload settlement updates only its canonical draft, including recovery after editor swap', () => {
  const current = { ...draft('new'), recoverableDrafts: [draft('old')] };
  const next = reconcileComposerUploads(current, 'old', [attachment], true);
  assert.equal(next.attachments.length, 0);
  assert.deepEqual(next.recoverableDrafts?.[0].attachments, [attachment]);
  assert.equal(next.recoverableDrafts?.[0].hadAttachments, true);
});
test('pending and recovered references prevent disposal by a new owner', () => {
  const current = { ...draft('new'), pendingSubmission: { id: 'ticket', draft: { ...draft('old'), attachments: [attachment] } } };
  assert.equal(composerReferenceIsOwned([current], ref.id), true);
  assert.equal(composerReferenceIsOwned([{ ...draft('new'), recoverableDrafts: [{ ...draft('old'), attachments: [attachment] }] }], ref.id), true);
  assert.equal(composerReferenceIsOwned([draft('new')], ref.id), false);
});
test('session promotion never reinterprets root-owned attachment references', () => {
  const owner = { root: '/workspace', draftId: 'canonical' };
  assert.equal(attachmentOwnerMatches(owner, '/workspace'), true);
  assert.equal(attachmentOwnerMatches(owner, '/workspace', 'promoted'), false);
});
test('reference-only persistence retains unfinished marker alongside ready files and canonical ownership', () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  const original = { ...draft('canonical'), attachments: [attachment], hadAttachments: true,
    attachmentOwner: { root: '/workspace', draftId: 'canonical' } };
  persistDraft('workspace', 'draft', original, storage);
  const restored = restoredDraft(readPersistedDraft('workspace', 'draft', storage)!);
  assert.equal(restored.hadAttachments, true);
  assert.deepEqual(restored.attachmentOwner, original.attachmentOwner);
  assert.equal(restored.draftId, 'canonical');
  assert.equal(restored.attachments[0].data, '');
  assert.match(restored.attachmentError, /重新|reattach/);
  assert.doesNotMatch([...values.values()].join(''), /"data"|blob:|"file"\s*:/);
});
test('unfinished upload chips block sending and expose cancellation before completion', () => {
  const id = crypto.randomUUID();
  const store = getComposerAttachmentUploadStore({ root: '/workspace', draftKey: id });
  store.setContext({ enabled: true, generation: 'binding' });
  store.enqueue([new File(['hello'], 'a.txt', { type: 'text/plain' })]);
  store.setContext({ enabled: false, generation: 'binding' });
  const state = { ...draft(id), attachmentOwner: { root: '/workspace', draftId: id }, hadAttachments: true };
  const html = renderToStaticMarkup(<Composer richComposer attachmentRoot="/workspace" draftKey="one" workspaceKey="workspace"
    draftStore={{ current: new Map([['workspace:one', state]]) }} />);
  assert.match(html, /data-upload-state="failed"/);
  assert.match(html, /Retry upload|重试附件/);
  assert.match(html, /<button[^>]*type="submit"[^>]*disabled/);
});

test('shell disable fences retained managers and late reference disposal without cleanup requests', () => {
  const store = getComposerAttachmentUploadStore({ root: '/workspace', draftKey: crypto.randomUUID() });
  store.setContext({ enabled: true, generation: 'binding' });
  assert.equal(store.isEnabled(), true);
  setComposerAttachmentLifecycleEnabled(false);
  assert.equal(store.isEnabled(), false);
});

test('withdrawal replacement rotates identity and cannot overwrite recovered attachment ownership', () => {
  const old = { ...draft('old'), attachments: [attachment], hadAttachments: true, attachmentOwner: { root: '/workspace', draftId: 'old' } };
  const replacement = { ...old, ...replacementComposerDraftIdentity(false), attachments: [], recoverableDrafts: [old] };
  assert.notEqual(replacement.draftId, old.draftId);
  assert.equal(replacement.attachmentOwner, undefined);
  assert.equal(replacement.hadAttachments, false);
  const next = reconcileComposerUploads(replacement, 'old', [attachment], false);
  assert.equal(next.attachments.length, 0);
  assert.deepEqual(next.recoverableDrafts?.[0].attachments, [attachment]);
});

test('legacy recovered committed refs without authoritative scope must remain recoverable', () => {
  const legacy = restoredDraft({ text: 'legacy recovery', attachmentRefs: [ref] });
  assert.equal(hasUnscopedComposerAttachments(legacy), true);
  assert.equal(hasUnscopedComposerAttachments({ ...legacy, attachmentOwner: { root: '/workspace', draftId: 'known' } }), false);
  assert.equal(hasUnscopedComposerAttachments(draft('empty')), false);
});
