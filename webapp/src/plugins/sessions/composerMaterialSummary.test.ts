import test from 'node:test';
import assert from 'node:assert/strict';
import { composerInputForDraft, composerMaterialsForDraft } from './composerMaterialSummary';

const draft = {
  attachments: [
    { name: 'notes.txt', mimeType: 'text/plain', data: '', ref: { id: 'a'.repeat(32), token: 'a'.repeat(32), name: 'notes.txt', mimeType: 'text/plain', size: 12, origin: 'file' as const, source: 'upload' as const } },
    { name: 'inline.md', mimeType: 'text/markdown', data: 'aW5saW5l' },
  ],
  selectedContext: { files: ['src/app.ts'], sessions: ['session-one'], skills: [], plugins: [] },
  selectedCapabilities: ['office.compose'],
  goal: false,
  hadAttachments: false,
};

test('composer material list is derived from the exact input payload, including committed references and inline data', () => {
  const input = composerInputForDraft(draft, true);
  assert.deepEqual(input.attachmentRefs, [{ id: 'a'.repeat(32) }]);
  assert.deepEqual(input.attachments, [{ name: 'inline.md', mimeType: 'text/markdown', data: 'aW5saW5l' }]);
  assert.deepEqual(input.files, ['src/app.ts']);
  assert.deepEqual(input.sessions, ['session-one']);
  assert.deepEqual(input.capabilities, ['office.compose']);

  const materials = composerMaterialsForDraft(draft, true, {
    mentions: [
      { id: 'src/app.ts', label: 'src/app.ts', kind: 'file' },
      { id: 'session-one', label: 'Build notes', kind: 'session' },
    ],
    capabilities: [{ id: 'office.compose', pluginId: 'office', available: true, label: '文档编写', labelEn: 'Document authoring', description: '', descriptionEn: '' }],
    attachmentsEnabled: true,
  });
  assert.deepEqual(materials.map(item => [item.kind, item.label, item.state]), [
    ['attachment', 'notes.txt', 'included'], ['attachment', 'inline.md', 'included'],
    ['file', 'src/app.ts', 'included'], ['session', 'Build notes', 'included'], ['capability', '文档编写', 'included'],
  ]);
  assert.doesNotMatch(JSON.stringify(materials), /aW5saW5l/);
});

test('failed uploads and unresolved attachment references are visibly excluded from the payload', () => {
  const materials = composerMaterialsForDraft({ ...draft, attachments: [{ name: 'broken.txt', mimeType: 'text/plain', data: '' }] }, true, {
    mentions: [], capabilities: [], attachmentsEnabled: true,
    uploads: [{ id: 'upload-1', name: 'failed.txt', mimeType: 'text/plain', size: 8, origin: 'file', state: 'failed', uploadedBytes: 0, progress: 0, error: 'offline' }],
  });
  assert.deepEqual(composerInputForDraft({ ...draft, attachments: [{ name: 'broken.txt', mimeType: 'text/plain', data: '' }] }, true).attachments, []);
  assert.deepEqual(materials.filter(item => item.kind === 'attachment').map(item => [item.label, item.state]), [
    ['broken.txt', 'not-ready'], ['failed.txt', 'not-ready'],
  ]);
  assert.match(materials.find(item => item.label === 'failed.txt')?.note ?? '', /不会随本条消息发送/);
  assert.equal(materials.find(item => item.id === 'file:src/app.ts')?.state, 'included');
  assert.match(materials.find(item => item.id === 'file:src/app.ts')?.note ?? '', /仍会按已保存的引用提交/);
});

test('current workspace mismatch makes attachment scope explicit without altering the submitted payload', () => {
  const input = composerInputForDraft(draft, true);
  const materials = composerMaterialsForDraft(draft, true, { mentions: [], capabilities: [], ownerMismatch: true });
  assert.equal(input.attachmentRefs?.[0]?.id, 'a'.repeat(32));
  assert.equal(materials[0].state, 'unavailable');
  assert.match(materials[0].note ?? '', /原工作区或会话/);
  assert.equal(materials[1].state, 'unavailable');
});

test('a completed upload that is not selected is not mislabeled as unavailable or submitted', () => {
  const materials = composerMaterialsForDraft({ ...draft, attachments: [], selectedCapabilities: [],
    selectedContext: { files: [], sessions: [], skills: [], plugins: [] } }, true, {
    mentions: [], capabilities: [], attachmentsEnabled: true,
    uploads: [{ id: 'upload-ready', name: 'ready.pdf', mimeType: 'application/pdf', size: 8, origin: 'file', state: 'ready', uploadedBytes: 8, progress: 100 }],
  });
  assert.deepEqual(materials.map(item => [item.label, item.state, item.note]), [
    ['ready.pdf', 'not-selected', '附件已就绪，但还没有加入本条消息。'],
  ]);
});
