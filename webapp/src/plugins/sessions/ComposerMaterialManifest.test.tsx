import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { ComposerMaterialManifest } from './ComposerMaterialManifest';

test('material manifest states what enters the payload and which pending material is excluded', () => {
  const html = renderToStaticMarkup(<ComposerMaterialManifest materials={[
    { id: 'file:readme', kind: 'file', label: 'README.md', state: 'included' },
    { id: 'session:one', kind: 'session', label: 'Build notes', state: 'included' },
    { id: 'skill:review', kind: 'skill', label: 'Review', state: 'included' },
    { id: 'plugin:office', kind: 'plugin', label: 'Office', state: 'included' },
    { id: 'upload:ready', kind: 'attachment', label: 'ready.pdf', state: 'not-selected', note: '附件已就绪，但还没有加入本条消息。' },
    { id: 'upload:bad', kind: 'attachment', label: 'broken.pdf', state: 'not-ready', note: '附件上传失败，不会随本条消息发送。' },
  ]} />);
  assert.match(html, /本条消息材料/);
  assert.match(html, /4 项会随消息提交/);
  assert.match(html, /2 项不会随本条消息提交/);
  assert.match(html, /README\.md/);
  assert.match(html, /文件 · README\.md/);
  assert.match(html, /会话 · Build notes/);
  assert.match(html, /技能 · Review/);
  assert.match(html, /插件 · Office/);
  assert.doesNotMatch(html, />file ·/);
  assert.doesNotMatch(html, />session ·/);
  assert.doesNotMatch(html, />skill ·/);
  assert.doesNotMatch(html, />plugin ·/);
  assert.match(html, /broken\.pdf/);
  assert.match(html, /data-material-state="not-selected"/);
  assert.match(html, /尚未加入本条消息/);
  assert.match(html, /data-material-state="not-ready"/);
  assert.match(html, /附件上传失败，不会随本条消息发送/);
});
