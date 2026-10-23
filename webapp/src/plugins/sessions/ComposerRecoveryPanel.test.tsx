import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { ComposerRecoveryPanel } from './ComposerRecoveryPanel';
import type { RecoverableComposerDraft } from './composerRecovery';

test('recovery panel names preserved materials and marks references that need checking', () => {
  const draft = {
    text: 'continue the report',
    attachments: [{
      name: 'report.pdf', mimeType: 'application/pdf', data: '',
      ref: { id: 'a'.repeat(32), token: 'a'.repeat(32), name: 'report.pdf', mimeType: 'application/pdf', size: 32, origin: 'file', source: 'upload' },
    }, { name: 'draft-image.png', mimeType: 'image/png', data: '' }],
    selectedContext: { files: ['src/main.ts'], sessions: ['session-1'], skills: ['review'], plugins: ['editor'], capabilities: [] },
    selectedCapabilities: ['office.compose'], goal: false, submissionError: '', attachmentError: '', revision: 1,
  } as unknown as RecoverableComposerDraft;
  const html = renderToStaticMarkup(<ComposerRecoveryPanel drafts={[draft]} onRestore={() => {}} onDiscard={() => {}}
    references={[
      { id: 'src/main.ts', kind: 'file', label: 'src/main.ts' },
      { id: 'session-1', kind: 'session', label: 'Planning notes' },
      { id: 'review', kind: 'skill', label: 'Review changes' },
      { id: 'editor', kind: 'plugin', label: 'Editor tools' },
    ]}
    capabilities={[{ id: 'office.compose', pluginId: 'office', available: false, label: '文档编写', labelEn: 'Document authoring', description: '', descriptionEn: '' }]}
    attachmentState={() => 'available'} />);

  assert.match(html, /continue the report/);
  assert.match(html, /report\.pdf/);
  assert.match(html, /引用已保留，发送前会检查可用性/);
  assert.match(html, /draft-image\.png/);
  assert.match(html, /附件内容未保留，请重新添加/);
  assert.match(html, /src\/main\.ts/);
  assert.match(html, /文件 · src\/main\.ts/);
  assert.match(html, /Planning notes/);
  assert.match(html, /Review changes/);
  assert.match(html, /Editor tools/);
  assert.match(html, /文档编写/);
  assert.match(html, /当前能力不可用；恢复时会保留原选择/);
  assert.match(html, /恢复会把当前输入另存为一条草稿，不会发送消息/);
  assert.equal((html.match(/data-testid="composer-recovery-reference"/g) ?? []).length, 7);
});
