import { createHash } from 'node:crypto';
import { isDict } from '@xueness/contracts';
import { estimateTextTokens } from './upstream-estimate.ts';
import type { Category, ContextItem, RequestRecord, Row } from './types.ts';

export const CATEGORIES: Category[] = ['system', 'tools', 'user', 'injected', 'assistant', 'reasoning', 'tool'];
export const REQUEST_LIMIT = 160;
export function composition(): Record<Category, number> { return Object.fromEntries(CATEGORIES.map(key => [key, 0])) as Record<Category, number>; }
function textContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.filter(isDict).map(block => typeof block.text === 'string' ? block.text : `[${String(block.type ?? 'attachment')}]`).join('\n');
}
export function contextItems(messages: readonly unknown[], tools: readonly unknown[] = []): ContextItem[] {
  const rows: ContextItem[] = [];
  const add = (category: Category, label: string, text: string) => {
    if (!text) return;
    const id = createHash('sha256').update(category).update('\0').update(text).digest('hex');
    rows.push({ id, category, label, tokens: estimateTextTokens(text), characters: text.length, text: text.slice(0, 12000), truncated: text.length > 12000 });
  };
  for (const [index, message] of messages.entries()) {
    if (!isDict(message)) continue;
    const role = String(message.role), injected = message._injected === true || message._input_kind === 'background_notice';
    const category: Category = role === 'system' ? 'system' : role === 'tool' ? 'tool' : role === 'assistant' ? 'assistant' : injected ? 'injected' : 'user';
    add(category, `${index + 1} · ${role}`, textContent(message.content));
    if (typeof message.reasoning_content === 'string') add('reasoning', `${index + 1} · reasoning`, message.reasoning_content);
    if (Array.isArray(message.tool_calls)) for (const call of message.tool_calls.filter(isDict)) {
      const fn = isDict(call.function) ? call.function : {};
      add('assistant', String(fn.name ?? 'tool call'), String(fn.arguments ?? ''));
    }
  }
  for (const tool of tools.filter(isDict)) {
    const fn = isDict(tool.function) ? tool.function : tool;
    add('tools', String(fn.name ?? 'tool schema'), JSON.stringify(tool));
  }
  return rows;
}
export function summarizeItems(items: readonly ContextItem[]) {
  const values = composition(); for (const item of items) values[item.category] += item.tokens;
  return { composition: values, estimatedTokens: Object.values(values).reduce((sum, n) => sum + n, 0) };
}
export function captureRequest(session: Row, messages: readonly unknown[], tools: readonly unknown[], model: string): void {
  const items = contextItems(messages, tools), step = Number(session.steps ?? 0) + 1;
  const record: RequestRecord = { step, at: new Date().toISOString(), model, ...summarizeItems(items), items: items.map(({ text: _text, ...item }) => item) };
  const earlier = Array.isArray(session.context_lens_requests) ? session.context_lens_requests.filter(isDict).filter(item => item.step !== step) : [];
  session.context_lens_requests = [...earlier, record].slice(-REQUEST_LIMIT);
}
