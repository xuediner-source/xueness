import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { nativeToolPayload, safeNativeToolUrl, NATIVE_CARD_CHAR_LIMIT } from './nativeToolPayload';
import { NativeToolCallCard } from './NativeToolCallCard';
import { resolveToolRenderer, NATIVE_TOOL_IDENTITIES, type ToolRow } from './toolRenderers';
import { ZCodeConversation } from './ZCodeConversation';

const effective = new Set(['sessions', 'files', 'shell', 'browser', 'workflows', 'subagents']);
const row = (name: string, output: unknown = {}, input: Record<string, unknown> = {}): ToolRow => ({ kind: 'tool', seq: 1, turnId: 'turn-1', toolCallId: 'call-1', name, output, input, subject: JSON.stringify(input), status: 'ok', error: '', errorCode: '' });
const markup = (r: ToolRow, ids = effective) => renderToStaticMarkup(<ZCodeConversation rows={[r]} collapseTools={false} effectivePluginIds={ids} />);

test('all manifest native identities have exact dependency-aware cards; lookalikes do not', () => {
  for (const [kind, names] of Object.entries(NATIVE_TOOL_IDENTITIES)) for (const name of names) {
    const renderer = resolveToolRenderer(name, effective);
    assert.equal(renderer.id, kind, name);
    assert.match(markup(row(name)), new RegExp(`data-native-tool-card="${kind}"`));
    for (const missing of renderer.requiredPlugins) {
      const ids = new Set([...effective].filter(id => id !== missing));
      assert.equal(resolveToolRenderer(name, ids).id, 'fallback', `${name} without ${missing}`);
      assert.doesNotMatch(markup(row(name, { text: 'PRIVATE_OUTPUT' }, { prompt: 'PRIVATE_PROMPT' }), ids), /PRIVATE_|data-native-tool-card/);
    }
    for (const fake of [`${name}_fake`, `fake_${name}`, name.toUpperCase(), ` ${name}`]) assert.equal(resolveToolRenderer(fake, effective).id, 'fallback', fake);
  }
  for (const fake of ['file_read_secrets', 'file_edit_secrets', 'exec_remote', 'Task', 'workflow_status_v2']) assert.equal(resolveToolRenderer(fake).id, 'fallback');
});

test('native file cards render paths and exact grep lines, bounded results and real truncation', () => {
  assert.match(markup(row('grep', { pattern: 'needle', count: 1, output: [{ path: 'src/a.ts', line: 9, text: 'needle' }] })), /src\/a.ts:9  needle/);
  assert.match(markup(row('list', { path: '.', output: ['a.ts', 'b.ts'] })), /a.ts\nb.ts/);
  const short = nativeToolPayload('files', row('glob', { output: ['one'] }));
  assert.equal(short.truncated, false);
  const huge = nativeToolPayload('files', row('glob', { output: Array.from({length: 81}, (_, i) => i === 80 ? 'HIDDEN_TAIL' : 'x'.repeat(2000)) }));
  assert.equal(huge.truncated, true);
  assert.ok(huge.lines.join('').length <= NATIVE_CARD_CHAR_LIMIT);
  assert.doesNotMatch(JSON.stringify(huge), /HIDDEN_TAIL/);
  assert.equal(nativeToolPayload('files', row('glob', { output: ['one'], truncated: true })).truncated, true);
});

test('browser cards show page, safe URL and screenshot reference without network images or fill values', () => {
  const html = markup(row('browser_screenshot', { title: 'Page', url: 'https://example.com/page?token=SECRET#SECRET', mimeType: 'image/png', imageDataUrl: 'data:image/png;base64,SECRET' }, { text: 'PRIVATE_PASSWORD' }));
  assert.match(html, /https:\/\/example.com\/page/);
  assert.match(html, /PNG/);
  assert.doesNotMatch(html, /SECRET|PRIVATE_PASSWORD|<img|base64/);
  for (const url of ['javascript:alert(1)', 'data:image/png;base64,a', 'file:///etc/passwd', 'https://user:pass@example.com', 'https://example.com/\nsecret']) assert.equal(safeNativeToolUrl(url), undefined);
  assert.match(markup(row('browser_snapshot', {tree:'- button "Continue"',nodeCount:1,totalNodes:2,truncated:true})), /Continue/);
});

test('workflow cards use persisted statuses, actor kinds and questions, never prompt/string inference', () => {
  const output = { workflow: { id: 'run-1', status: 'awaiting_user', plan: {name:'Review', nodes:[{id:'a',kind:'agent',prompt:'PRIVATE_ACTOR_PROMPT'}, {id:'b',kind:'command'}]}, nodes: {a:{status:'awaiting_user',question:'Which branch?',transcript:'PRIVATE_TRANSCRIPT'},b:{status:'completed'}}}};
  const html = markup(row('workflow_status', output, {script:'PRIVATE_SCRIPT'}));
  assert.match(html, /run-1/); assert.match(html, /Which branch/); assert.match(html, /Actor 数<\/dt><dd>1/);
  assert.doesNotMatch(html, /PRIVATE_/);
  assert.doesNotMatch(markup(row('workflow_run', 'completed running 100%', { prompt: 'PRIVATE_PROMPT' })), /100%|completed|PRIVATE_/);
});

test('task launch return does not claim child completion and updated collection uses factual states', () => {
  const launch = row('task', {task_id:'task-one',background:true,status:'running',summary:'PRIVATE_SUMMARY',prompt:'PRIVATE_PROMPT'}, {prompt:'PRIVATE_PROMPT'});
  const html = markup(launch);
  assert.match(html, /running/); assert.doesNotMatch(html, /completed|PRIVATE_/);
  const collect = markup(row('task_collect', {tasks:[{id:'task-one',status:'completed',summary:'PRIVATE_CHILD_RESULT'}],pending:['task-two']}));
  assert.match(collect, /task-one · completed/); assert.match(collect, /task-two · pending/);
  assert.doesNotMatch(collect, /PRIVATE_CHILD_RESULT/);
  assert.match(markup({...launch,status:'running'}), /data-status="running"/);
  assert.match(markup({...launch,status:'error'}), /data-status="error"/);
  assert.doesNotMatch(markup({...launch,status:'error'}), /data-status="running"/);
});

test('malformed and cyclic payloads fail safe; unknown tools cannot expose raw private payload', () => {
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  for (const output of [null, 12, true, [], 'PRIVATE', cyclic, {output:[{}, null, 5],workflow:[]}]) {
    for (const kind of ['files','browser','workflow','task'] as const) assert.doesNotThrow(() => renderToStaticMarkup(<NativeToolCallCard kind={kind} row={row('test',output)} />));
  }
  assert.doesNotMatch(markup(row('unknown_tool', {prompt:'PRIVATE'}, {prompt:'PRIVATE'})), /PRIVATE/);
});

test('read metadata uses actual returned character range and preserves next page evidence', () => {
  const html = markup(row('read', {path:'a.txt',output:'abcd',offset:10,totalChars:100,nextOffset:14,truncated:true}));
  assert.match(html, /10–14/); assert.match(html, /下一页偏移<\/dt><dd>14/);
  assert.match(html, /总字符数<\/dt><dd>100/); assert.match(html, /abcd/);
  assert.doesNotMatch(markup(row('read', {output:'abcd',offset:20,totalChars:10})), /20–24/);
});

test('native read/edit/write/exec identities require exactly their actual owning plugins', () => {
  for (const [name, kind, owner] of [['read','read','files'],['edit','edit','files'],['write','edit','files'],['exec','exec','shell']]) {
    assert.equal(resolveToolRenderer(name, effective).id, kind);
    assert.equal(resolveToolRenderer(name, new Set(['sessions'])).id, 'fallback');
    assert.equal(resolveToolRenderer(name, new Set([owner])).id, 'fallback');
    assert.equal(resolveToolRenderer(`${name}_lookalike`, effective).id, 'fallback');
  }
});
