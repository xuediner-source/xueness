import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
const root = await mkdtemp(join(tmpdir(), 'xueness-subscription-tests-'));
process.env.XUENESS_SUBSCRIPTIONS_STORE = root;
process.env.COMMAND_CODE_API_KEY = 'fixture-commandcode-key';
process.env.QODER_ACCESS_TOKEN = 'dt-fixture'; process.env.QODER_USER_ID = 'fixture-user';
const base = new URL('../xueness/bundled_plugins/subscriptions/', import.meta.url).href;
const protocol = await import(base + 'protocols.mjs'), safety = await import(base + 'vendor/auth/safety.mjs');
const hub = await import(base + 'vendor/hub.mjs'), worker = await import(base + 'worker.mjs');
const compat = await import(base + 'compat.mjs');
const future = Date.now() + 3_600_000;
await safety.writePrivateJson(join(root, 'auth.json'), {
  codex: { accessToken: 'fake-codex', refreshToken: 'fake-refresh', expiresAt: future, accountId: 'fake-account' },
  claude: { accessToken: 'fake-claude', refreshToken: 'fake-refresh', expiresAt: future },
  grok: { accessToken: 'fake-grok', refreshToken: 'fake-refresh', expiresAt: future },
  antigravity: { accessToken: 'fake-google', refreshToken: 'fake-refresh', expiresAt: future, projectId: 'fake-project', projectsByEndpoint: { 'https://daily-cloudcode-pa.googleapis.com': 'fake-project', 'https://cloudcode-pa.googleapis.com': 'fake-project' } },
  qwen: { accessToken: 'fake-qwen', refreshToken: 'fake-refresh', expiresAt: future },
  openrouter: { accessToken: 'fake-openrouter' },
  agnes: { accessToken: 'fake-agnes' },
  spark: { accessToken: 'fake-spark', refreshToken: 'fake-refresh', expiresAt: future },
  ernie: { accessToken: 'fake-ernie', refreshToken: 'fake-refresh', expiresAt: future },
});
await safety.writePrivateJson(join(root, 'connections.json'), { commandcode: { apiKey: 'fake-commandcode', credentialSource: 'cli-login' }, qoder: { accessToken: 'dt-fake', userId: 'fake-user' } });
const signal = () => AbortSignal.timeout(8000);
const encode = events => events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join('');
const response = (events, type = 'text/event-stream') => new Response(encode(events), { headers: { 'content-type': type } });
const data = model => ({ model, messages: [{ role: 'system', content: 'fixture instructions' }, { role: 'user', content: 'fixture prompt' }], tools: [] });
after(() => worker.dispose());

test('subscription failures retain safe categories and HTTP status without response bodies', () => {
  assert.deepEqual(worker.errorMetadata(new compat.LlmError('PRIVATE body', 'AUTH', { status: 401 })), { category: 'authentication_failed', status: 401 });
  assert.deepEqual(worker.errorMetadata({ code: 'RATE_LIMIT', status: 429, message: 'PRIVATE body' }), { category: 'rate_limited', status: 429 });
  assert.deepEqual(worker.errorMetadata({ code: 'QUOTA_EXCEEDED', status: 429 }), { category: 'quota_exhausted', status: 429 });
  assert.deepEqual(worker.errorMetadata(new Error('Upstream generation failed (HTTP 400)')), { category: 'request_rejected', status: 400 });
  assert.equal(worker.errorMetadata(new Error('Upstream stream ended before completion')).category, 'invalid_response');
});

test('Antigravity tool follow-up preserves the actual thought signature and conversation thread', async () => {
  const sessionId = 'fixture-thread', signature = 'opaque-fixture-signature'; let count = 0;
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(init.body).request;
    assert.equal(request.sessionId, sessionId);
    if (count++ === 0) return response([{ response: { candidates: [{ content: { parts: [{ functionCall: { name: 'read', args: { path: 'fixture' } }, thoughtSignature: signature }] }, finishReason: 'STOP' }] } }]);
    const call = request.contents.flatMap(content => content.parts).find(part => part.functionCall);
    assert.equal(call.thoughtSignature, signature);
    const result = request.contents.flatMap(content => content.parts).find(part => part.functionResponse);
    assert.equal(result.functionResponse.name, 'read');
    return response([{ response: { candidates: [{ content: { parts: [{ text: 'finished' }] }, finishReason: 'STOP' }] } }]);
  };
  const options = { ...data('gemini-3.1-pro-high'), sessionId, tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }] };
  const first = await worker.handle('generate', 'antigravity', options, signal(), () => {});
  assert.equal(first.tool_calls.length, 1);
  const messages = [...options.messages, { role: 'assistant', content: first.content, tool_calls: first.tool_calls }, { role: 'tool', tool_call_id: first.tool_calls[0].id, content: 'fixture result' }];
  const next = await worker.handle('generate', 'antigravity', { ...options, messages }, signal(), () => {});
  assert.equal(next.content, 'finished'); assert.equal(count, 2);
});

test('SSE handles split UTF-8, multiline data, CRLF and a final unterminated frame', async () => {
  const bytes = new TextEncoder().encode('event: item\r\ndata: 第一行\r\ndata: 第二行\r\n\r\ndata: [DONE]');
  const stream = new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close(); } });
  const frames = []; for await (const frame of protocol.parseFrames(stream)) frames.push(frame);
  assert.deepEqual(frames, [{ event: 'item', data: '第一行\n第二行' }, { data: '[DONE]' }]);
});

test('Antigravity adapts strict JSON schemas and parameterless functions before sending', async () => {
  const original = { type: 'object', additionalProperties: false, $schema: 'https://json-schema.org/draft/2020-12/schema',
    $defs: { target: { type: ['string', 'null'], description: 'Target', const: 'fixture' } },
    properties: { target: { $ref: '#/$defs/target' }, nested: { type: 'object', additionalProperties: false,
      properties: { count: { type: 'integer', minimum: 0 } }, required: ['count'] } }, required: ['target'] };
  const snapshot = JSON.stringify(original);
  globalThis.fetch = async (_url, init) => {
    const declarations = JSON.parse(init.body).request.tools[0].functionDeclarations;
    assert.deepEqual(declarations[0].parameters, { type: 'OBJECT', properties: {
      target: { type: 'STRING', nullable: true, description: 'Target', enum: ['fixture'] },
      nested: { type: 'OBJECT', properties: { count: { type: 'INTEGER', minimum: 0 } }, required: ['count'] },
    }, required: ['target'] });
    assert.equal(Object.hasOwn(declarations[1], 'parameters'), false);
    return response([{ response: { candidates: [{ content: { parts: [{ text: 'answer' }] }, finishReason: 'STOP' }] } }]);
  };
  const result = await worker.handle('generate', 'antigravity', { ...data('gemini-3.8-flash-high'), tools: [
    { type: 'function', function: { name: 'fixture', parameters: original } },
    { type: 'function', function: { name: 'read_state', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } } },
  ] }, signal(), () => {});
  assert.equal(result.content, 'answer'); assert.equal(JSON.stringify(original), snapshot);
});

test('Gemini schema references fail locally instead of sending malformed or cyclic declarations', () => {
  assert.throws(() => protocol.toGeminiTools([{ name: 'fixture', parameters: { $ref: 'https://example.invalid/schema' } }]), /schema reference/);
  assert.throws(() => protocol.toGeminiTools([{ name: 'fixture', parameters: { $defs: { x: { $ref: '#/$defs/x' } }, $ref: '#/$defs/x' } }]), /schema reference/);
});
test('unknown token measurements stay absent and cache counts are not double-counted', () => {
  assert.equal(protocol.normalizeUsage({}), undefined);
  assert.deepEqual(protocol.normalizeUsage({ inputTokens: 8, outputTokens: 2, cacheReadTokens: 4 }, 'native'), { input_tokens: 8, output_tokens: 2, cache_read_input_tokens: 4, prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 });
});
test('stream interruption fails rather than reporting a completed response', () => {
  const reply = new protocol.Reply(); reply.push({ type: 'text-delta', text: 'partial' });
  assert.throws(() => reply.result(), /before completion/);
});
test('OpenAI fragments preserve multi-tool identities and model metadata', () => {
  const reply = new protocol.Reply();
  for (const event of [{ model: 'wire-model', choices: [{ delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'toolA', arguments: '{"x":' } }, { index: 1, id: 'b', function: { name: 'toolB', arguments: '{}' } }] } }] }, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] }, finish_reason: 'tool_calls' }] }]) for (const chunk of protocol.openAIChunks(event)) reply.push(chunk);
  const result = reply.result(); assert.equal(result.tool_calls.length, 2); assert.equal(result.tool_calls[0].function.arguments, '{"x":1}'); assert.deepEqual(result._response_models, ['wire-model']);
});
test('Command Code streamed input and final tool event assemble exactly once', () => {
  const reply = new protocol.Reply(), calls = new Map();
  for (const event of [{ type: 'tool-input-start', id: 'id', toolName: 'read' }, { type: 'tool-input-delta', id: 'id', delta: '{"path":"a"}' }, { type: 'tool-call', toolCallId: 'id', toolName: 'read', input: { path: 'a' } }, { type: 'finish', finishReason: 'tool-calls' }]) for (const chunk of protocol.commandCodeChunks(event, calls)) reply.push(chunk);
  const result = reply.result(); assert.equal(result.tool_calls.length, 1); assert.equal(result.tool_calls[0].function.name, 'read'); assert.equal(result.tool_calls[0].function.arguments, '{"path":"a"}');
});
test('Command Code tool results use its SDK wire grammar instead of OpenAI blocks', () => {
  const messages = protocol.toCommandCodeMessages([{ role: 'assistant', content: '', tool_calls: [{ id: 'id', function: { name: 'read', arguments: '{"path":"a"}' } }] }, { role: 'tool', tool_call_id: 'id', content: 'result' }]);
  assert.equal(messages[0].content[0].toolCallId, 'id'); assert.equal(messages[1].role, 'tool'); assert.equal(messages[1].content[0].toolName, 'read'); assert.deepEqual(messages[1].content[0].output, { type: 'text', value: 'result' });
});

for (const id of ['codex', 'grok']) test(`${id} Responses transport preserves model, usage, instructions and finish`, async () => {
  let body;
  globalThis.fetch = async (url, init) => { assert.match(String(url), id === 'codex' ? /chatgpt\.com\/backend-api\/codex\/responses/ : /api\.x\.ai\/v1\/responses/); body = JSON.parse(init.body); return response([
    { type: 'response.output_text.delta', item_id: 'item', content_index: 0, delta: 'answer' },
    { type: 'response.completed', response: { status: 'completed', model: 'reported', usage: { input_tokens: 12, output_tokens: 3 } } },
  ]); };
  const result = await worker.handle('generate', id, data(id === 'codex' ? 'gpt-5.4' : 'grok-4'), signal(), () => {});
  assert.equal(result.content, 'answer'); assert.equal(result._usage.total_tokens, 15); assert.deepEqual(result._response_models, ['reported']); assert.match(body.instructions, /fixture instructions/);
});
test('Claude subscription transport retains reported ID and streamed reasoning', async () => {
  globalThis.fetch = async (url, init) => { assert.match(String(url), /api\.anthropic\.com\/v1\/messages/); assert.match(init.headers.authorization, /fake-claude/); return response([
    { type: 'message_start', message: { model: 'claude-reported', usage: { input_tokens: 12, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'answer' } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }, { type: 'message_stop' },
  ]); };
  const result = await worker.handle('generate', 'claude', data('claude-sonnet-4-6'), signal(), () => {});
  assert.equal(result.content, 'answer'); assert.deepEqual(result._response_models, ['claude-reported']); assert.equal(result._usage.total_tokens, 15);
});
test('Antigravity transport unwraps Gemini modelVersion and reported usage', async () => {
  globalThis.fetch = async url => { assert.match(String(url), /googleapis\.com/); return response([{ response: { modelVersion: 'gemini-reported', candidates: [{ content: { parts: [{ text: 'answer' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 3 } } }]); };
  const result = await worker.handle('generate', 'antigravity', data('gemini-3.1-pro-high'), signal(), () => {});
  assert.equal(result.content, 'answer'); assert.deepEqual(result._response_models, ['gemini-reported']);
});
for (const id of ['qwen', 'agnes']) test(`${id} account OAuth transport uses the session token and proper messages`, async () => {
  globalThis.fetch = async (url, init) => { const body = JSON.parse(init.body); assert.equal(body.messages[1].content, 'fixture prompt'); assert.match(init.headers.authorization, new RegExp('fake-' + id)); return response([{ model: 'reported', choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }] }]); };
  const result = await worker.handle('generate', id, data('fixture-model'), signal(), () => {}); assert.equal(result.content, 'answer'); assert.deepEqual(result._response_models, ['reported']); assert.equal(result._usage, undefined);
});
test('Command Code uses alpha/generate and its own NDJSON protocol', async () => {
  globalThis.fetch = async (url, init) => { assert.match(String(url), /commandcode\.ai\/alpha\/generate/); const body = JSON.parse(init.body); assert.equal(body.params.model, 'meta/muse-spark-1.3-contributor'); assert.equal(body.params.messages[0].content[0].text, 'fixture prompt'); return new Response('{"type":"text-delta","text":"answer"}\n{"type":"finish","finishReason":"stop"}', { headers: { 'content-type': 'application/x-ndjson' } }); };
  const result = await worker.handle('generate', 'commandcode', data('cc/meta/muse-spark-1.3-contributor'), signal(), () => {}); assert.equal(result.content, 'answer');
});
test('Qoder signs the actual body and unwraps COSY response envelopes', async () => {
  globalThis.fetch = async (url, init) => { assert.match(String(url), /api3\.qoder\.sh/); assert.match(init.headers.Authorization, /^Bearer COSY\./); assert.ok(init.headers['Cosy-Key']); return response([{ body: JSON.stringify({ model: 'qwen-reported', choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }] }) }]); };
  const result = await worker.handle('generate', 'qoder', data('qwen3.8-flash'), signal(), () => {}); assert.equal(result.content, 'answer'); assert.deepEqual(result._response_models, ['qwen-reported']);
});
test('Command Code quota uses its imported login, and missing balances remain unknown', async () => {
  globalThis.fetch = async (url, init) => { assert.match(String(url), /commandcode\.ai/); assert.equal(init.headers.authorization, 'Bearer fake-commandcode'); return Response.json({ balance: 8 }); };
  const quota = await worker.handle('quota', 'commandcode', {}, signal()); assert.equal(quota.supported, true); assert.equal(quota.windows[0].remaining, 8);
  assert.equal(worker.normalizeQuota({ supported: true, windows: [{ kind: 'weekly' }] }).supported, false);
  assert.equal(worker.normalizeQuota({ supported: true, windows: [{ kind: 'weekly', usedPercent: 0 }] }).windows[0].usedPercent, 0);
});
test('Codex discovery captures only valid live IDs, reasoning and capabilities', async () => {
  globalThis.fetch = async () => Response.json({ models: [{ slug: 'actual-model', display_name: 'Actual', context_window: 400000, supported_reasoning_levels: [{ effort: 'high' }], visibility: 'list' }, { slug: 'hidden', visibility: 'hide' }] });
  const result = await worker.handle('models', 'codex', {}, signal()); assert.equal(result.models.length, 1); assert.equal(result.models[0].source, 'upstream'); assert.deepEqual(result.models[0].reasoningLevels, ['high']); assert.deepEqual(result.models[0].capabilities, ['image']);
});
test('Command Code imports only a fixed CLI login path, ignoring API key environment variables', async () => {
  const catalog = JSON.parse(await readFile(new URL('catalog.json', base), 'utf8')).providers;
  const imported = await worker.importAccount(catalog.find(item => item.id === 'commandcode'), signal(), async path => {
    assert.equal(path, join(homedir(), '.commandcode', 'auth.json'));
    return { apiKey: 'fixture-cli-login' };
  });
  assert.deepEqual(imported, { imported: true });
  const record = JSON.parse(await readFile(join(root, 'connections.json'), 'utf8'));
  assert.equal(record.commandcode.apiKey, 'fixture-cli-login'); assert.equal(record.commandcode.credentialSource, 'cli-login');
  assert.notEqual(record.commandcode.apiKey, process.env.COMMAND_CODE_API_KEY);
  await assert.rejects(worker.importAccount(catalog.find(item => item.id === 'commandcode'), signal(), async () => ({ apiKey: '' })), /CLI login not found/);
});
test('removed API and gateway IDs fail before reading credentials or contacting an upstream', async () => {
  let requests = 0; globalThis.fetch = async () => { requests++; throw new Error('Unexpected network request'); };
  for (const id of ['gateway', 'zcode', 'openai-api', 'custom-api', 'kimi-coding', 'openrouter', 'spark', 'ernie']) {
    for (const action of ['login', 'import', 'models', 'quota', 'generate', 'status']) await assert.rejects(worker.handle(action, id, {}, signal()), /Unknown subscription provider/);
  }
  assert.equal(requests, 0);
});
test('Qoder imports account credentials without consulting an external router database', async () => {
  assert.deepEqual(await worker.handle('import', 'qoder', {}, signal()), { imported: true });
  const record = JSON.parse(await readFile(join(root, 'connections.json'), 'utf8'));
  assert.equal(record.qoder.accessToken, 'dt-fixture'); assert.equal(record.qoder.userId, 'fixture-user');
});
test('auth saves and deletes preserve other accounts under concurrent writes', async () => {
  await Promise.all([hub.saveSession('openrouter', { accessToken: 'new-openrouter' }), hub.saveSession('agnes', { accessToken: 'new-agnes' }), hub.deleteSession('spark')]);
  const store = await hub.loadStore(); assert.equal(store.openrouter.accessToken, 'new-openrouter'); assert.equal(store.agnes.accessToken, 'new-agnes'); assert.equal(store.spark, undefined);
});
