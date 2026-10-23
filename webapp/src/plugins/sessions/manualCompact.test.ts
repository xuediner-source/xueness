import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { manualCompactNotice, normalizeCompactInstructions, parseCompactCommand, readCompactReply, requestManualCompact } from './manualCompact';
import type { ComposerInput } from '../../xuenessComposer';

const empty: ComposerInput = { attachments: [], files: [], sessions: [], skills: [], plugins: [], goal: false };

test('/compact is recognized with or without instructions', () => {
  assert.deepEqual(parseCompactCommand('/compact'), { instructions: null });
  assert.deepEqual(parseCompactCommand('  /compact   ', empty), { instructions: null });
  assert.deepEqual(parseCompactCommand('/compact keep the API decisions', empty), { instructions: 'keep the API decisions' });
  // The route refuses control characters, so line breaks become spaces.
  assert.deepEqual(parseCompactCommand('/compact keep\n  the tests\n\tand todos', empty), { instructions: 'keep the tests and todos' });
});

test('other text, other commands and messages with attachments are ordinary messages', () => {
  assert.equal(parseCompactCommand('/compactx'), null);
  assert.equal(parseCompactCommand('/compacted notes'), null);
  assert.equal(parseCompactCommand('please /compact'), null);
  assert.equal(parseCompactCommand('/goal compact'), null);
  assert.equal(parseCompactCommand('/compact', { ...empty, attachments: [{ name: 'a.png', mimeType: 'image/png', data: '' }] }), null);
  assert.equal(parseCompactCommand('/compact', { ...empty, attachmentRefs: [{ id: 'a1' }] }), null);
  assert.equal(parseCompactCommand('/compact', { ...empty, files: ['src/a.ts'] }), null);
  assert.equal(parseCompactCommand('/compact', { ...empty, goal: true }), null);
  assert.equal(normalizeCompactInstructions('   '), null);
});

test('compact replies map to compacted, skipped and failed outcomes', () => {
  assert.deepEqual(readCompactReply(200, { ok: true, kind: 'zcode', compacted: true, before: { estimatedTokens: 181234, messages: 40 }, after: { estimatedTokens: 4200, messages: 2 }, summarizedMessageCount: 38 }),
    { kind: 'compacted', beforeTokens: 181234, afterTokens: 4200, summarized: 38 });
  assert.deepEqual(readCompactReply(200, { ok: true, compacted: false, reason: 'nothing_to_compact' }), { kind: 'skipped' });
  assert.deepEqual(readCompactReply(200, { ok: true, compacted: false, withinBudget: true }), { kind: 'skipped' });
  assert.deepEqual(readCompactReply(409, { error: '请先停止运行，再压缩上下文。', reason: 'run_in_progress' }), { kind: 'failed', message: '请先停止运行，再压缩上下文。', running: true });
  assert.deepEqual(readCompactReply(409, { ok: false, status: 409, refusal: { reason: 'session_busy', detail: '会话正在被写入' } }), { kind: 'failed', message: '会话正在被写入', running: true });
  assert.deepEqual(readCompactReply(502, { ok: false, status: 502, refusal: { reason: 'compaction_failed', detail: 'Failed to generate compact summary' } }),
    { kind: 'failed', message: 'Failed to generate compact summary', running: false });
  assert.deepEqual(readCompactReply(500, null), { kind: 'failed', message: 'HTTP 500', running: false });
});

test('notices use the ZCode texts', () => {
  assert.equal(manualCompactNotice({ kind: 'skipped' }), '上下文已是最新，无需压缩');
  assert.equal(manualCompactNotice({ kind: 'compacted', beforeTokens: 181234, afterTokens: 4200, summarized: 38 }), '对话已压缩：约 181,234 → 4,200 token');
  assert.equal(manualCompactNotice({ kind: 'compacted', beforeTokens: null, afterTokens: null, summarized: null }), '对话已压缩。');
  assert.equal(manualCompactNotice({ kind: 'failed', message: 'boom', running: false }), '上下文压缩失败：boom');
  assert.equal(manualCompactNotice({ kind: 'failed', message: 'x', running: true }), '请先停止运行，再压缩上下文。');
});

test('the request posts only the instructions key to the compact route', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string) => { calls.push({ url }); return new Response(JSON.stringify({ csrfToken: 't0' }), { status: 200 }); }) as typeof fetch;
  try {
    const fetcher = (async (url: string, init?: RequestInit) => { calls.push({ url, init }); return new Response(JSON.stringify({ ok: true, compacted: false, reason: 'nothing_to_compact' }), { status: 200 }); }) as typeof fetch;
    assert.deepEqual(await requestManualCompact('abc', 'keep tests', fetcher), { kind: 'skipped' });
    assert.deepEqual(await requestManualCompact('abc', null, fetcher), { kind: 'skipped' });
  } finally { globalThis.fetch = original; }
  const posts = calls.filter((call) => call.init);
  assert.equal(posts[0]!.url, '/api/sessions/abc/compact');
  assert.equal(posts[0]!.init!.method, 'POST');
  assert.equal((posts[0]!.init!.headers as Record<string, string>)['X-CSRF-Token'], 't0');
  assert.equal(posts[0]!.init!.body, JSON.stringify({ instructions: 'keep tests' }));
  assert.equal(posts[1]!.init!.body, '{}');
});

test('the composer sends /compact to the compact route before any run starts', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/XuenessWorkbenchContainer.tsx'), 'utf8');
  const start = source.indexOf('const handleSend = useCallback(');
  const body = source.slice(start, source.indexOf('const moveTextIntoComposer', start));
  const intercept = body.indexOf('parseCompactCommand(text, input)');
  assert.ok(intercept > 0);
  assert.ok(intercept < body.indexOf('sendTurn('));
  assert.ok(intercept < body.indexOf('queueTurn('));
  assert.ok(intercept < body.indexOf('guideCurrentTurn('));
  assert.match(body.slice(intercept, body.indexOf('const proof')), /if \(running\) throw new Error\(tr\('请先停止运行，再压缩上下文。'\)\)/);
});
