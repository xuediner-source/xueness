/** Trusted JSON-lines worker. Stores only this plugin's credentials. */
import { createInterface } from 'node:readline';
import { readFile, lstat, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { AsyncLocalStorage } from 'node:async_hooks';
import * as hub from './vendor/hub.mjs';
import { readPrivateJson, writePrivateJson } from './vendor/auth/safety.mjs';
import { commandCodeChat, COMMANDCODE_CREDITS_URL, COMMANDCODE_MODELS } from './vendor/commandcode.mjs';
import { qoderChat, qoderDirectModel, resolveQoderCredential, unwrapQoderEvent } from './vendor/qoder.mjs';
import { parseFrames, Reply, toNativeMessages, toCommandCodeMessages, toGeminiTools, openAIChunks, commandCodeChunks, finite } from './protocols.mjs';

const root = process.env.XUENESS_SUBSCRIPTIONS_STORE;
if (!root) throw new Error('Subscription store missing');
const catalog = JSON.parse(await readFile(new URL('./catalog.json', import.meta.url), 'utf8')).providers;
const nativeIds = new Set(catalog.filter(item => item.mode === 'oauth').map(item => item.id));
const requests = new Map(), context = new AsyncLocalStorage(), secretValues = new Set();
const originalFetch = globalThis.fetch.bind(globalThis);
// Redirects cannot forward account credentials to another host. Preserve the
// request cancellation signal through vendor adapters and header timeouts.
globalThis.fetch = async (url, init = {}) => {
  const caller = context.getStore()?.signal;
  const signals = [caller, init.signal, AbortSignal.timeout(context.getStore()?.generation ? 600_000 : 120_000)].filter(Boolean);
  const response = await originalFetch(url, { ...init, redirect: 'error', signal: AbortSignal.any(signals) });
  if (!response.body) return response;
  let size = 0; const limit = /event-stream|ndjson/i.test(response.headers.get('content-type') ?? '') ? 16_000_000 : 2_000_000;
  const body = response.body.pipeThrough(new TransformStream({ transform(chunk, controller) { size += chunk.byteLength; if (size > limit) throw new Error('Upstream response exceeds size limit'); controller.enqueue(chunk); } }));
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
};

function remember(record) { for (const [key, value] of Object.entries(record ?? {})) if (/token|key|secret|password/i.test(key) && typeof value === 'string') secretValues.add(value); return record; }
function safeError(error) {
  if (error instanceof SyntaxError) return 'Upstream or credential document contains invalid JSON';
  let detail = hub.safeDiagnostic(error);
  for (const secret of secretValues) if (secret.length >= 4) detail = detail.split(secret).join('[redacted]');
  // Provider response bodies are never emitted through this bridge.
  const status = error?.status ?? /(?:HTTP|status)\s*[:=]?\s*(\d{3})/i.exec(detail)?.[1];
  if (status) return `Upstream request failed (HTTP ${status})`;
  if (/\{[\s\S]*\}/.test(detail) || /accessToken|refreshToken|apiKey/i.test(detail)) return 'Upstream authentication or request failed';
  return detail.slice(0, 700);
}
function errorMetadata(error) {
  // Only bounded status/category crosses the bridge; never an upstream body.
  const statusValue = Number(error?.status ?? /(?:HTTP|status)\s*[:=]?\s*(\d{3})/i.exec(String(error?.message ?? ''))?.[1]);
  const status = Number.isInteger(statusValue) && statusValue >= 100 && statusValue <= 599 ? statusValue : undefined;
  const code = String(error?.code ?? '');
  const known = { AUTH: 'authentication_failed', INVALID_CREDENTIAL: 'authentication_failed', MISSING_CREDENTIAL: 'authentication_failed',
    RATE_LIMIT: 'rate_limited', TIMEOUT: 'timeout', NETWORK: 'connection_failed', SERVER: 'upstream_failure',
    QUOTA_EXCEEDED: 'quota_exhausted', UNSUPPORTED_REGION: 'unsupported_region', CONTEXT_WINDOW_EXCEEDED: 'context_overflow',
    MALFORMED_RESPONSE: 'invalid_response', EMPTY_RESPONSE: 'invalid_response' };
  let category = known[code];
  if (!category && status) category = status === 401 || status === 403 ? 'authentication_failed' : status === 429 ? 'rate_limited'
    : status === 408 || status === 504 ? 'timeout' : status === 404 ? 'endpoint_not_found' : status >= 500 ? 'upstream_failure' : 'request_rejected';
  if (!category) category = /timeout|timed out/i.test(String(error?.message ?? '')) ? 'timeout'
    : /invalid.*(?:JSON|stream|reply)|empty reply|incomplete tool call|before completion|size limit/i.test(String(error?.message ?? '')) ? 'invalid_response'
    : error instanceof TypeError && /fetch|network/i.test(String(error.message)) ? 'connection_failed' : 'request_failed';
  return { category, ...(status ? { status } : {}) };
}
function send(value) { const text = JSON.stringify(value); if (text.length > 8_000_000) throw new Error('Bridge response exceeds size limit'); process.stdout.write(text + '\n'); }
const file = name => join(root, name);
let writes = Promise.resolve();
function update(name, change, signal) {
  const task = writes.then(async () => { signal?.throwIfAborted(); const value = await readPrivateJson(file(name)); await change(value); signal?.throwIfAborted(); await writePrivateJson(file(name), value, signal); });
  writes = task.catch(() => {}); return task;
}
async function localJson(path) {
  // Import actions use fixed known client paths, never a path from the browser.
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile() || info.size > 2_000_000) throw new Error('Local credentials must be a bounded regular file');
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try { const current = await handle.stat(); if (info.ino !== current.ino || info.dev !== current.dev) throw new Error('Local credentials changed during import'); return JSON.parse(await handle.readFile('utf8')); }
  finally { await handle.close(); }
}
const refreshers = { codex: hub.refreshCodex, claude: hub.refreshClaude, grok: hub.refreshGrok, antigravity: hub.refreshAntigravity,
  qwen: hub.refreshQwen, agnes: hub.refreshAgnes };
const epochs = new Map();
const tokens = Object.fromEntries([...nativeIds].map(id => [id, new hub.TokenManager({
  displayName: id, preemptMs: 60_000, load: async () => remember(await hub.getSession(id)),
  save: value => hub.saveSession(id, remember(value)), remove: () => hub.deleteSession(id),
  refresh: async value => { const epoch = epochs.get(id); const refresh = refreshers[id]; if (!refresh) throw new Error('Sign in again to renew the account login'); const result = await refresh(value); if (epochs.get(id) !== epoch) throw new Error('Account disconnected during refresh'); return result; },
  isPermanent: error => /invalid_grant|revoked|expired refresh|unauthorized_client/i.test(String(error?.message)),
})]));
const classes = { codex: hub.CodexAdapter, claude: hub.ClaudeAdapter, grok: hub.GrokAdapter, antigravity: hub.AntigravityAdapter };
const adapters = Object.fromEntries(Object.entries(classes).map(([id, Adapter]) => [id, new Adapter({
  tokens: tokens[id], models: catalog.find(item => item.id === id).models.map(id => ({ id })),
  streamIdleTimeoutMs: 60_000, discovery: false, maxRetries: 0,
})]));
const auth = new hub.SubscriptionsAuthController(new hub.OAuthFlowManager(), new hub.DeviceFlowManager(), () => {}, () => undefined);

function validateUrl(value) {
  const url = new URL(value);
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || (!loopback && url.protocol !== 'https:') || (loopback && !['http:', 'https:'].includes(url.protocol))) throw new Error('Invalid account service URL');
  return url.toString().replace(/\/$/, '');
}
async function credentials(item) {
  if (item.mode === 'oauth') return remember(await tokens[item.id].session());
  const value = (await readPrivateJson(file('connections.json')))[item.id];
  if (!value || typeof value !== 'object') throw new Error('Connect this account first');
  if (item.id === 'commandcode' && value.credentialSource !== 'cli-login') throw new Error('Import your Command Code CLI login first');
  if (item.id === 'qoder' && (!value.accessToken || !value.userId)) throw new Error('Qoder account token and user ID are required');
  return remember(value);
}
function modelShape(entry, source) {
  const id = entry.id ?? entry.slug ?? entry.name;
  if (typeof id !== 'string' || !id || id.length > 256 || /[\x00-\x1f]/.test(id)) return undefined;
  const modalities = entry.inputModalities ?? entry.supported_modalities ?? entry.architecture?.input_modalities ?? [];
  const efforts = entry.reasoning?.efforts ?? entry.supported_reasoning_levels ?? [];
  return { id, name: String(entry.name ?? entry.display_name ?? id).slice(0, 160), source,
    capabilities: modalities.includes('image') ? ['image'] : [],
    reasoningLevels: efforts.map(value => typeof value === 'string' ? value : value.id ?? value.effort).filter(value => ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(value)),
    ...(finite(entry.contextWindow ?? entry.context_length) !== undefined ? { contextWindow: entry.contextWindow ?? entry.context_length } : {}) };
}
async function models(item, signal) {
  const value = await credentials(item); let entries;
  const nativeFetchers = { codex: hub.fetchCodexModels, claude: hub.fetchClaudeModels, grok: hub.fetchGrokModels, antigravity: hub.fetchAntigravityModels };
  if (nativeFetchers[item.id]) entries = await nativeFetchers[item.id](value);
  else if (item.transport === 'commandcode' || item.transport === 'qoder') {
    entries = (value.models ?? item.models).map(id => {
      const known = item.id === 'commandcode' ? COMMANDCODE_MODELS.find(model => model.id === id.replace(/^cc\//, '')) : undefined;
      return { id, ...(known ? { name: known.name, contextWindow: known.contextWindow, inputModalities: known.supportsImage ? ['text', 'image'] : ['text'], reasoning: { efforts: known.efforts } } : item.id === 'qoder' ? { inputModalities: ['text', 'image'], reasoning: { efforts: ['none', 'low', 'medium', 'high'] } } : {}) };
    });
    const result = entries.map(entry => modelShape(entry, 'preset')).filter(Boolean);
    await update('public-models.json', store => { store[item.id] = { models: result, checkedAt: Date.now() }; }, signal); return { models: result, source: 'preset' };
  } else {
    const base = validateUrl(value.baseUrl ?? item.baseUrl);
    const response = await fetch(base + '/models', { headers: { authorization: `Bearer ${value.accessToken}` }, signal });
    if (!response.ok) throw new Error(`Model discovery failed (HTTP ${response.status})`);
    const text = await boundedText(response); const payload = JSON.parse(text);
    entries = payload.data ?? payload.models;
  }
  if (!Array.isArray(entries)) throw new Error('Upstream returned no model catalog');
  const ids = new Set(), result = [];
  for (const entry of entries.slice(0, 500)) { const model = modelShape({ ...entry, ...(['codex', 'claude', 'antigravity'].includes(item.id) && !entry.inputModalities ? { inputModalities: ['text', 'image'] } : {}) }, 'upstream'); if (model && !ids.has(model.id)) { ids.add(model.id); result.push(model); } }
  if (!result.length) throw new Error('Upstream model catalog is empty; enter a model ID manually');
  await update('public-models.json', store => { store[item.id] = { models: result, checkedAt: Date.now() }; }, signal);
  return { models: result, source: 'upstream' };
}
async function boundedText(response) {
  if (!response.body) throw new Error('Upstream returned no body');
  const reader = response.body.getReader(); let size = 0; const parts = [];
  try { for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 2_000_000) throw new Error('Upstream response exceeds size limit'); parts.push(value); } return Buffer.concat(parts).toString('utf8'); }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
async function jsonFetch(url, key, signal) {
  const response = await fetch(url, { headers: { authorization: `Bearer ${key}`, accept: 'application/json' }, signal });
  if (!response.ok) throw new Error(`Quota query failed (HTTP ${response.status})`);
  return JSON.parse(await boundedText(response));
}
function normalizeQuota(raw) {
  const result = { supported: raw?.supported === true, checkedAt: Date.now(), windows: [] };
  if (typeof raw?.plan === 'string') result.plan = raw.plan.slice(0, 120);
  for (const window of (raw?.windows ?? []).slice(0, 40)) {
    const clean = { kind: ['session', 'weekly', 'daily', 'monthly', 'lifetime', 'other'].includes(window.kind) ? window.kind : 'other' };
    for (const field of ['usedPercent', 'usedUsd', 'remaining', 'limit', 'resetsAt', 'windowDurationMins']) { const value = finite(window[field]); if (value !== undefined) clean[field] = value; }
    if (typeof window.scope === 'string') clean.scope = window.scope.slice(0, 120);
    if (typeof window.unit === 'string') clean.unit = window.unit.slice(0, 32);
    if (Object.keys(clean).length > 1) result.windows.push(clean);
  }
  // An empty payload is unavailable, never a fabricated zero or unlimited balance.
  result.supported = result.supported && result.windows.length > 0;
  return result;
}
async function quota(item, signal) {
  if (!item.quotaSupport) {
    const result = normalizeQuota({ supported: false });
    await update('quota.json', store => { store[item.id] = result; }, signal); return result;
  }
  const value = await credentials(item); let raw = { supported: false };
  const nativeFetchers = { codex: hub.fetchCodexUsage, claude: hub.fetchClaudeUsage, grok: hub.fetchGrokUsage, antigravity: hub.fetchAntigravityUsage };
  if (nativeFetchers[item.id]) raw = await nativeFetchers[item.id](value, fetch, signal);
  else if (item.id === 'commandcode') {
    const data = await jsonFetch(COMMANDCODE_CREDITS_URL, value.apiKey, signal);
    const balance = data.balance ?? data.credits ?? data.remaining ?? data.data?.balance ?? data.data?.credits;
    if (finite(balance) !== undefined) raw = { supported: true, windows: [{ kind: 'other', remaining: balance, unit: 'credits' }] };
  }
  const result = normalizeQuota(raw);
  await update('quota.json', store => { store[item.id] = result; }, signal); return result;
}

async function importAccount(item, signal, readLocal = localJson) {
  if (item.id === 'codex') {
    const source = await readLocal(join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'auth.json'));
    const wire = source.tokens;
    if (!wire?.access_token || !wire?.refresh_token) throw new Error('Local Codex subscription login not found; run codex login');
    const session = hub.codexSession(wire); if (wire.account_id) session.accountId = wire.account_id;
    await hub.saveSession('codex', remember(session), file('auth.json'), signal);
  } else if (item.id === 'claude') {
    const session = hub.readClaudeCodeCredentials();
    if (!session) throw new Error('Local Claude Code login not found; run claude auth login');
    await hub.saveSession('claude', remember(session), file('auth.json'), signal);
  } else {
    let value;
    if (item.id === 'commandcode') {
      const source = await readLocal(join(homedir(), '.commandcode', 'auth.json'));
      const apiKey = source?.apiKey;
      if (typeof apiKey !== 'string' || !apiKey.trim() || apiKey.length > 65536 || /[\x00-\x1f]/.test(apiKey)) throw new Error('Command Code CLI login not found; run commandcode login');
      value = { apiKey: apiKey.trim(), credentialSource: 'cli-login', models: item.models };
    } else if (item.id === 'qoder') {
      value = await resolveQoderCredential();
      if (!value?.accessToken || !value?.userId) throw new Error('Qoder login not found; provide your account token and user ID, or configure QODER_ACCESS_TOKEN and QODER_USER_ID');
      value.models = item.models;
    } else throw new Error('Local import is not supported for this provider');
    remember(value); await update('connections.json', store => { store[item.id] = value; }, signal);
  }
  return { imported: true };
}

async function generate(item, data, signal, emit) {
  const value = await credentials(item), reply = new Reply(emit);
  const model = data.model; if (typeof model !== 'string' || !model || !Array.isArray(data.messages)) throw new Error('Invalid generation request');
  if (adapters[item.id]) {
    const tools = item.id === 'antigravity' ? toGeminiTools(data.tools ?? []) : (data.tools ?? []).map(tool => tool.function ?? tool);
    for await (const chunk of adapters[item.id].stream({ model, messages: toNativeMessages(data.messages),
      tools, reasoningEffort: data.reasoningEffort,
      maxTokens: data.maxTokens, signal, sessionId: data.sessionId })) { signal.throwIfAborted(); reply.push(chunk); }
  } else {
    let response, mapper = openAIChunks;
    if (item.id === 'commandcode') {
      const system = data.messages.filter(message => message.role === 'system').map(message => message.content).join('\n\n');
      response = await commandCodeChat(value.apiKey, { model: model.replace(/^cc\//, ''), messages: toCommandCodeMessages(data.messages),
        system, tools: (data.tools ?? []).map(tool => ({ type: 'function', name: tool.function?.name, description: tool.function?.description, input_schema: tool.function?.parameters })),
        reasoningEffort: data.reasoningEffort, maxTokens: data.maxTokens, signal, threadId: data.sessionId });
      const tools = new Map(); mapper = event => commandCodeChunks(event, tools);
    } else if (item.id === 'qoder') {
      const upstream = qoderDirectModel(model); if (!upstream) throw new Error('Unsupported Qoder model');
      response = await qoderChat(value, { model: upstream, messages: data.messages, tools: data.tools, reasoningEffort: data.reasoningEffort, maxTokens: data.maxTokens, signal });
      mapper = event => { if (event.error || event.code && ![0, '0', '200', 200].includes(event.code)) throw new Error('Qoder reported a stream error'); return openAIChunks(unwrapQoderEvent(JSON.stringify(event)) ?? event); };
    } else {
      const base = validateUrl(value.baseUrl ?? item.baseUrl);
      response = await fetch(base + '/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${value.accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model, messages: data.messages, stream: true, ...(data.tools?.length ? { tools: data.tools } : {}),
          ...(data.reasoningEffort ? { reasoning_effort: data.reasoningEffort } : {}), ...(data.maxTokens ? { max_tokens: data.maxTokens } : {}) }), signal });
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Upstream generation failed (HTTP ${response.status})`); }
    for await (const frame of parseFrames(response.body, { ndjson: item.id === 'commandcode', signal })) {
      if (frame.data === '[DONE]') continue;
      let event; try { event = JSON.parse(frame.data); } catch { throw new Error('Upstream returned an invalid stream frame'); }
      for (const chunk of mapper(event)) reply.push(chunk);
    }
  }
  const result = reply.result();
  if (result._response_models) result._response_models = result._response_models.filter(model => !secretValues.has(model));
  return result;
}

async function handle(action, id, data, signal, emit) {
  const item = catalog.find(item => item.id === id);
  if (!item) throw new Error('Unknown subscription provider');
  signal.throwIfAborted();
  if (action === 'login') {
    if (!nativeIds.has(id)) throw new Error('Import a CLI login or provide subscription account credentials');
    return auth.login(id);
  }
  if (action === 'status') {
    if (!nativeIds.has(id)) return {};
    const value = await auth.status(id), pending = auth.flows.pending(id);
    return { ...value, ...(pending?.authorizeUrl ? { authorizeUrl: pending.authorizeUrl } : {}) };
  }
  if (action === 'cancel') { if (nativeIds.has(id)) await auth.cancel(id); return { cancelled: true }; }
  if (action === 'manual') { if (!nativeIds.has(id) || typeof data.callback !== 'string') throw new Error('No login in progress'); await auth.manual(id, data.callback); return { submitted: true }; }
  if (action === 'import') return importAccount(item, signal);
  if (action === 'disconnect') {
    epochs.set(id, (epochs.get(id) ?? 0) + 1);
    for (const controller of requests.values()) if (controller.provider === id && controller.signal !== signal) controller.abort();
    if (nativeIds.has(id)) await auth.logout(id);
    else await update('connections.json', store => { delete store[id]; }, signal);
    await update('public-models.json', store => { delete store[id]; }, signal);
    await update('quota.json', store => { delete store[id]; }, signal); return { disconnected: true };
  }
  if (action === 'models') return models(item, signal);
  if (action === 'quota') return quota(item, signal);
  if (action === 'generate') return generate(item, data, signal, emit);
  throw new Error('Unknown subscription operation');
}

async function dispose() {
  for (const request of requests.values()) request.abort();
  await auth.dispose().catch(() => {}); await writes.catch(() => {});
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on('line', line => {
    if (line.length > 8_000_000) { process.exitCode = 1; lines.close(); return; }
    let request; try { request = JSON.parse(line); } catch { send({ error: 'Invalid bridge request' }); return; }
    if (request.action === 'abort') { requests.get(request.target)?.abort(); return; }
    if (requests.size >= 16 || typeof request.id !== 'string' || requests.has(request.id)) { send({ id: request.id, error: 'Too many pending requests' }); return; }
    const controller = new AbortController(); controller.provider = request.provider; requests.set(request.id, controller);
    const timer = setTimeout(() => controller.abort(new Error('Subscription request timed out')), request.action === 'generate' ? 600_000 : 120_000);
    context.run({ signal: controller.signal, generation: request.action === 'generate' }, async () => {
      try { const result = await handle(request.action, request.provider, request.data ?? {}, controller.signal, chunk => send({ id: request.id, chunk })); controller.signal.throwIfAborted(); send({ id: request.id, result }); }
      catch (error) { send({ id: request.id, error: safeError(error), errorInfo: errorMetadata(error) }); }
      finally { clearTimeout(timer); requests.delete(request.id); }
    });
  });
  lines.on('close', () => { void dispose().finally(() => process.exit(0)); });
  process.once('SIGTERM', () => { void dispose().finally(() => process.exit(0)); });
}

export { normalizeQuota, validateUrl, modelShape, errorMetadata, importAccount, generate, handle, dispose };
