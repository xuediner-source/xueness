import { isDict } from '@xueness/contracts';
import { reportedUsage } from '@xueness/providers';
import { contextItems, REQUEST_LIMIT, summarizeItems } from './context.ts';
import { opsOfCall, parseCallArgs } from './upstream-fileOps.ts';
import { lensStatistics } from './statistics.ts';
import type { ContextLensView, FileRecord, RequestRecord, Row, ToolRecord, UsageRecord } from './types.ts';

const rows = (value: unknown): Row[] => Array.isArray(value) ? value.filter(isDict) : [];
const count = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const number = (value: unknown) => count(value) ?? 0;
export function ownersFromManifests(plugins: readonly { manifest: unknown }[]): Map<string, string> {
  const owners = new Map<string, string>();
  for (const plugin of plugins) {
    if (!isDict(plugin.manifest)) continue;
    for (const tool of rows(plugin.manifest.tools)) if (typeof tool.name === 'string') owners.set(tool.name, String(plugin.manifest.id));
  }
  return owners;
}
export function usageRecords(session: Row): UsageRecord[] {
  return rows(session.provider_usage).map(row => {
    const usage = reportedUsage(row.usage), detail = isDict(usage.prompt_tokens_details) ? usage.prompt_tokens_details : {};
    const cacheValues = [usage.cache_read_input_tokens, usage.cached_tokens, detail.cached_tokens].map(count).filter((v): v is number => v !== null);
    const outputDetail = isDict(usage.completion_tokens_details) ? usage.completion_tokens_details : {};
    return { step: Number(row.step ?? 0), at: String(row.at ?? ''), model: String(row.model ?? ''), input: count(usage.prompt_tokens), output: count(usage.completion_tokens),
      cached: cacheValues.length ? Math.max(...cacheValues) : null, reasoning: count(usage.reasoning_tokens ?? outputDetail.reasoning_tokens) };
  });
}
export function toolRecords(session: Row, owners: ReadonlyMap<string, string>): { tools: ToolRecord[]; files: FileRecord[] } {
  const results = isDict(session.results) ? session.results : {}, timings = new Map(rows(session.tool_timings).map(row => [row.tool_call_id, row]));
  const tools: ToolRecord[] = [], files = new Map<string, FileRecord>(), seen = new Set<string>();
  for (const message of [...rows(session.archived_messages), ...rows(session.messages)]) for (const call of rows(message.tool_calls)) {
    if (typeof call.id !== 'string' || seen.has(call.id)) continue;
    seen.add(call.id);
    const fn = isDict(call.function) ? call.function : {}, name = String(fn.name ?? ''), args = parseCallArgs(fn.arguments) ?? {};
    const stored = results[call.id], result: Row = isDict(stored) ? stored : {}, data = isDict(result.data) ? result.data : {}, error = isDict(result.error) ? result.error : {};
    const timing = timings.get(call.id), ok = error.code === 'approval_required' ? null : typeof result.ok === 'boolean' ? result.ok : null;
    const subject = typeof args.command === 'string' && args.command ? args.command : Array.isArray(args.argv) && args.argv.length ? args.argv.join(' ') : String(args.path ?? args.file_path ?? args.pattern ?? '');
    tools.push({ id: call.id, name, owner: owners.get(name) ?? null, subject: subject.slice(0, 4000), ok, seconds: count(timing?.seconds), executionMs: count(data.durationMs), exitCode: typeof data.exitCode === 'number' ? data.exitCode : null, error: String(error.message ?? (typeof result.error === 'string' ? result.error : '')).slice(0, 2000) });
    const canonical = ({ Read: 'read', Write: 'write', Edit: 'edit', Grep: 'grep', Glob: 'glob' } as Record<string, string>)[name] ?? name;
    for (const op of opsOfCall({ seq: tools.length, tool: canonical, argsRaw: fn.arguments, err: ok === false })) {
      if (op.pattern || ok !== true) continue;
      const file = files.get(op.path) ?? { path: op.path, reads: 0, writes: 0, searches: 0, added: 0, removed: 0 };
      file[op.kind === 'read' ? 'reads' : op.kind === 'write' ? 'writes' : 'searches']++;
      file.added += op.added; file.removed += op.removed; files.set(op.path, file);
    }
  }
  return { tools, files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)) };
}
export function projectContextLens(session: Row, owners: ReadonlyMap<string, string> = new Map<string, string>()): ContextLensView {
  const items = contextItems(rows(session.messages)), requests = usageRecords(session), budget = isDict(session.runtime_budget) ? session.runtime_budget : {};
  const totals = { input: 0, output: 0, cached: 0, reported: 0, unknown: 0 };
  for (const request of requests) {
    totals.input += request.input ?? 0; totals.output += request.output ?? 0; totals.cached += request.cached ?? 0;
    if (request.input !== null && request.output !== null) totals.reported++; else totals.unknown++;
  }
  const { tools, files } = toolRecords(session, owners), events: ContextLensView['events'] = [];
  for (const event of rows(session.compactions)) events.push({ kind: 'compaction', at: String(event.at ?? event.timestamp ?? ''), detail: JSON.stringify(event).slice(0, 1800) });
  for (const event of rows(session.model_history)) events.push({ kind: 'model', at: String(event.at ?? ''), detail: JSON.stringify(event).slice(0, 1200) });
  for (const event of rows(session.permission_mode_history)) events.push({ kind: 'permission', at: String(event.at ?? ''), detail: `${String(event.from)} → ${String(event.to)}` });
  const captures = rows(session.context_lens_requests) as unknown as RequestRecord[];
  const family: ContextLensView['family'] = [{ id: String(session.id), title: String(session.title || session.task), status: String(session.status), relation: 'self' }];
  const parent = isDict(session.delegation) ? session.delegation.parentSessionId : typeof session.parent === 'string' ? session.parent : isDict(session.parent) ? session.parent.session_id : null;
  if (typeof parent === 'string') family.unshift({ id: parent, title: parent, status: '', relation: 'parent' });
  for (const task of rows(session.task_runs)) {
    const id = task.childSessionId ?? task.session_id ?? task.child_session_id;
    if (typeof id === 'string' && /^[0-9a-f]{32}$/.test(id)) family.push({ id, title: String(task.title ?? task.task ?? id), status: String(task.status ?? ''), relation: 'child' });
  }
  const counts = new Map<string, number>();
  for (const tool of tools) counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1);
  return { schema: 'xueness.context-lens.v1', id: String(session.id), title: String(session.title || session.task), status: String(session.status),
    current: { items, ...summarizeItems(items), contextWindow: count(budget.contextWindow), inputBudget: count(budget.inputBudgetTokens), hostEstimatedTokens: count(budget.estimatedInputTokens) },
    requests, captures, totals, tools: tools.slice(-800), files, events: events.sort((a, b) => a.at.localeCompare(b.at)), family,
    statistics: lensStatistics(session), toolCounts: [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    limits: { capturedRequests: captures.length, requestLimit: REQUEST_LIMIT, clippedItems: items.filter(item => item.truncated).length, toolCount: tools.length } };
}

export function sessionSummary(session: Row) {
  const requests = usageRecords(session);
  return { id: String(session.id), title: String(session.title || session.task), root: String(session.root ?? ''), status: String(session.status), requests: requests.length,
    tokens: requests.reduce((sum, row) => sum + number(row.input) + number(row.output), 0),
    lastAt: requests.at(-1)?.at ?? '', days: requests.map(row => ({ at: row.at, tokens: number(row.input) + number(row.output) })) };
}
