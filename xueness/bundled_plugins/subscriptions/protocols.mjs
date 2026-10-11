/** Provider-independent bounded decoding. No network or executable tools. */
const FRAME_LIMIT = 2_000_000;
const RESPONSE_LIMIT = 16_000_000;
export async function* parseFrames(stream, { ndjson = false, signal, onActivity } = {}) {
  if (!stream) throw new Error('Upstream returned no response body');
  const reader = stream.getReader(), decoder = new TextDecoder();
  let pending = '', lines = [], event, total = 0;
  const consume = line => {
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (ndjson && line && !line.startsWith('data:') && !line.startsWith('event:') && !line.startsWith(':')) return { data: line };
    if (!line) { const frame = lines.length ? { data: lines.join('\n'), ...(event ? { event } : {}) } : null; lines = []; event = undefined; return frame; }
    if (line.startsWith('data:')) lines.push(line.slice(5).replace(/^ /, ''));
    else if (line.startsWith('event:')) event = line.slice(6).replace(/^ /, '');
    if (lines.reduce((n, part) => n + part.length, 0) > FRAME_LIMIT) throw new Error('Upstream frame exceeds size limit');
    return null;
  };
  const abort = () => { void reader.cancel(signal?.reason).catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
      total += value?.byteLength ?? 0;
      if (pending.length > FRAME_LIMIT || total > RESPONSE_LIMIT) throw new Error('Upstream response exceeds size limit');
      if (!done) onActivity?.();
      let newline;
      while ((newline = pending.indexOf('\n')) >= 0) {
        const frame = consume(pending.slice(0, newline)); pending = pending.slice(newline + 1);
        if (frame) yield frame;
      }
      if (done) {
        if (pending) { const frame = consume(pending); if (frame) yield frame; }
        const frame = consume(''); if (frame) yield frame;
        return;
      }
    }
  } finally { signal?.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export function finite(value) { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined; }
export function normalizeUsage(raw, format = 'openai') {
  if (!raw || typeof raw !== 'object') return undefined;
  const keys = format === 'native'
    ? { input_tokens: 'inputTokens', output_tokens: 'outputTokens', cache_read_input_tokens: 'cacheReadTokens', cache_creation_input_tokens: 'cacheWriteTokens', reasoning_tokens: 'reasoningTokens' }
    : { input_tokens: 'prompt_tokens', output_tokens: 'completion_tokens', total_tokens: 'total_tokens' };
  const result = {};
  for (const [key, field] of Object.entries(keys)) { const value = finite(raw[field]); if (value !== undefined) result[key] = value; }
  const cached = finite(raw.prompt_tokens_details?.cached_tokens), reasoning = finite(raw.completion_tokens_details?.reasoning_tokens);
  if (cached !== undefined) result.cache_read_input_tokens = cached;
  if (reasoning !== undefined) result.reasoning_tokens = reasoning;
  // Native harness counts exclude cache reads; Xueness input counts include them.
  if (result.input_tokens !== undefined) result.prompt_tokens = result.input_tokens + (format === 'native' ? (result.cache_read_input_tokens ?? 0) + (result.cache_creation_input_tokens ?? 0) : 0);
  if (result.output_tokens !== undefined) result.completion_tokens = result.output_tokens;
  if (result.total_tokens === undefined && result.prompt_tokens !== undefined && result.completion_tokens !== undefined) result.total_tokens = result.prompt_tokens + result.completion_tokens;
  return Object.keys(result).length ? result : undefined;
}

export function toNativeMessages(messages) {
  return messages.map(message => {
    const blocks = [];
    if (message.role === 'tool') blocks.push({ type: 'tool-result', toolCallId: message.tool_call_id,
      content: [{ type: 'text', text: typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '') }] });
    else if (typeof message.content === 'string' && message.content) blocks.push({ type: 'text', text: message.content });
    else if (Array.isArray(message.content)) for (const part of message.content) {
      if (part.type === 'text' && typeof part.text === 'string') blocks.push({ type: 'text', text: part.text });
      else if (part.type === 'image_url') {
        const match = /^data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(part.image_url?.url ?? '');
        if (!match) throw new Error('Subscription image input requires inline image data');
        blocks.push({ type: 'image', mediaType: match[1], dataBase64: match[2] });
      } else throw new Error('Unsupported subscription attachment');
    }
    for (const call of message.tool_calls ?? []) blocks.push({ type: 'tool-call', id: call.id,
      name: call.function?.name, arguments: call.function?.arguments ?? '{}' });
    return { role: message.role === 'tool' ? 'user' : message.role, content: blocks };
  });
}

export function toCommandCodeMessages(messages) {
  const names = new Map();
  for (const message of messages) for (const call of message.tool_calls ?? []) names.set(call.id, call.function?.name);
  return toNativeMessages(messages).filter(message => message.role !== 'system').flatMap(message => {
    const results = message.content.filter(block => block.type === 'tool-result');
    if (results.length) return results.map(block => ({ role: 'tool', content: [{ type: 'tool-result', toolCallId: block.toolCallId,
      toolName: names.get(block.toolCallId) ?? 'tool', output: { type: 'text', value: block.content.map(part => part.text).join('') } }] }));
    return [{ role: message.role, content: message.content.map(block => {
      if (block.type === 'tool-call') return { type: 'tool-call', toolCallId: block.id, toolName: block.name, input: JSON.parse(block.arguments || '{}') };
      if (block.type === 'image') return { type: 'image', image: `data:${block.mediaType};base64,${block.dataBase64}` };
      return block;
    }) }];
  });
}

/** Assembles multi-tool fragments without executing any tool. */
export class Reply {
  constructor(emit = () => {}) { this.emit = emit; this.content = ''; this.reasoning = ''; this.calls = new Map(); this.finish = undefined; this.usage = undefined; this.bytes = 0; this.models = []; }
  push(chunk) {
    this.bytes += JSON.stringify(chunk).length;
    if (this.bytes > RESPONSE_LIMIT) throw new Error('Upstream response exceeds size limit');
    if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
      if (typeof chunk.text !== 'string') return;
      if (chunk.type === 'text-delta') { this.content += chunk.text; this.emit({ type: 'content', text: chunk.text }); }
      else { this.reasoning += chunk.text; this.emit({ type: 'reasoning', text: chunk.text }); }
    } else if (chunk.type === 'tool-call-delta') {
      const key = chunk.index ?? chunk.id ?? 0;
      const call = this.calls.get(key) ?? { id: '', type: 'function', function: { name: '', arguments: '' } };
      if (chunk.id) call.id = String(chunk.id);
      if (chunk.name) call.function.name += chunk.name;
      if (typeof chunk.argumentsDelta === 'string') call.function.arguments += chunk.argumentsDelta;
      this.calls.set(key, call);
    } else if (chunk.type === 'block-end' && chunk.block?.type === 'tool-call') {
      const block = chunk.block;
      this.calls.set(chunk.index ?? block.id, { id: String(block.id), type: 'function', function: { name: block.name, arguments: block.arguments } });
    } else if (chunk.type === 'usage') { const usage = normalizeUsage(chunk.usage, chunk.format ?? 'native'); if (usage) this.usage = { ...this.usage, ...usage }; }
    else if (chunk.type === 'finish') this.finish = chunk.reason?.kind ?? chunk.reason;
    else if (chunk.type === 'response-model' && typeof chunk.model === 'string' && chunk.model.length <= 256 && !/[\x00-\x1f]/.test(chunk.model) && !this.models.includes(chunk.model) && this.models.length < 8) this.models.push(chunk.model);
  }
  result() {
    const calls = [...this.calls.values()];
    if (calls.some(call => !call.id || !call.function.name || typeof call.function.arguments !== 'string')) throw new Error('Upstream returned an incomplete tool call');
    if (!this.finish) throw new Error('Upstream stream ended before completion');
    const finish = this.finish === 'tool-calls' ? 'tool_calls' : this.finish === 'max-tokens' ? 'length' : this.finish;
    if (finish === 'error' || finish === 'failed') throw new Error('Upstream generation failed');
    if (!this.content && !this.reasoning && !calls.length) throw new Error('Upstream returned an empty reply');
    return { content: this.content, tool_calls: calls, ...(this.reasoning ? { reasoning_content: this.reasoning } : {}),
      _finish_reason: finish, ...(this.usage ? { _usage: this.usage } : {}), ...(this.models.length ? { _response_models: this.models } : {}) };
  }
}

export function openAIChunks(event) {
  if (event?.error) throw new Error('Upstream reported a stream error');
  const chunks = [], choice = event?.choices?.[0], delta = choice?.delta;
  if (typeof event?.model === 'string') chunks.push({ type: 'response-model', model: event.model });
  if (typeof delta?.content === 'string') chunks.push({ type: 'text-delta', text: delta.content });
  const reasoning = delta?.reasoning_content ?? delta?.reasoning;
  if (typeof reasoning === 'string') chunks.push({ type: 'reasoning-delta', text: reasoning });
  for (const call of delta?.tool_calls ?? []) chunks.push({ type: 'tool-call-delta', index: call.index ?? 0,
    ...(call.id ? { id: call.id } : {}), ...(call.function?.name ? { name: call.function.name } : {}), argumentsDelta: call.function?.arguments ?? '' });
  if (event?.usage) chunks.push({ type: 'usage', usage: event.usage, format: 'openai' });
  if (typeof choice?.finish_reason === 'string' && choice.finish_reason) chunks.push({ type: 'finish', reason: choice.finish_reason });
  return chunks;
}

export function commandCodeChunks(event, tools) {
  if (event?.type === 'error') throw new Error('Command Code reported a stream error');
  if ((event?.type === 'text-delta' || event?.type === 'reasoning-delta') && typeof (event.text ?? event.delta) === 'string') return [{ type: event.type, text: event.text ?? event.delta }];
  const chunks = [];
  if (event.type === 'tool-input-start' || event.type === 'tool-input-delta' || event.type === 'tool-call') {
    const id = event.toolCallId ?? event.id;
    if (typeof id !== 'string' || !id) throw new Error('Command Code returned a tool call without an ID');
    let tool = tools.get(id);
    if (!tool) { tool = { index: tools.size, name: '', args: '', closed: false }; tools.set(id, tool); }
    if (event.toolName) tool.name = event.toolName;
    if (event.type === 'tool-input-delta' && typeof event.delta === 'string') tool.args += event.delta;
    if (event.type === 'tool-call') {
      if (!tool.closed) chunks.push({ type: 'block-end', index: tool.index, block: { type: 'tool-call', id, name: tool.name, arguments: JSON.stringify(event.input ?? {}) } });
      tool.closed = true;
    } else if (event.type === 'tool-input-start') chunks.push({ type: 'tool-call-delta', index: tool.index, id, name: tool.name });
    else if (!tool.closed) chunks.push({ type: 'tool-call-delta', index: tool.index, id, argumentsDelta: event.delta });
  }
  if (event.type === 'finish-step' && event.usage) chunks.push({ type: 'usage', usage: { ...event.usage, cacheReadTokens: event.usage.cachedInputTokens,
    inputTokens: finite(event.usage.inputTokens) === undefined ? undefined : Math.max(0, event.usage.inputTokens - (finite(event.usage.cachedInputTokens) ?? 0)) } });
  if (event.type === 'finish') chunks.push({ type: 'finish', reason: event.finishReason ?? 'stop' });
  return chunks;
}
