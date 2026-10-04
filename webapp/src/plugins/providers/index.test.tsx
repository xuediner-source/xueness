import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ModelManager,
  ModelProviderNavigation,
  ProviderEditor,
  ProviderEmptyState,
  adjustedLightweightOutput,
  canAdoptProviderCompatibility,
  canTestProviderCompatibility,
  emptyProviderDraft,
  lightweightBudgetPreview,
  providerDraftFromSummary,
  providerDraftWithLocalEndpoint,
  providerSavePayload,
  validateProviderDraft,
} from './index';
import { adoptProviderCompatibility, testProviderCompatibility, testProviderConnection } from '../../xuenessApi';
import type { ProviderCompatibilityTest, ProviderConnectionTest, ProviderSummary } from '../../xuenessApi';

const provider = (overrides: Partial<ProviderSummary> = {}): ProviderSummary => ({
  id: 'local-openai',
  name: 'Local OpenAI',
  baseUrl: 'https://api.example.test/v1',
  model: 'gpt-test',
  hasKey: true,
  protocol: 'openai',
  capabilities: ['image'],
  reasoningLevels: ['low', 'high'],
  ...overrides,
});

test('public-summary draft never includes a previously saved API key', () => {
  const summary = { ...provider(), apiKey: 'private-test-secret' } as ProviderSummary & { apiKey: string };
  const draft = providerDraftFromSummary(summary);
  assert.equal(draft.apiKey, '');
  assert.equal('apiKey' in draft, true);
  assert.deepEqual(draft.capabilities, ['image']);
});

test('draft validation matches server ID and HTTP(S) endpoint constraints', () => {
  const draft = { ...emptyProviderDraft(), id: 'valid-id_2.test', name: 'Provider', model: 'model-x', baseUrl: 'https://example.test/v1' };
  assert.equal(validateProviderDraft(draft), null);
  assert.match(validateProviderDraft({ ...draft, id: 'unsafe/name' }) ?? '', /配置 ID/);
  assert.match(validateProviderDraft({ ...draft, baseUrl: 'file:///tmp/key' }) ?? '', /HTTP 或 HTTPS/);
  assert.match(validateProviderDraft({ ...draft, baseUrl: 'not-a-url' }) ?? '', /有效的 API 地址/);
});

test('save payload omits blank keys and Anthropic reasoning, but sends a deliberately entered key', () => {
  const draft = { ...emptyProviderDraft(), id: 'p', name: 'P', baseUrl: 'https://example.test', model: 'm', reasoningLevels: ['low'] };
  const withoutKey = providerSavePayload(draft);
  assert.equal('apiKey' in withoutKey, false);
  assert.deepEqual(withoutKey.reasoningLevels, ['low']);
  const anthropic = providerSavePayload({ ...draft, protocol: 'anthropic', apiKey: 'user-entered-secret' });
  assert.equal(anthropic.apiKey, 'user-entered-secret');
  assert.equal('reasoningLevels' in anthropic, false);
});

test('runtime metadata round-trips compatibility options without echoing the saved key', () => {
  const summary = provider({
    runtimeProfile: 'lightweight', contextWindow: 8192, maxOutputTokens: 1024, toolCalling: 'json',
    compatibility: { streamUsage: false, parallelToolCalls: false, maxTokensField: 'max_completion_tokens', toolChoice: 'required', think: false },
  });
  const draft = providerDraftFromSummary(summary);
  const payload = providerSavePayload(draft);
  assert.equal(draft.apiKey, '');
  assert.equal(validateProviderDraft(draft), null);
  assert.deepEqual(payload.compatibility, {
    streamUsage: false, parallelToolCalls: false, maxTokensField: 'max_completion_tokens', toolChoice: 'required', think: false,
  });
  assert.equal(payload.runtimeProfile, 'lightweight');
  assert.equal(payload.contextWindow, 8192);
  assert.equal(payload.maxOutputTokens, 1024);
  assert.equal(payload.toolCalling, 'json');
  assert.equal('apiKey' in payload, false);
});

test('lightweight options round-trip exactly, empty object resets defaults, and Anthropic omits sampling controls', () => {
  const lightweight = provider({
    runtimeProfile: 'lightweight', contextWindow: 8192, maxOutputTokens: 1024,
    lightweightOptions: {
      reserveTokens: 256, optionalContextChars: 1500, toolResultChars: 1800, initialTools: 'minimal',
      maxDiscoveredTools: 4, toolSearchResults: 2, resultPageChars: 900, fileReadChars: 3200,
      overflowRetry: false, overflowRetryRatio: 0.55, jsonRepairAttempts: 1, stepLimit: 18,
      wallTimeSeconds: 90, requestTimeoutSeconds: 45, transportRetries: 2, temperature: 0.2, topP: 0.85, seed: 7,
    },
  });
  const draft = providerDraftFromSummary(lightweight);
  assert.deepEqual(providerSavePayload(draft).lightweightOptions, lightweight.lightweightOptions);
  assert.deepEqual(providerSavePayload({ ...draft, lightweightOptions: {} }).lightweightOptions, {});
  assert.deepEqual(providerSavePayload({ ...draft, protocol: 'anthropic' }).lightweightOptions, {
    reserveTokens: 256, optionalContextChars: 1500, toolResultChars: 1800, initialTools: 'minimal',
    maxDiscoveredTools: 4, toolSearchResults: 2, resultPageChars: 900, fileReadChars: 3200,
    overflowRetry: false, overflowRetryRatio: 0.55, jsonRepairAttempts: 1, stepLimit: 18, wallTimeSeconds: 90,
    requestTimeoutSeconds: 45, transportRetries: 2,
  });
  assert.deepEqual(providerSavePayload({ ...emptyProviderDraft(), runtimeProfile: 'lightweight' }).lightweightOptions, {});
});

test('lightweight validation enforces server ranges and the 256-token input floor', () => {
  const valid = { ...emptyProviderDraft(), id: 'p', name: 'P', baseUrl: 'http://127.0.0.1:11434/v1', model: 'm', runtimeProfile: 'lightweight' as const, contextWindow: 8192, maxOutputTokens: 1024, lightweightOptions: { reserveTokens: 512, jsonRepairAttempts: 1 } };
  assert.equal(validateProviderDraft(valid), null);
  assert.match(validateProviderDraft({ ...valid, lightweightOptions: { ...valid.lightweightOptions, maxDiscoveredTools: 13 } }) ?? '', /maxDiscoveredTools/);
  assert.match(validateProviderDraft({ ...valid, lightweightOptions: { requestTimeoutSeconds: 0 } }) ?? '', /requestTimeoutSeconds/);
  assert.match(validateProviderDraft({ ...valid, lightweightOptions: { requestTimeoutSeconds: 301 } }) ?? '', /requestTimeoutSeconds/);
  assert.match(validateProviderDraft({ ...valid, lightweightOptions: { transportRetries: -1 } }) ?? '', /transportRetries/);
  assert.match(validateProviderDraft({ ...valid, lightweightOptions: { transportRetries: 3 } }) ?? '', /transportRetries/);
  assert.equal(validateProviderDraft({ ...valid, lightweightOptions: { requestTimeoutSeconds: 1, transportRetries: 0 } }), null);
  assert.equal(validateProviderDraft({ ...valid, lightweightOptions: { requestTimeoutSeconds: 300, transportRetries: 2 } }), null);
  const tight = { ...valid, contextWindow: 2048, maxOutputTokens: 1024, lightweightOptions: { reserveTokens: 800 } };
  assert.equal(lightweightBudgetPreview(tight).inputTokens, 224);
  assert.match(validateProviderDraft(tight) ?? '', /至少需要保留 256/);
});

test('legacy standard provider save shape stays unchanged and lightweight defaults are explicit', () => {
  const draft = { ...emptyProviderDraft(), id: 'p', name: 'P', baseUrl: 'http://127.0.0.1:11434/v1', model: 'user-model' };
  const legacy = providerSavePayload(draft);
  assert.equal('runtimeProfile' in legacy, false);
  assert.equal('contextWindow' in legacy, false);
  assert.equal('maxOutputTokens' in legacy, false);
  const lightweight = providerSavePayload({ ...draft, runtimeProfile: 'lightweight' });
  assert.equal(lightweight.runtimeProfile, 'lightweight');
  assert.equal(lightweight.contextWindow, 8192);
  assert.equal(lightweight.maxOutputTokens, 1024);
  assert.equal(lightweight.toolCalling, 'native');
  assert.equal(lightweight.model, 'user-model');
  assert.deepEqual(lightweight.lightweightOptions, {});
});

test('local endpoint template selects lightweight mode without inventing a model or replacing credentials', () => {
  const draft = { ...emptyProviderDraft(), model: '', apiKey: 'keep-this-key', protocol: 'anthropic' as const };
  const selected = providerDraftWithLocalEndpoint(draft, 'http://127.0.0.1:11434/v1');
  assert.equal(selected.baseUrl, 'http://127.0.0.1:11434/v1');
  assert.equal(selected.protocol, 'openai');
  assert.equal(selected.runtimeProfile, 'lightweight');
  assert.equal(selected.contextWindow, 8192);
  assert.equal(selected.maxOutputTokens, 1024);
  assert.equal(selected.model, '');
  assert.equal(selected.apiKey, 'keep-this-key');
});

test('runtime validation restricts JSON mode and enforces local model budgets', () => {
  const draft = { ...emptyProviderDraft(), id: 'p', name: 'P', baseUrl: 'http://127.0.0.1:1234/v1', model: 'model-x' };
  assert.match(validateProviderDraft({ ...draft, toolCalling: 'json' }) ?? '', /本地轻量/);
  assert.match(validateProviderDraft({ ...draft, runtimeProfile: 'lightweight', protocol: 'anthropic', toolCalling: 'json' }) ?? '', /OpenAI-compatible/);
  assert.match(validateProviderDraft({ ...draft, contextWindow: 1024 }) ?? '', /2048–262144/);
  assert.match(validateProviderDraft({ ...draft, runtimeProfile: 'lightweight', contextWindow: 2048, maxOutputTokens: 1100 }) ?? '', /一半/);
  assert.equal(validateProviderDraft({ ...draft, runtimeProfile: 'lightweight', contextWindow: 8192, maxOutputTokens: 1024, toolCalling: 'json' }), null);
  assert.equal(adjustedLightweightOutput(2048, 1024), 512);
  assert.equal(adjustedLightweightOutput(4096, 640), 640);
  assert.equal(adjustedLightweightOutput(undefined, 640), 640);
});

test('navigation shows only the actual environment choice and API profiles', () => {
  const html = renderToStaticMarkup(<ModelProviderNavigation
    providers={[provider()]}
    selectedKey="local-openai"
    loading={false}
    busy={false}
    onSelect={() => undefined}
    onAdd={() => undefined}
  />);
  assert.match(html, /环境模型/);
  assert.match(html, /Local OpenAI/);
  assert.match(html, /gpt-test/);
  assert.match(html, /aria-current="page"/);
  assert.doesNotMatch(html, /Z.ai|BigModel|OpenAI account|登录/);
});

test('provider editor uses a blank password field and exposes only supported profile fields', () => {
  const summary = { ...provider(), apiKey: 'private-test-secret' } as ProviderSummary & { apiKey: string };
  const html = renderToStaticMarkup(<ProviderEditor
    draft={providerDraftFromSummary(summary)}
    original={summary}
    hasKey
    busy={false}
    testing={false}
    testResult={{ ok: true, provider: { id: summary.id, name: summary.name, model: summary.model, protocol: 'openai' }, latencyMs: 42 }}
    testError=""
    deleting={false}
    onDraftChange={() => undefined}
    onSave={() => undefined}
    onUse={() => undefined}
    onTest={() => undefined}
    onDelete={() => undefined}
    onCancelDelete={() => undefined}
    onCancelEdit={() => undefined}
  />);
  assert.match(html, /data-testid="model-provider-editor"/);
  assert.match(html, /type="password"[^>]*value=""/);
  assert.match(html, /已配置密钥/);
  assert.match(html, /OpenAI-compatible/);
  assert.match(html, /OpenAI-compatible/);
  assert.match(html, /支持的附件类型/);
  assert.match(html, /支持的推理等级/);
  assert.match(html, /data-testid="provider-runtime-settings"/);
  assert.match(html, /上下文窗口（tokens）/);
  assert.match(html, /最大输出（tokens）/);
  assert.match(html, /Ollama/);
  assert.match(html, /LM Studio/);
  assert.match(html, /不会填写模型名称或发送请求/);
  assert.match(html, /测试对话/);
  assert.match(html, /对话测试成功，响应时间 42 ms（未验证工具）/);
  assert.match(html, /可能收取少量费用/);
  assert.doesNotMatch(html, /private-test-secret/);
});

test('Anthropic editor hides OpenAI-only reasoning settings', () => {
  const summary = provider({ protocol: 'anthropic', reasoningLevels: undefined });
  const html = renderToStaticMarkup(<ProviderEditor
    draft={{ ...providerDraftFromSummary(summary), protocol: 'anthropic', reasoningLevels: [] }}
    original={summary}
    hasKey={false}
    busy={false}
    testing={false}
    testResult={null}
    testError=""
    deleting={false}
    onDraftChange={() => undefined}
    onSave={() => undefined}
    onUse={() => undefined}
    onTest={() => undefined}
    onDelete={() => undefined}
    onCancelDelete={() => undefined}
    onCancelEdit={() => undefined}
  />);
  assert.match(html, /当前 API 不接受 Anthropic 推理等级声明/);
  assert.doesNotMatch(html, /支持的推理等级/);
});

test('model discovery UI shows only returned IDs, requires a saved clean OpenAI profile, and edits the draft only', () => {
  const summary = provider();
  const savedDraft = providerDraftFromSummary(summary);
  const html = renderToStaticMarkup(<ProviderEditor
    draft={savedDraft}
    original={summary}
    hasKey
    busy={false}
    testing={false}
    testResult={null}
    testError=""
    discovering={false}
    discoveredModels={[{ id: 'server-model-a', created: 1760000000, ownedBy: 'upstream' }]}
    discoveryError=""
    deleting={false}
    onDraftChange={() => undefined}
    onSave={() => undefined}
    onUse={() => undefined}
    onTest={() => undefined}
    onDiscover={() => undefined}
    onSelectDiscoveredModel={() => undefined}
    onDelete={() => undefined}
    onCancelDelete={() => undefined}
    onCancelEdit={() => undefined}
  />);
  assert.match(html, /data-testid="provider-model-discovery"/);
  assert.match(html, /server-model-a/);
  assert.match(html, /upstream/);
  assert.doesNotMatch(html, /gpt-4o|claude-3|gpt-4.1/);
  assert.match(html, /只读取已保存配置的模型列表/);

  const dirtyHtml = renderToStaticMarkup(<ProviderEditor
    draft={{ ...savedDraft, name: 'unsaved name' }}
    original={summary}
    hasKey
    busy={false}
    testing={false}
    testResult={null}
    testError=""
    deleting={false}
    onDraftChange={() => undefined}
    onSave={() => undefined}
    onUse={() => undefined}
    onTest={() => undefined}
    onDelete={() => undefined}
    onCancelDelete={() => undefined}
    onCancelEdit={() => undefined}
  />);
  assert.match(dirtyHtml, /当前更改尚未保存/);
  assert.match(dirtyHtml, /<button[^>]*disabled=""[^>]*>.*?发现模型/s);

  const anthropic = provider({ protocol: 'anthropic', runtimeProfile: 'lightweight', baseUrl: 'http://127.0.0.1:11434/v1' });
  const anthropicHtml = renderToStaticMarkup(<ProviderEditor
    draft={providerDraftFromSummary(anthropic)}
    original={anthropic}
    hasKey
    busy={false}
    testing={false}
    testResult={null}
    testError=""
    deleting={false}
    onDraftChange={() => undefined}
    onSave={() => undefined}
    onUse={() => undefined}
    onTest={() => undefined}
    onDelete={() => undefined}
    onCancelDelete={() => undefined}
    onCancelEdit={() => undefined}
  />);
  assert.match(anthropicHtml, /模型发现暂不支持 Anthropic 配置/);
  assert.doesNotMatch(anthropicHtml, /本地 127\.0\.0\.1 或 ::1 服务可将密钥留空/);
});

test('lightweight advanced UI exposes four bounded groups, budget preview, and compatibility defaults controls', () => {
  const summary = provider({
    runtimeProfile: 'lightweight', contextWindow: 8192, maxOutputTokens: 1024,
    lightweightOptions: {}, compatibility: { streamUsage: false, parallelToolCalls: true, maxTokensField: 'max_completion_tokens' },
  });
  const html = renderToStaticMarkup(<ProviderEditor
    draft={providerDraftFromSummary(summary)}
    original={summary}
    hasKey
    busy={false}
    testing={false}
    testResult={null}
    testError=""
    deleting={false}
    onDraftChange={() => undefined}
    onSave={() => undefined}
    onUse={() => undefined}
    onTest={() => undefined}
    onDelete={() => undefined}
    onCancelDelete={() => undefined}
    onCancelEdit={() => undefined}
  />);
  assert.match(html, /data-testid="provider-lightweight-advanced"/);
  assert.match(html, /上下文与预算/);
  assert.match(html, /工具与文件结果/);
  assert.match(html, /恢复与运行上限/);
  assert.match(html, /采样参数/);
  assert.match(html, /估算输入预算/);
  assert.match(html, /temperature/);
  const inputFor = (label: string) => html.match(new RegExp(`<input\\b[^>]*aria-label="${label}"[^>]*>`))?.[0] ?? '';
  assert.match(inputFor('temperature'), /inputMode="decimal"[^>]*step="any"/);
  assert.match(inputFor('top_p'), /min="0"[^>]*step="any"/);
  assert.match(inputFor('溢出后上下文缩减比例'), /step="any"/);
  assert.match(inputFor('最大执行步数'), /inputMode="numeric"[^>]*step="1"/);
  assert.match(html, /parallel_tool_calls/);
  assert.match(html, /max_completion_tokens/);
  assert.match(html, /恢复 API 兼容默认/);
  assert.match(html, /单次请求总截止时间/);
  assert.match(html, /无输出时的传输重试次数/);
  assert.match(html, /协作式运行时长/);
  assert.match(html, /绝不重放请求/);
  assert.doesNotMatch(html, /xn-runtime-monitor/);
});

test('connection-test API method uses CSRF and sends only the profile ID', async () => {
  const originalFetch = globalThis.fetch;
  const calls: { url: string; init?: RequestInit }[] = [];
  const result: ProviderConnectionTest = {
    ok: true,
    provider: { id: 'local-openai', name: 'Local OpenAI', model: 'gpt-test', protocol: 'openai' },
    latencyMs: 17,
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === '/api/csrf') return new Response(JSON.stringify({ csrfToken: 'csrf-fixture' }), { status: 200 });
    return new Response(JSON.stringify(result), { status: 200 });
  }) as typeof fetch;
  try {
    assert.deepEqual(await testProviderConnection('local-openai'), result);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(calls[0].url, '/api/csrf');
  assert.equal(calls[1].url, '/api/providers/test');
  assert.equal(calls[1].init?.method, 'POST');
  assert.equal(new Headers(calls[1].init?.headers).get('X-CSRF-Token'), 'csrf-fixture');
  assert.deepEqual(JSON.parse(String(calls[1].init?.body)), { id: 'local-openai' });
});

test('compatibility diagnostics send only the saved ID, selected mode and candidate options', async () => {
  const originalFetch = globalThis.fetch;
  const calls: { url: string; init?: RequestInit }[] = [];
  const result: ProviderCompatibilityTest = {
    ok: true,
    provider: { id: 'local-openai', name: 'Local OpenAI', model: 'gpt-test', protocol: 'openai' },
    latencyMs: 21,
    optionsHash: 'a'.repeat(64),
    testedAt: '2026-10-01T00:00:00Z',
    providerCompatibilityDiagnostics: [],
    details: { mode: 'native_tool_call', requestCount: 1, toolCallValidated: true },
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === '/api/csrf') return new Response(JSON.stringify({ csrfToken: 'csrf-fixture' }), { status: 200 });
    return new Response(JSON.stringify(result), { status: 200 });
  }) as typeof fetch;
  try {
    assert.deepEqual(await testProviderCompatibility('local-openai', 'native_tool_call', {
      toolChoice: 'required', parallelToolCalls: false, think: false,
    }), result);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(calls[1].url, '/api/providers/compatibility-test');
  assert.equal(calls[1].init?.method, 'POST');
  assert.equal(new Headers(calls[1].init?.headers).get('X-CSRF-Token'), 'csrf-fixture');
  assert.deepEqual(JSON.parse(String(calls[1].init?.body)), {
    id: 'local-openai', mode: 'native_tool_call',
    compatibility: { toolChoice: 'required', parallelToolCalls: false, think: false },
  });
});

test('compatibility diagnostics require an unchanged saved connection and never save candidates', () => {
  const original = provider();
  const saved = providerDraftFromSummary(original);
  assert.equal(canTestProviderCompatibility(saved, original), true);
  assert.equal(canTestProviderCompatibility({ ...saved, compatibility: { think: false } }, original), true);
  assert.equal(canTestProviderCompatibility({ ...saved, baseUrl: 'https://changed.example.test/v1' }, original), false);
  assert.equal(canTestProviderCompatibility({ ...saved, model: 'unsaved-model' }, original), false);
  assert.equal(canTestProviderCompatibility({ ...saved, apiKey: 'new-key' }, original), false);

  const candidate = { toolChoice: 'required' as const, think: false };
  const checks = [
    { mode: 'conversation' as const, ok: true, testedAt: '2026-10-01T00:00:00Z', requestCount: 1 },
    { mode: 'stream' as const, ok: true, testedAt: '2026-10-01T00:00:01Z', requestCount: 1 },
    { mode: 'tool_roundtrip' as const, ok: true, testedAt: '2026-10-01T00:00:02Z', requestCount: 2 },
  ];
  const tested = { ...original, compatibilityDiagnostics: [{ optionsHash: 'b'.repeat(64), compatibility: candidate, checks }] };
  assert.equal(canAdoptProviderCompatibility({ ...saved, compatibility: candidate }, tested), true);
  assert.equal(canAdoptProviderCompatibility({ ...saved, compatibility: candidate }, {
    ...tested, compatibilityDiagnostics: [{ ...tested.compatibilityDiagnostics![0], checks: checks.slice(0, 2) }],
  }), false);
  const jsonOriginal = provider({ runtimeProfile: 'lightweight', contextWindow: 8192,
    maxOutputTokens: 1024, toolCalling: 'json' });
  const jsonSaved = providerDraftFromSummary(jsonOriginal);
  const jsonTested = { ...jsonOriginal, compatibilityDiagnostics: [{
    optionsHash: 'd'.repeat(64), compatibility: candidate,
    checks: [checks[0], checks[1], { ...checks[2], mode: 'json_tool_call' as const }],
  }] };
  assert.equal(canAdoptProviderCompatibility({ ...jsonSaved, compatibility: candidate }, jsonTested), true);

  const html = renderToStaticMarkup(<ProviderEditor
    draft={{ ...saved, compatibility: { toolChoice: 'required', think: false } }}
    original={original}
    hasKey
    busy={false}
    testing={false}
    testResult={null}
    testError=""
    compatibilityMode="tool_roundtrip"
    compatibilityTestReady
    compatibilityAdoptionReady
    compatibilityHistory={checks}
    compatibilityGroups={tested.compatibilityDiagnostics}
    compatibilityResult={{
      ok: true,
      provider: { id: original.id, name: original.name, model: original.model, protocol: 'openai' },
      latencyMs: 32,
      optionsHash: 'b'.repeat(64),
      testedAt: '2026-10-01T00:00:02Z',
      providerCompatibilityDiagnostics: tested.compatibilityDiagnostics,
      details: { mode: 'tool_roundtrip', requestCount: 2, toolCallValidated: true,
        toolResultFollowupValidated: true, fixture: 'in-process arithmetic only; no file or command execution' },
    }}
    deleting={false}
    onDraftChange={() => undefined}
    onSave={() => undefined}
    onUse={() => undefined}
    onTest={() => undefined}
    onCompatibilityTest={() => undefined}
    onAdoptCompatibility={() => undefined}
    onLoadCompatibilityCandidate={() => undefined}
    onDelete={() => undefined}
    onCancelDelete={() => undefined}
    onCancelEdit={() => undefined}
  />);
  assert.match(html, /data-testid="provider-compatibility-diagnostics"/);
  assert.match(html, /工具结果续轮（native，两次请求）/);
  assert.match(html, /data-testid="provider-check-tool_roundtrip"/);
  assert.match(html, /data-testid="provider-adopt-verified-compatibility"/);
  assert.match(html, /data-testid="provider-compatibility-history"/);
  assert.match(html, /data-testid="provider-compatibility-candidate-history"/);
  assert.match(html, /载入这组已测试参数到草稿/);
  assert.match(html, /实际请求 2 次/);
  assert.match(html, /不访问文件或命令/);
  assert.match(html, /think/);
  assert.match(html, /省略此字段/);
});

test('compatibility adoption API posts only profile id and the verified options hash', async () => {
  const originalFetch = globalThis.fetch;
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === '/api/csrf') return new Response(JSON.stringify({ csrfToken: 'csrf-fixture' }), { status: 200 });
    return new Response(JSON.stringify({ provider: provider({ compatibility: { think: false } }) }), { status: 200 });
  }) as typeof fetch;
  try {
    await adoptProviderCompatibility('local-openai', 'c'.repeat(64));
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(calls[1].url, '/api/providers/compatibility-adopt');
  assert.equal(new Headers(calls[1].init?.headers).get('X-CSRF-Token'), 'csrf-fixture');
  assert.deepEqual(JSON.parse(String(calls[1].init?.body)), {
    id: 'local-openai', optionsHash: 'c'.repeat(64),
  });
});

test('settings initially offers the server environment profile without disclosing environment details', () => {
  const html = renderToStaticMarkup(<ModelManager onSelect={() => undefined} />);
  assert.match(html, /data-model-provider-split-panel="true"/);
  assert.match(html, /data-testid="model-provider-environment-detail"/);
  assert.match(html, /使用服务器环境中的默认模型配置/);
  assert.match(html, /环境变量和密钥不会在浏览器中读取或显示/);
  assert.doesNotMatch(html, /apiKey|OPENAI_API_KEY|private-test-secret/);
});

test('split panel follows the upstream 224px desktop and 36rem detail dimensions', async () => {
  const css = await readFile(resolve(process.cwd(), 'src/styles/model-parity.css'), 'utf8');
  assert.match(css, /grid-template-columns:\s*224px minmax\(0, 1fr\)/);
  assert.match(css, /min-height:\s*36rem/);
  assert.match(css, /grid-template-columns:\s*56px minmax\(0, 1fr\)/);
});

test('an empty custom model list offers adding one without a dead relative docs link', () => {
  const html = renderToStaticMarkup(<ProviderEmptyState onAdd={() => undefined} />);
  assert.match(html, /data-testid="xn-settings-empty"/);
  assert.match(html, /<p class="xn-settings-empty__title">还没有自定义模型配置<\/p>/);
  assert.match(html, /<button type="button" class="xn-btn xn-btn--primary xn-btn--md">添加配置<\/button>/);
  // 工作台由本地 loopback 服务提供，相对 docs/ 路径并不存在，故不渲染文档链接。
  assert.doesNotMatch(html, /xn-settings-empty__link/);
  assert.match(renderToStaticMarkup(<ProviderEmptyState onAdd={() => undefined} busy />), /disabled="">添加配置/);
});

test('the model list empty state appears only after the catalog resolves as empty', async () => {
  const source = await readFile(resolve(process.cwd(), 'src/plugins/providers/index.tsx'), 'utf8');
  assert.match(source, /!loading && items\.length === 0 && <ProviderEmptyState/);
  assert.doesNotMatch(renderToStaticMarkup(<ModelManager onSelect={() => undefined} />), /xn-settings-empty/);
});
