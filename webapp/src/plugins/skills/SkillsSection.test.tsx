import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { CapabilitySection } from '../../XuenessCapabilitiesPanel';
import { fileSkillItem, SkillsSection, uploadSkillFolder } from './SkillsSection';

function selected(path: string, content: Uint8Array): File {
  const file = new File([content as BlobPart], path.split('/').at(-1)!);
  Object.defineProperty(file, 'webkitRelativePath', { value: path }); return file;
}

test('folder upload sends selected bytes in bounded chunks and commits only kept files', async () => {
  const previous = globalThis.fetch;
  const raw = new Uint8Array(900_001).map((_, index) => index % 251);
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input), body = init?.body ? JSON.parse(String(init.body)) : {};
    if (url === '/api/csrf') return Response.json({ csrfToken: 'folder-test' });
    calls.push({ url, body });
    if (url.endsWith('/imports')) return Response.json({ token: 'folder-token', files: ['chosen/assets/icon.bin'], limits: { chunkBytes: 384 * 1024 } });
    if (url.endsWith('/commit')) return Response.json({ imported: [{ name: 'folder-demo', description: 'A fixture' }], files: 1 });
    assert(String(init?.body).length < 1_000_000);
    return Response.json({ written: Number(body.offset) + Buffer.from(String(body.content), 'base64').length });
  };
  try {
    let token = ''; const progress: string[] = [];
    const result = await uploadSkillFolder([selected('chosen/assets/icon.bin', raw), selected('chosen/README.md', new Uint8Array([0]))], new AbortController().signal, text => progress.push(text), value => { token = value; });
    const chunks = calls.filter(call => Object.hasOwn(call.body, 'content'));
    assert.equal(chunks.length, 3);
    assert.deepEqual(chunks.map(call => call.body.offset), [0, 393216, 786432]);
    assert.deepEqual(Buffer.concat(chunks.map(call => Buffer.from(String(call.body.content), 'base64'))), Buffer.from(raw));
    assert.equal(calls.at(-1)?.url, '/api/resources/skills/imports/folder-token/commit');
    assert.equal(result.imported[0]?.name, 'folder-demo'); assert.equal(token, 'folder-token'); assert(progress.length > 0);
  } finally { globalThis.fetch = previous; }
});

test('cancellation stops before another file chunk or commit', async () => {
  const previous = globalThis.fetch, controller = new AbortController(); const calls: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input); calls.push(url);
    if (url === '/api/csrf') return Response.json({ csrfToken: 'folder-test' });
    if (url.endsWith('/imports')) return Response.json({ token: 'cancel-token', files: ['one/SKILL.md'], limits: { chunkBytes: 2 } });
    controller.abort(); return Response.json({ written: 2 });
  };
  try {
    await assert.rejects(uploadSkillFolder([selected('one/SKILL.md', new Uint8Array(8))], controller.signal, () => {}, () => {}), { name: 'AbortError' });
    assert.equal(calls.filter(url => url.endsWith('/cancel-token')).length, 1);
    assert.equal(calls.some(url => url.endsWith('/commit')), false);
  } finally { globalThis.fetch = previous; }
});

test('folder skills have independent switches, keep content read-only and only imported copies are removable', () => {
  const imported = fileSkillItem({ id: 'user:folder-demo', name: 'folder-demo', description: 'A folder skill', source: 'user', imported: true });
  const manual = fileSkillItem({ id: 'user:manual', name: 'manual', description: 'A manual folder', source: 'user' });
  const html = renderToStaticMarkup(<CapabilitySection kind="skills" label="技能" items={[imported, manual]} onEdit={() => {}} onToggle={() => {}} onDelete={() => {}} />);
  assert.match(html, /folder-demo/); assert.equal((html.match(/role="switch"/g) ?? []).length, 2); assert.doesNotMatch(html, /xn-cap-edit-skills/);
  assert.match(html, /xn-cap-delete-skills-user:folder-demo/); assert.doesNotMatch(html, /xn-cap-delete-skills-user:manual/);
  const section = renderToStaticMarkup(<SkillsSection kind="skills" label="技能" items={[]} onCreate={() => {}} />);
  assert.match(section, /从文件夹添加/); assert.match(section, /webkitdirectory/); assert.match(section, /新建/);
});
