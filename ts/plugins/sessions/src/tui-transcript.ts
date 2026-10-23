import type { TuiDocument, TuiEntry, TuiLine, TuiRow, TuiThemeMode } from './tui-types.ts';
import { markdownLines, diffLines } from './tui-markdown.ts';

const text = (value: unknown): string => typeof value === 'string' ? value : '';
const isRow = (value: unknown): value is TuiRow => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const record = (value: unknown): TuiRow => isRow(value) ? value : {};
const firstText = (...values: unknown[]): string => {
  const value = values.find((candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0);
  return value ?? '';
};

function stableId(row: TuiRow): string | undefined {
  for (const key of ['call_id', 'tool_call_id', 'toolCallId', 'id']) {
    if (row[key] != null && String(row[key])) return String(row[key]);
  }
  return undefined;
}

function payloadOf(event: TuiRow): TuiRow {
  return isRow(event.payload) ? { ...event, ...event.payload } : event;
}

export function createTuiDocument(sessionId = ''): TuiDocument {
  return { sessionId, entries: [], usage: {}, network: [] };
}

export function hydrateTuiDocument(sessionId: string, messages: readonly TuiRow[], events: readonly TuiRow[] = []): TuiDocument {
  const doc = createTuiDocument(sessionId);
  for (const message of messages) hydrateMessage(doc, message);
  for (const event of events) applyTuiEvent(doc, event);
  return doc;
}

function bodyText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map((part) => text(record(part).text ?? record(part).content)).filter(Boolean).join('\n');
}

function hydrateMessage(doc: TuiDocument, message: TuiRow): void {
  const role = String(message.role ?? message.type ?? message.kind ?? '').toLowerCase();
  const body = bodyText(message.content ?? message.text ?? message.response);
  const id = String(message.id ?? message._message_id ?? message.messageId ?? `message-${doc.entries.length + 1}`);
  if (['system', 'developer', 'system_prompt', 'system-prompt', 'systemprompt'].includes(role)) return;
  if (role === 'user') doc.entries.push({ id, kind: 'user', text: body });
  else if (['assistant', 'agent', 'model'].includes(role) && body) doc.entries.push({ id, kind: 'assistant', text: body });
  else if (['thought', 'reasoning'].includes(role) && body) doc.entries.push({ id, kind: 'thought', text: body, expanded: false });
  else if (role.includes('tool')) {
    const callId = stableId(message) ?? id;
    const prior = doc.entries.find((entry) => entry.kind === 'tool' && entry.id === callId);
    const result = parseJson(body);
    upsert(doc, toolEntry(callId, { ...prior, ...message, result, status: record(result).ok === false ? 'failed' : 'completed' }, body));
  }

  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : Array.isArray(message.toolCalls) ? message.toolCalls : [];
  for (const item of calls) {
    const call = record(item);
    const fn = record(call.function ?? call);
    const input = fn.arguments ?? call.input ?? call.arguments;
    doc.entries.push(toolEntry(stableId(call) ?? stableId(fn) ?? `${id}-tool-${doc.entries.length}`, { ...call, ...fn, input }, ''));
  }
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value) as unknown; } catch { return value; }
}

function jsonText(value: unknown): string {
  try { return JSON.stringify(value, null, 2) ?? ''; } catch { return String(value); }
}

function inputRow(value: unknown): TuiRow {
  const parsed = parseJson(value);
  if (isRow(parsed)) return parsed;
  return parsed == null ? {} : { value: parsed };
}

function subjectArguments(value: unknown): TuiRow {
  const parsed = parseJson(value);
  if (isRow(parsed)) return parsed;
  if (typeof value !== 'string') return {};
  const recovered: TuiRow = {};
  for (const key of ['path', 'file_path', 'filePath']) {
    const match = new RegExp(`"${key}"\\s*:\\s*("(?:\\\\.|[^"\\\\])*")`).exec(value);
    if (match) {
      const parsedValue = parseJson(match[1]);
      if (typeof parsedValue === 'string') recovered[key] = parsedValue;
    }
  }
  return recovered;
}

function resultText(result: unknown, data: TuiRow, fallback: string): string {
  if (typeof result === 'string') return result;
  const object = record(result);
  const readable = bodyText(object.content ?? object.text);
  if (readable) return readable;
  if (result != null) return jsonText(result);
  return firstText(data.error, data.message, fallback);
}

function toolEntry(id: string, data: TuiRow, fallbackOutput: string): TuiEntry {
  const explicitInput = data.input ?? data.arguments ?? data.parameters ?? data.args;
  const subject = parseJson(data.subject);
  const input = explicitInput !== undefined ? inputRow(explicitInput) : subjectArguments(data.subject);
  const hasResultJson = data.resultJson != null || data.resultJSON != null || data.result_json != null;
  const rawResult = data.resultJson ?? data.resultJSON ?? data.result_json ?? data.result ?? data.output;
  const result = parseJson(rawResult);
  const path = firstText(data.file_path, data.filePath, data.path, input.file_path, input.filePath, input.path, typeof subject === 'string' ? subject : '');
  const name = firstText(data.name, data.tool_name, data.toolName, data.function_name, data.functionName, 'tool');
  const output = hasResultJson && result != null ? jsonText(result) : resultText(result, data, fallbackOutput);
  const resultObject = record(result);
  const diff = firstText(resultObject.diff, record(resultObject.display).diff, data.diff, resultObject.patch);
  return {
    id,
    kind: 'tool',
    text: '',
    name,
    title: path ? `${name} ${path}` : name,
    path,
    input,
    output: output || undefined,
    diff: diff || undefined,
    status: firstText(data.status, 'running'),
    expanded: false,
  };
}

function upsert(doc: TuiDocument, entry: TuiEntry): TuiEntry {
  const index = doc.entries.findIndex((item) => item.id === entry.id);
  if (index < 0) { doc.entries.push(entry); return entry; }
  doc.entries[index] = { ...doc.entries[index]!, ...entry, expanded: doc.entries[index]!.expanded ?? entry.expanded };
  return doc.entries[index]!;
}

function assistantEntry(doc: TuiDocument, id: string, content: string): void {
  const existing = doc.entries.find((entry) => entry.id === id && entry.kind === 'assistant');
  if (existing) { existing.text = content; return; }
  const last = doc.entries.at(-1);
  if (last?.kind === 'assistant' && last.text === content) return;
  doc.entries.push({ id, kind: 'assistant', text: content });
}

function streamEntry(doc: TuiDocument, kind: 'assistant' | 'thought', id: string, delta: string): void {
  if (!delta) return;
  const existing = doc.entries.find((entry) => entry.id === id && entry.kind === kind);
  if (existing) existing.text += delta;
  else doc.entries.push({ id, kind, text: delta, ...(kind === 'thought' ? { expanded: false, status: 'streaming' } : {}) });
  if (kind === 'assistant') doc.streamingId = id;
}

function finalizeThoughts(doc: TuiDocument): void {
  for (const entry of doc.entries) if (entry.kind === 'thought' && entry.status === 'streaming') entry.status = undefined;
}

function updateUsage(doc: TuiDocument, data: TuiRow): void {
  const usage = record(data.usage ?? data.usageSummary ?? data.usage_summary);
  if (Object.keys(usage).length) doc.usage = { ...doc.usage, ...usage };
  const context = record(data.contextUsage ?? data.context_usage ?? data.context);
  const used = data.contextUsed ?? data.context_used ?? context.contextUsed ?? context.used;
  const window = data.contextWindow ?? data.context_window ?? context.contextWindow ?? context.window;
  if (typeof used === 'number' && Number.isFinite(used)) doc.contextUsed = used;
  if (typeof window === 'number' && Number.isFinite(window)) doc.contextWindow = window;
}

function networkStatus(type: string): string {
  if (/failed|stalled|error|timeout/.test(type)) return 'error';
  if (/completed|complete|succeeded/.test(type)) return 'complete';
  return 'pending';
}

function isRunningCompaction(entry: TuiEntry): boolean {
  return entry.kind === 'compact' && (entry.status === 'running' || entry.status === 'retrying');
}

function compactionEntry(doc: TuiDocument, type: string, data: TuiRow): TuiEntry {
  const phase = text(data.phase);
  const trigger = text(data.trigger);
  const operationId = firstText(data.operationId, data.compactionId);
  const matchesOperation = (entry: TuiEntry) => {
    const meta = entry.meta ?? {};
    return (!phase || meta.phase === phase) && (!trigger || meta.trigger === trigger);
  };
  let previous = operationId
    ? doc.entries.find((entry) => entry.kind === 'compact' && entry.id === operationId)
    : undefined;
  if (!previous && !operationId) {
    previous = [...doc.entries].reverse().find((entry) => isRunningCompaction(entry) && matchesOperation(entry));
  }

  const isStarted = type.endsWith('_started') || type === 'compact';
  if (isStarted && data.status !== 'retrying' && !operationId) previous = undefined;
  let id = operationId || previous?.id || '';
  if (!id) {
    const used = new Set(doc.entries.filter((entry) => entry.kind === 'compact').map((entry) => entry.id));
    for (let index = 1; ; index += 1) {
      const candidate = `compaction-${index}`;
      if (!used.has(candidate)) { id = candidate; break; }
    }
  }

  const cancelled = data.cancelled === true || data.status === 'cancelled' || type.endsWith('_cancelled');
  const status = isStarted
    ? firstText(data.status, 'running')
    : type.endsWith('_completed') ? 'completed'
      : type.endsWith('_failed') || type.endsWith('_cancelled') ? cancelled ? 'interrupted' : 'failed'
        : firstText(data.status, previous?.status, 'running');
  const meta = {
    ...(previous?.meta ?? {}),
    ...data,
    ...(phase ? { phase } : {}),
    ...(trigger ? { trigger } : {}),
    retryCommand: firstText(data.retryCommand, data.retry_command, previous?.meta?.retryCommand, '/compact'),
  };
  const title = firstText(data.title, data.label, previous?.title, 'Context compaction');
  return {
    id,
    kind: 'compact',
    text: firstText(data.reason, data.message, previous?.text),
    status,
    title,
    meta,
    expanded: previous?.expanded ?? false,
  };
}

export function applyTuiEvent(doc: TuiDocument, event: TuiRow): void {
  const data = payloadOf(event);
  const eventSession = event.sessionId ?? event.session_id ?? data.sessionId ?? data.session_id;
  if (eventSession != null && String(eventSession) !== doc.sessionId) return;

  const outerType = String(event.type ?? event.event ?? '').toLowerCase();
  const payloadType = String(data.type ?? '').toLowerCase();
  const type = outerType === 'model_network_status' && payloadType ? payloadType : outerType || payloadType;
  const id = stableId(data) ?? String(data.messageId ?? data.assistantMessageId ?? `event-${doc.entries.length}`);
  doc.lastEvent = type;

  // Derived transcript previews duplicate the complete message snapshot supplied by the session port.
  if (type === 'assistant.text' || type === 'turn.user') return;
  if (type === 'assistant_delta' || type === 'model_streaming') {
    const delta = bodyText(data.delta ?? data.text ?? data.content);
    const messageId = firstText(data.assistantMessageId, data.messageId, data.stream_id, doc.streamingId, `assistant-${doc.entries.length}`);
    streamEntry(doc, 'assistant', messageId, delta);
    return;
  }
  if (['reasoning_delta', 'thought_delta', 'reasoning', 'stream_reasoning'].includes(type)) {
    const explicitId = firstText(data.messageId, data.thoughtId, data.reasoningId, data.stream_id ? `reasoning-${data.stream_id}` : '');
    const active = [...doc.entries].reverse().find((entry) => entry.kind === 'thought' && entry.status === 'streaming');
    const thoughtId = explicitId || active?.id || `thought-${doc.entries.length}`;
    const content = bodyText(data.delta ?? data.text ?? data.content);
    if (type.endsWith('_delta') || type === 'stream_reasoning' || data.delta != null) streamEntry(doc, 'thought', thoughtId, content);
    else if (content) upsert(doc, { id: thoughtId, kind: 'thought', text: content, expanded: false });
    return;
  }
  if (type === 'assistant' || type === 'assistant_message') {
    const content = bodyText(data.content ?? data.response ?? data.text);
    if (!content) return;
    const assistantId = firstText(doc.streamingId, data.assistantMessageId, data.messageId, id);
    assistantEntry(doc, assistantId, content);
    if (doc.streamingId === assistantId) doc.streamingId = undefined;
    finalizeThoughts(doc);
    return;
  }
  if (['tool_call', 'tool_call_scheduled', 'tool_call_started', 'tool_progress', 'tool_call_progress', 'tool_result', 'tool_call_result', 'tool_call_error', 'tool.call', 'tool.result', 'driver.tool_call', 'driver.tool_result'].includes(type)) {
    const call = { ...record(data.toolCall ?? data.call), ...data };
    const callId = stableId(call) ?? id;
    const prior = doc.entries.find((entry) => entry.kind === 'tool' && entry.id === callId);
    const isResult = /result/.test(type);
    const awaitingApproval = record(record(data.result).data).awaitingApproval === true;
    const status = awaitingApproval ? 'awaiting approval' : /error/.test(type) || data.ok === false ? 'failed' : isResult ? firstText(data.ok === true ? 'completed' : '', data.status, 'failed') : firstText(data.status, 'running');
    const entry = toolEntry(callId, { ...(prior ?? {}), ...call, status }, bodyText(data.output ?? data.content));
    entry.status = status;
    if (prior?.expanded) entry.expanded = true;
    upsert(doc, entry);
    return;
  }
  if (type === 'status') { doc.lastEvent = firstText(data.message, data.status, type); return; }
  if (type === 'completion' || type === 'turn_complete') {
    const response = bodyText(data.response ?? data.content ?? data.text);
    const targetId = firstText(doc.streamingId, data.assistantMessageId, data.messageId);
    if (response) assistantEntry(doc, targetId || `completion-${doc.entries.length}`, response);
    doc.streamingId = undefined;
    finalizeThoughts(doc);
    updateUsage(doc, data);
    return;
  }
  if (type === 'turn_error' || type === 'error') {
    const message = firstText(typeof data.error === 'string' ? data.error : record(data.error).message, data.message, data.reason);
    if (message) doc.entries.push({ id: String(data.id ?? `error-${doc.entries.length}`), kind: 'error', text: message });
    doc.error = message || undefined;
    doc.streamingId = undefined;
    finalizeThoughts(doc);
    return;
  }
  if (type === 'runtime_activity' || type === 'display_log') {
    const message = firstText(data.message, data.text, data.content, data.description, data.status);
    if (message) doc.entries.push({ id: String(data.id ?? `system-${doc.entries.length}`), kind: 'system', text: message });
    return;
  }
  if (type === 'compact' || type === 'context_compaction' || type.startsWith('compact_') || type === 'session_compacted' || type.startsWith('context/compaction_')) {
    const compact = compactionEntry(doc, type, data);
    upsert(doc, compact);
    return;
  }
  if (/^model_(request|stream|retry)_/.test(type)) {
    const requestId = String(data.requestId ?? id);
    if (type === 'model_request_queued' || type === 'model_request_admitted' || type === 'model_request_failed' && data.reason === 'cancelled' && doc.entries.some(entry => entry.id === `model-queue-${requestId}` && entry.text !== '已获模型并发名额')) upsert(doc, { id: `model-queue-${requestId}`, kind: 'system', text: type === 'model_request_queued' ? String(data.messageZh ?? '等待模型并发名额…') : type === 'model_request_admitted' ? '已获模型并发名额' : '已取消排队' });
    const status = networkStatus(type);
    const network = { ...data, id: requestId, status };
    const index = doc.network.findIndex((item) => String(item.id ?? item.requestId) === requestId);
    if (index < 0) doc.network.unshift(network); else doc.network[index] = { ...doc.network[index], ...network };
    doc.network = doc.network.slice(0, 8);
    if (type === 'model_request_failed' && data.terminal === true && data.reason !== 'cancelled') { const message = String(data.messageZh ?? data.message ?? ''); if (message) upsert(doc, { id: `model-error-${requestId}`, kind: 'error', text: message }); }
    updateUsage(doc, data);
    return;
  }
  if (type === 'workflow_progress' || type === 'dwf_progress') {
    const update = record(data.workflow ?? data.run ?? data);
    const runId = String(update.runId ?? update.id ?? id);
    const previous = doc.entries.find((entry) => entry.id === runId && entry.kind === 'workflow');
    const meta = { ...(previous?.meta ?? {}), ...update };
    const next: TuiEntry = {
      id: runId,
      kind: 'workflow',
      text: firstText(update.label, update.name, runId),
      title: firstText(update.label, update.name, runId),
      status: text(update.status),
      meta,
      expanded: previous?.expanded ?? false,
    };
    upsert(doc, next);
    return;
  }
  if (type === 'task' || type.startsWith('task_') || type === 'subagent' || type.startsWith('subagent_')) {
    const taskId = String(data.taskId ?? data.childId ?? data.childSessionId ?? id);
    upsert(doc, { id: taskId, kind: 'system', text: firstText(data.title, data.description, data.message, data.status, type), status: text(data.status), meta: data });
  }
}

export function toggleEntry(doc: TuiDocument, id: string): void {
  const entry = doc.entries.find((item) => item.id === id);
  if (entry) entry.expanded = !entry.expanded;
}

export function expandWorkflows(doc: TuiDocument, expanded: boolean): void {
  for (const entry of doc.entries) if (entry.kind === 'workflow') entry.expanded = expanded;
}

function roleTitle(entry: TuiEntry, language: 'zh' | 'en'): string {
  if (entry.title || entry.name) return entry.title ?? entry.name!;
  const titles = language === 'zh'
    ? { user: '你', assistant: '助手', thought: '推理', tool: '工具', compact: '上下文压缩', workflow: '工作流', error: '错误', system: '系统' }
    : { user: 'You', assistant: 'Assistant', thought: 'Reasoning', tool: 'Tool', compact: 'Context compaction', workflow: 'Workflow', error: 'Error', system: 'System' };
  return titles[entry.kind];
}

export function documentLines(doc: TuiDocument, width: number, mode: TuiThemeMode, language: 'zh' | 'en'): TuiLine[] {
  const lines: TuiLine[] = [];
  for (const entry of doc.entries) {
    const foldable = entry.kind === 'thought' || entry.kind === 'tool' || entry.kind === 'workflow' || entry.kind === 'compact';
    const marker = foldable ? `${entry.expanded ? '−' : '+'} ` : '';
    const role = entry.kind === 'user' ? '› ' : entry.kind === 'assistant' ? '◆ ' : entry.kind === 'thought' ? '◇ ' : entry.kind === 'error' ? '✗ ' : entry.kind === 'system' ? '· ' : '';
    const status = entry.status && entry.status !== 'streaming' ? ` [${entry.status}]` : '';
    const retryHint = entry.kind === 'compact' && ['failed', 'interrupted'].includes(entry.status ?? '')
      ? ` · ${language === 'zh' ? 'Ctrl-R 重试' : 'Ctrl-R to retry'}` : '';
    const heading = `${role}${marker}${roleTitle(entry, language)}${retryHint}${status}`;
    const headingRows = markdownLines(heading, width, mode);
    for (const line of headingRows) lines.push({ text: line, entryId: entry.id, ...(foldable ? { action: `toggle:${entry.id}` } : {}), ...(entry.kind === 'error' ? { tone: 'error' as const } : {}) });
    if ((entry.kind === 'thought' || entry.kind === 'tool' || entry.kind === 'workflow' || entry.kind === 'compact') && !entry.expanded) continue;

    if (entry.kind === 'workflow') {
      const meta = entry.meta ?? {};
      const settled = meta.nodesSettled ?? meta.settled;
      const total = meta.nodesTotal ?? meta.total;
      if (typeof settled === 'number' && typeof total === 'number') lines.push(...markdownLines(`  ${language === 'zh' ? '步骤' : 'Steps'}: ${settled}/${total}`, width, mode).map((text) => ({ text, entryId: entry.id })));
      if (Object.keys(record(meta.usage)).length) lines.push(...markdownLines(`  Usage: ${JSON.stringify(meta.usage)}`, width, mode).map((text) => ({ text, entryId: entry.id })));
      if (Array.isArray(meta.actors)) for (const actor of meta.actors) {
        const row = record(actor);
        lines.push(...markdownLines(`  ${firstText(row.name, row.siteId, row.id)}${row.status ? ` [${row.status}]` : ''}`, width, mode).map((text) => ({ text, entryId: entry.id })));
      }
      if (Array.isArray(meta.logTail)) for (const log of meta.logTail) lines.push(...markdownLines(`  ${text(log)}`, width, mode).map((text) => ({ text, entryId: entry.id })));
    } else if (entry.kind === 'compact') {
      const command = firstText(entry.meta?.retryCommand, entry.meta?.retry_command, '/compact');
      if (['failed', 'interrupted'].includes(entry.status ?? '')) {
        const label = `${language === 'zh' ? '↻ 点击或 Ctrl-R 重试' : '↻ Click or Ctrl-R to retry'}: ${command}`;
        lines.push(...markdownLines(label, width, mode).map((text) => ({ text, entryId: entry.id, action: `retry:${command}`, tone: 'warning' as const })));
      }
      if (entry.text) lines.push(...markdownLines(entry.text, width, mode).map((text) => ({ text, entryId: entry.id })));
    } else if (entry.kind === 'tool') {
      if (entry.path) lines.push(...markdownLines(`  ${entry.path}`, width, mode).map((text) => ({ text, entryId: entry.id })));
      if (Object.keys(entry.input ?? {}).length) lines.push(...markdownLines(`  Input: ${JSON.stringify(entry.input, null, 2)}`, width, mode).map((text) => ({ text, entryId: entry.id })));
      if (entry.diff) lines.push(...diffLines(entry.diff, width, mode).map((text) => ({ text, entryId: entry.id })));
      if (entry.output) lines.push(...markdownLines(entry.output, width, mode).map((text) => ({ text, entryId: entry.id })));
    } else if (entry.text) {
      lines.push(...markdownLines(entry.text, width, mode).map((text) => ({ text, entryId: entry.id })));
    }
  }
  return lines;
}
