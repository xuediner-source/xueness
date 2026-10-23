import type { ToolRendererId, ToolRow } from './toolRenderers';

export const NATIVE_CARD_CHAR_LIMIT = 12_000;
export const NATIVE_CARD_ITEM_LIMIT = 80;
export type NativeToolPayload = { fields: { label: string; value: string }[]; lines: string[]; url?: string; truncated: boolean };
const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const number = (v: unknown): number | undefined => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
const statuses = new Set(['created', 'pending', 'queued', 'running', 'stopping', 'pausing', 'paused', 'completed', 'failed', 'cancelled', 'awaiting_user', 'blocked', 'unknown']);

/** No javascript/data/file links, credentials, query tokens or fragment secrets. */
export function safeNativeToolUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 4096 || /[\p{C}]/u.test(value)) return undefined;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return undefined;
    url.search = ''; url.hash = '';
    return url.toString();
  } catch { return undefined; }
}

/** Allowlisted display projection. Never serialize input, plans, prompts, messages,
 * child transcripts, credentials, arbitrary output objects or remote images. */
export function nativeToolPayload(kind: ToolRendererId, row: ToolRow): NativeToolPayload {
  const result: NativeToolPayload = { fields: [], lines: [], truncated: false };
  const output = record(row.output), input = record(row.input);
  let budget = NATIVE_CARD_CHAR_LIMIT;
  const text = (v: unknown, limit = 1200): string => {
    if (typeof v !== 'string') return '';
    const cap = Math.min(limit, budget);
    const clipped = v.slice(0, cap).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, '');
    if (v.length > cap) result.truncated = true;
    budget -= clipped.length;
    return clipped;
  };
  const field = (label: string, v: unknown) => { const value = text(typeof v === 'number' && number(v) !== undefined ? String(v) : v); if (value) result.fields.push({ label, value }); };
  const line = (v: unknown) => { const value = text(v, 4000); if (value) result.lines.push(value); };
  const status = (v: unknown) => typeof v === 'string' && statuses.has(v) ? v : undefined;
  const list = (v: unknown): unknown[] => {
    if (!Array.isArray(v)) return [];
    if (v.length > NATIVE_CARD_ITEM_LIMIT) result.truncated = true;
    return v.slice(0, NATIVE_CARD_ITEM_LIMIT);
  };
  if (kind === 'read') {
    field('路径', output.path ?? input.path);
    const offset = number(output.offset), total = number(output.totalChars);
    const length = typeof output.output === 'string' ? output.output.length : undefined;
    if (offset !== undefined && length !== undefined && (total === undefined || offset + length <= total)) {
      field('字符范围（从 0 开始）', `${offset}–${offset + length}`);
    }
    field('总字符数', total);
    field('下一页偏移', number(output.nextOffset));
  } else if (kind === 'files') {
    field('路径', output.path ?? input.path);
    field('搜索', output.pattern ?? input.pattern);
    field('结果数', number(output.count));
    for (const entry of list(output.output)) {
      if (typeof entry === 'string') line(entry);
      else {
        const hit = record(entry); const path = text(hit.path, 600); const n = number(hit.line);
        if (path) line(`${path}${n !== undefined ? `:${n}` : ''}${typeof hit.text === 'string' ? `  ${text(hit.text, 800)}` : ''}`);
      }
    }
  } else if (kind === 'browser') {
    field('操作', row.name);
    field('页面', output.title);
    result.url = safeNativeToolUrl(output.url ?? input.url);
    field('节点数', number(output.nodeCount));
    field('总节点数', number(output.totalNodes));
    line(output.tree ?? output.text);
    // A reference only: no network loads or inline base64 expansion.
    if (row.name === 'browser_screenshot' && output.mimeType === 'image/png'
      && typeof output.imageDataUrl === 'string' && output.imageDataUrl.startsWith('data:image/png;base64,')) field('截图', 'PNG · 当前工具结果');
  } else if (kind === 'workflow') {
    const run = record(output.workflow ?? output.job), plan = record(run.plan);
    field('运行 ID', run.id ?? input.workflow_id ?? input.job_id);
    field('名称', plan.name ?? run.name ?? output.saved_workflow);
    field('运行状态', status(run.status));
    const nodes = record(run.nodes);
    const specs = list(plan.nodes).map(record);
    const actors = specs.filter(node => node.kind === 'agent');
    if (Array.isArray(plan.nodes) && plan.nodes.length <= NATIVE_CARD_ITEM_LIMIT && specs.every(node => ['agent', 'command'].includes(String(node.kind)))) field('Actor 数', actors.length);
    let nodeCount = 0;
    for (const id in nodes) {
      if (!Object.hasOwn(nodes, id)) continue;
      if (nodeCount++ >= NATIVE_CARD_ITEM_LIMIT) { result.truncated = true; break; }
      const node = record(nodes[id]); const state = status(node.status);
      if (state) line(`${text(id, 100)} · ${state}`);
      if (state === 'awaiting_user') field('等待回答', node.question);
    }
    if (row.name === 'background_logs') line(output.output ?? output.text ?? output.stdout);
    const saved = Array.isArray(output.saved) ? output.saved : output.saved ? [output.saved] : [];
    for (const raw of list(saved)) { const item = record(raw); line(item.name); }
  } else if (kind === 'task') {
    // Launch success means the call returned, never that the child completed.
    field('任务 ID', output.task_id ?? input.task_id);
    field('记录状态', status(output.status));
    if ((row.name === 'task' || row.name === 'task_resume') && output.background === true) field('执行方式', '后台子任务');
    for (const raw of list(output.tasks)) {
      const task = record(raw); const id = text(task.id, 200); const state = status(task.status);
      if (id && state) line(`${id} · ${state}`);
    }
    const pending = list(output.pending).filter(v => typeof v === 'string');
    for (const id of pending) line(`${text(id, 200)} · pending`);
    // Child summaries/details are owned by the scoped SubagentRowView sidecar.
  }
  if (output.truncated === true) result.truncated = true;
  return result;
}
