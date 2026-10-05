import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUp, Square } from 'lucide-react';
import { XuenessComposerToolbar } from '../sessions/XuenessComposerToolbar';
import { SimpleMarkdown, TimelineCard } from '../../XuenessShell';
import { t as tr, tf } from '../../i18n';
import type { TimelineRow, WorkbenchSession } from '../../xuenessWorkbench';
import type { ComposerDraftState } from '../sessions/XuenessWorkbenchView';
import type { ComposerInput, ComposerModel } from '../../xuenessComposer';
import type { RunChoices } from '../../xuenessBridge';
import './LightweightWorkbench.css';

/**
 * 轻量档极简工作台（providers 插件功能）。
 *
 * 对标 Pi coding agent 的极简形态：选中本地轻量档时只保留与本地小模型运行
 * 直接相关的界面。输入区单行起步自动增高、时间线紧凑折叠（连续只读工具自动
 * 合并分组、思考过程折叠）、极简状态行显示真实模型名/工作区/已报告 Token 用量。
 */

export type LightweightContextUsage = { used: number; max: number };

/** 会话运行预算中的估算输入与输入预算；没有真实可用的数值时不编造用量。 */
export function lightweightContextUsage(
  budget: WorkbenchSession['runtime_budget'],
): LightweightContextUsage | undefined {
  const used = budget?.estimatedInputTokens;
  const max = budget?.inputBudgetTokens;
  const usable = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0;
  return usable(used) && usable(max) ? { used, max } : undefined;
}

/** 轻量极简布局只在 providers 插件生效且当前运行档位为轻量时启用。 */
export function lightweightLayoutActive(
  runtimeProfile: string | null | undefined,
  providersEffective: boolean,
): boolean {
  return providersEffective && runtimeProfile === 'lightweight';
}

export type LightweightComposerControlsProps = {
  /** Fail-closed：providers 插件未生效时不渲染任何轻量档界面。 */
  enabled: boolean;
  choices: RunChoices;
  onChange(patch: Partial<RunChoices>): void;
  models: ComposerModel[];
  loading: boolean;
  error: string;
  onReload(): void;
  onManageModels(): void;
  runtimeBudget?: WorkbenchSession['runtime_budget'];
  pauseReason?: string | null;
  disabled?: boolean;
};

/**
 * 轻量档输入框控制区：只保留模型名（菜单内含「标准 / 本地轻量」切换，用于
 * 切回标准档）与上下文用量。模式、浏览器、后台任务、思考强度等通用工具条
 * 全部隐藏；用量为估算读数，不打开用量面板。
 */
export function LightweightComposerControls({
  enabled,
  choices,
  onChange,
  models,
  loading,
  error,
  onReload,
  onManageModels,
  runtimeBudget,
  pauseReason,
  disabled = false,
}: LightweightComposerControlsProps): React.JSX.Element | null {
  if (!enabled) return null;
  return <XuenessComposerToolbar
    minimal
    choices={choices}
    onChange={onChange}
    models={models}
    loading={loading}
    error={error}
    onReload={onReload}
    onManageModels={onManageModels}
    contextUsage={lightweightContextUsage(runtimeBudget)}
    runtimeBudget={runtimeBudget}
    pauseReason={pauseReason}
    disabled={disabled}
  />;
}

// ---------------------------------------------------------------------------
// 极简状态行 (Pi-style Footer)
// ---------------------------------------------------------------------------

export type LightweightReportedUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

/**
 * 累加服务商真实报告的用量，没有合法报告时返回 null，不编造用量。
 */
export function extractReportedUsage(records: unknown): LightweightReportedUsage | null {
  if (!records) return null;
  // 支持传入单条用量记录对象（如 { prompt_tokens, completion_tokens } 或 { usage: { ... } }）
  if (typeof records === 'object' && !Array.isArray(records)) {
    const obj = records as Record<string, unknown>;
    const bucket = (obj.usage && typeof obj.usage === 'object' && !Array.isArray(obj.usage))
      ? (obj.usage as Record<string, unknown>)
      : obj;
    const input = bucket.prompt_tokens ?? bucket.input_tokens;
    const output = bucket.completion_tokens ?? bucket.output_tokens;
    if (typeof input === 'number' && Number.isFinite(input) && input >= 0 &&
        typeof output === 'number' && Number.isFinite(output) && output >= 0) {
      return { inputTokens: input, outputTokens: output, totalTokens: input + output };
    }
    return null;
  }
  if (!Array.isArray(records) || records.length === 0) return null;
  let inputTokens = 0;
  let outputTokens = 0;
  let validCount = 0;
  for (const record of records) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) continue;
    const usage = (record as Record<string, unknown>).usage;
    if (!usage || typeof usage !== 'object' || Array.isArray(usage)) continue;
    const bucket = usage as Record<string, unknown>;
    const input = bucket.prompt_tokens ?? bucket.input_tokens;
    const output = bucket.completion_tokens ?? bucket.output_tokens;
    if (typeof input === 'number' && Number.isFinite(input) && input >= 0 &&
        typeof output === 'number' && Number.isFinite(output) && output >= 0) {
      inputTokens += input;
      outputTokens += output;
      validCount++;
    }
  }
  return validCount > 0 ? { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens } : null;
}

/**
 * 缩写工作区路径（对标 Pi 的 formatCwdForFooter：Home 转 ~，超长取最后 2 级）。
 */
export function abbreviatePath(path: string | null | undefined): string {
  if (!path || typeof path !== 'string' || !path.trim()) return '—';
  const trimmed = path.trim();
  const homeMatch = trimmed.match(/^(?:\/home\/[^/]+|\/Users\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)(.*)$/);
  if (homeMatch) {
    const rest = homeMatch[1];
    return rest ? `~${rest}` : '~';
  }
  const parts = trimmed.split(/[/\\]+/).filter(Boolean);
  if (parts.length > 2) {
    return `…/${parts.slice(-2).join('/')}`;
  }
  return trimmed;
}

/**
 * 紧凑格式化 Token 计数（如 1.2k, 500），缺失时返回「—」。
 */
export function formatTokens(count: number | null | undefined): string {
  if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) return '—';
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

export type LightweightStatusBarProps = {
  modelName?: string | null;
  workspaceRoot?: string | null;
  reportedUsage?: LightweightReportedUsage | null;
  status?: string;
  isNarrow?: boolean;
};

/**
 * 极简状态行（Pi 风格底部 footer）：只展示当前模型名、工作区路径缩写、
 * 真实报告的 Token 用量（缺失显示「—」）和当前运行状态。
 */
export function LightweightStatusBar({
  modelName,
  workspaceRoot,
  reportedUsage,
  status = 'idle',
  isNarrow,
}: LightweightStatusBarProps): React.JSX.Element {
  const [narrowAuto, setNarrowAuto] = useState(() => {
    if (typeof isNarrow === 'boolean') return isNarrow;
    return typeof window !== 'undefined' && Boolean(window.matchMedia?.('(max-width: 639.98px)').matches);
  });

  useEffect(() => {
    if (typeof isNarrow === 'boolean') {
      setNarrowAuto(isNarrow);
      return;
    }
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mql = window.matchMedia('(max-width: 639.98px)');
    const handler = (e: MediaQueryListEvent) => setNarrowAuto(e.matches);
    mql.addEventListener?.('change', handler);
    return () => mql.removeEventListener?.('change', handler);
  }, [isNarrow]);

  const pathDisplay = abbreviatePath(workspaceRoot);
  const modelDisplay = modelName?.trim() || '—';

  let tokenDisplay = '—';
  if (reportedUsage && (typeof reportedUsage.inputTokens === 'number' || typeof reportedUsage.outputTokens === 'number')) {
    const inTokens = formatTokens(reportedUsage.inputTokens);
    const outTokens = formatTokens(reportedUsage.outputTokens);
    tokenDisplay = `↑${inTokens} ↓${outTokens}`;
  }

  const isRunning = status === 'running' || status === 'streaming';
  const isError = status === 'error' || status === 'provider_error';
  const isPaused = status === 'paused' || status === 'needs_review';
  const isPending = status === 'pending';

  const statusLabel =
    isRunning ? tr('运行中') :
    isPaused ? tr('已暂停') :
    isError ? tr('出错了') :
    isPending ? tr('等待中') :
    status === 'completed' ? tr('已完成') : tr('空闲');

  const statusDotClass =
    isRunning ? 'xn-lightweight-status__dot--running' :
    isError ? 'xn-lightweight-status__dot--error' :
    isPaused ? 'xn-lightweight-status__dot--paused' :
    isPending ? 'xn-lightweight-status__dot--paused' :
    'xn-lightweight-status__dot--idle';

  const isNarrowActive = typeof isNarrow === 'boolean' ? isNarrow : narrowAuto;

  return (
    <footer
      className={`xn-lightweight-statusbar${isNarrowActive ? ' xn-lightweight-statusbar--narrow' : ''}`}
      data-testid="lightweight-statusbar"
      role="status"
      aria-label={tr('轻量模式状态行')}
    >
      <div className="xn-lightweight-statusbar__left">
        <span className="xn-lightweight-statusbar__item xn-lightweight-statusbar__cwd" title={workspaceRoot ?? undefined}>
          {pathDisplay}
        </span>
        <span className="xn-lightweight-statusbar__sep" aria-hidden="true">•</span>
        <span className="xn-lightweight-statusbar__item xn-lightweight-statusbar__model" title={modelDisplay}>
          {modelDisplay}
        </span>
        <span className="xn-lightweight-statusbar__sep" aria-hidden="true">•</span>
        <span className="xn-lightweight-statusbar__item xn-lightweight-statusbar__tokens">
          {tokenDisplay}
        </span>
      </div>
      <div className="xn-lightweight-statusbar__right">
        <span className={`xn-lightweight-status__dot ${statusDotClass}`} aria-hidden="true" />
        <span className="xn-lightweight-statusbar__status-text">{statusLabel}</span>
      </div>
    </footer>
  );
}

// ---------------------------------------------------------------------------
// 紧凑时间线 (Compact Timeline & Merged Tool Calls)
// ---------------------------------------------------------------------------

const READ_ONLY_TOOLS = new Set([
  'read', 'list', 'glob', 'grep', 'search', 'tool_search',
  'tool_result_read', 'cat', 'view_file', 'list_dir', 'grep_search',
  'find_by_name', 'web_search', 'web_fetch', 'todo_read', 'file_search',
  'subagent_status',
]);

export function isReadOnlyTool(name: string): boolean {
  if (!name || typeof name !== 'string') return false;
  const lower = name.toLowerCase().trim();
  if (READ_ONLY_TOOLS.has(lower)) return true;
  if (
    lower.startsWith('read_') ||
    lower.startsWith('get_') ||
    lower.startsWith('search_') ||
    lower.startsWith('list_') ||
    lower.startsWith('inspect_') ||
    lower.startsWith('fetch_') ||
    lower.startsWith('view_') ||
    lower.startsWith('web_') ||
    lower.endsWith('_read') ||
    lower.endsWith('_search') ||
    lower.endsWith('_status') ||
    lower.endsWith('_list')
  ) return true;
  return false;
}

export function extractToolKeySummary(name: string, subject?: string, input?: Record<string, unknown>): string {
  const toolName = name.toLowerCase().trim();
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    if (['read', 'read_file', 'write', 'write_to_file', 'edit', 'view_file', 'replace_file_content', 'list', 'list_dir'].includes(toolName)) {
      const path = input.file_path ?? input.filePath ?? input.path ?? input.target ?? input.filename ?? input.TargetFile ?? input.SearchDirectory ?? input.directory ?? input.dir;
      if (typeof path === 'string' && path) return path;
    }
    if (['exec', 'run_command', 'bash', 'shell'].includes(toolName)) {
      const cmd = input.command ?? input.cmd ?? input.CommandLine ?? input.commandLine;
      if (typeof cmd === 'string' && cmd) return cmd;
      const argv = input.argv ?? input.args;
      if (Array.isArray(argv)) return argv.join(' ');
    }
    if (['grep', 'grep_search', 'search', 'search_web', 'find_by_name', 'tool_search', 'web_search', 'glob'].includes(toolName)) {
      const q = input.query ?? input.Query ?? input.keywords ?? input.keyword ?? input.Pattern ?? input.pattern;
      if (typeof q === 'string' && q) return q;
    }
    if (['web_fetch', 'read_url_content'].includes(toolName)) {
      const url = input.url ?? input.Url ?? input.target_url;
      if (typeof url === 'string' && url) return url;
    }
    if (toolName === 'tool_result_read') {
      const callId = input.call_id ?? input.callId ?? input.id;
      if (typeof callId === 'string' && callId) return callId;
    }
    if (toolName === 'ask_user') {
      const q = input.question ?? input.prompt;
      if (typeof q === 'string' && q) return q;
    }
    if (toolName === 'todo_read' || toolName === 'todo_write') {
      const title = input.title ?? input.task ?? input.id;
      if (typeof title === 'string' && title) return title;
    }
    const entries = Object.entries(input);
    if (entries.length > 0) {
      const pairs = entries.slice(0, 2).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`);
      return pairs.join(' ');
    }
  }
  if (subject && typeof subject === 'string') {
    try {
      if (subject.startsWith('{') || subject.startsWith('[')) {
        const parsed = JSON.parse(subject);
        if (Array.isArray(parsed)) return parsed.join(' ');
        if (typeof parsed === 'object' && parsed !== null) {
          return extractToolKeySummary(name, undefined, parsed as Record<string, unknown>);
        }
      }
    } catch {
      // not JSON
    }
    return subject.trim();
  }
  return '';
}

export function formatToolDuration(durationMs?: number | null): string | null {
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0) return null;
  return durationMs < 1000 ? `${Math.round(durationMs)}ms` : `${(durationMs / 1000).toFixed(1)}s`;
}

export function toolStatusLabel(status: string): string {
  switch (status) {
    case 'ok':
      return tr('已完成');
    case 'running':
      return tr('运行中');
    case 'error':
      return tr('失败');
    case 'cancelled':
      return tr('已取消');
    default:
      return status;
  }
}

type ToolRowType = Extract<TimelineRow, { kind: 'tool' }> & {
  input?: Record<string, unknown>;
  output?: unknown;
  durationMs?: number;
};

export type LightweightGroupedEntry =
  | { kind: 'read-only-group'; rows: ToolRowType[]; id: string }
  | { kind: 'tool'; row: ToolRowType; id: string }
  | { kind: 'user'; row: Extract<TimelineRow, { kind: 'user' }>; id: string }
  | { kind: 'assistant'; row: Extract<TimelineRow, { kind: 'assistant' }>; id: string }
  | { kind: 'completion'; row: Extract<TimelineRow, { kind: 'completion' }>; id: string }
  | { kind: 'other'; row: TimelineRow; id: string };

/**
 * 将时间线行紧凑化分组：连续 2 个及以上的只读工具调用合并为一个组，
 * 其余保持独立。
 */
export function groupLightweightTimelineRows(rows: TimelineRow[]): LightweightGroupedEntry[] {
  const result: LightweightGroupedEntry[] = [];
  let i = 0;
  while (i < rows.length) {
    const row = rows[i];
    if (row.kind === 'tool' && isReadOnlyTool(row.name)) {
      const group: ToolRowType[] = [row as ToolRowType];
      let j = i + 1;
      while (j < rows.length && rows[j].kind === 'tool' && isReadOnlyTool((rows[j] as ToolRowType).name)) {
        group.push(rows[j] as ToolRowType);
        j++;
      }
      if (group.length > 1) {
        result.push({ kind: 'read-only-group', rows: group, id: `ro-group-${group[0].seq}-${group.length}` });
      } else {
        result.push({ kind: 'tool', row: row as ToolRowType, id: `tool-${row.seq}` });
      }
      i = j;
    } else if (row.kind === 'tool') {
      result.push({ kind: 'tool', row: row as ToolRowType, id: `tool-${row.seq}` });
      i++;
    } else if (row.kind === 'user') {
      result.push({ kind: 'user', row, id: `user-${row.seq}` });
      i++;
    } else if (row.kind === 'assistant') {
      result.push({ kind: 'assistant', row, id: `assistant-${row.seq}` });
      i++;
    } else if (row.kind === 'completion') {
      result.push({ kind: 'completion', row, id: `completion-${row.seq}` });
      i++;
    } else {
      result.push({ kind: 'other', row, id: `${row.kind}-${(row as { seq?: number }).seq ?? i}` });
      i++;
    }
  }
  return result;
}

function stringifyData(val: unknown): string {
  if (typeof val === 'string') return val;
  if (val === undefined) return '';
  try {
    return JSON.stringify(val, null, 2);
  } catch {
    return String(val);
  }
}

export type LightweightToolRowProps = {
  row: ToolRowType;
  defaultOpen?: boolean;
};

/** 单行工具卡片：默认折叠为单行，点击/回车展开详情 */
export function LightweightToolRow({ row, defaultOpen = false }: LightweightToolRowProps): React.JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
  const summary = extractToolKeySummary(row.name, row.subject, row.input);
  const status = row.status ?? 'ok';
  const statusLabel = toolStatusLabel(status);
  const duration = formatToolDuration(row.durationMs);

  const inputText = row.input ? stringifyData(row.input) : '';
  const outputText = row.output !== undefined ? stringifyData(row.output) : '';
  const errorText = row.error
    ? `${row.errorCode ? `[${row.errorCode}] ` : ''}${row.error}`
    : status === 'error' ? tr('工具执行失败') : '';

  return (
    <details
      className="xn-lightweight-tool"
      data-testid={`lightweight-tool-${row.seq}`}
      data-tool-name={row.name}
      data-status={status}
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary
        className="xn-lightweight-tool__summary"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            setOpen((prev) => !prev);
          }
        }}
      >
        <span className="xn-lightweight-tool__name">{row.name}</span>
        {summary && <span className="xn-lightweight-tool__args" title={summary}>{summary}</span>}
        <span className="xn-lightweight-tool__status" data-status={status}>{statusLabel}</span>
        {duration && <span className="xn-lightweight-tool__duration">{duration}</span>}
      </summary>
      <div className="xn-lightweight-tool__details">
        {inputText && (
          <section className="xn-lightweight-tool__section">
            <span className="xn-lightweight-tool__section-label">{tr('输入参数')}</span>
            <pre className="xn-lightweight-tool__pre">{inputText}</pre>
          </section>
        )}
        {outputText && (
          <section className="xn-lightweight-tool__section">
            <span className="xn-lightweight-tool__section-label">{tr('工具结果')}</span>
            <pre className="xn-lightweight-tool__pre">{outputText}</pre>
          </section>
        )}
        {errorText && <div className="xn-lightweight-tool__error">{errorText}</div>}
      </div>
    </details>
  );
}

export type LightweightToolGroupProps = {
  rows: ToolRowType[];
  defaultOpen?: boolean;
};

/** 连续只读工具调用的合并折叠组 */
export function LightweightToolGroup({ rows, defaultOpen = false }: LightweightToolGroupProps): React.JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
  const count = rows.length;
  const anyError = rows.some((r) => r.status === 'error');
  const anyRunning = rows.some((r) => r.status === 'running');
  const groupStatus = anyError ? 'error' : anyRunning ? 'running' : 'ok';
  const groupStatusLabel = toolStatusLabel(groupStatus);

  const toolNames = Array.from(new Set(rows.map((r) => r.name))).join(', ');

  return (
    <details
      className="xn-lightweight-tool-group"
      data-testid="lightweight-tool-group"
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary
        className="xn-lightweight-tool-group__summary"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            setOpen((prev) => !prev);
          }
        }}
      >
        <span className="xn-lightweight-tool-group__title">{tf('只读操作 ({0})', [count])}</span>
        <span className="xn-lightweight-tool-group__preview">{toolNames}</span>
        <span className="xn-lightweight-tool-group__status" data-status={groupStatus}>{groupStatusLabel}</span>
      </summary>
      <div className="xn-lightweight-tool-group__items">
        {rows.map((r) => (
          <LightweightToolRow key={r.seq} row={r} />
        ))}
      </div>
    </details>
  );
}

/** 思考过程折叠组件：默认折叠，Enter 或点击展开/折叠 */
export function LightweightReasoning({
  reasoning,
  streaming = false,
  defaultOpen = false,
}: {
  reasoning: string;
  streaming?: boolean;
  defaultOpen?: boolean;
}): React.JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <details
      className="xn-lightweight-reasoning"
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary
        className="xn-lightweight-reasoning__summary"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            setOpen((prev) => !prev);
          }
        }}
      >
        {streaming ? tr('思考中…') : tr('思考过程')}
      </summary>
      <pre className="xn-lightweight-reasoning__text">{reasoning}</pre>
    </details>
  );
}

export type LightweightTimelineProps = {
  rows: TimelineRow[];
  streamingPending?: boolean;
  emptyText?: string;
  className?: string;
};

/**
 * 轻量紧凑时间线：
 * - 工具调用默认折叠为单行（工具名 + 关键参数摘要 + 状态 + 耗时）
 * - 连续只读工具调用自动合并为一个组
 * - 思考内容默认折叠
 */
export function LightweightTimeline({
  rows,
  streamingPending = false,
  emptyText = tr('暂无事件'),
  className = '',
}: LightweightTimelineProps): React.JSX.Element {
  const grouped = React.useMemo(() => groupLightweightTimelineRows(rows ?? []), [rows]);

  if (!rows || rows.length === 0) {
    if (streamingPending) {
      return (
        <div className="xn-lightweight-timeline xn-lightweight-empty" data-testid="lightweight-timeline-loading">
          <p className="xn-lightweight-stream-status" role="status">{tr('正在生成回复…')}</p>
        </div>
      );
    }
    return (
      <div className="xn-lightweight-timeline xn-lightweight-empty" data-testid="lightweight-timeline-empty">
        <p>{emptyText}</p>
      </div>
    );
  }

  return (
    <div
      className={`xn-lightweight-timeline${className ? ` ${className}` : ''}`}
      data-testid="lightweight-timeline"
      aria-label={tr('紧凑时间线')}
    >
      {grouped.map((entry) => {
        if (entry.kind === 'read-only-group') {
          return <LightweightToolGroup key={entry.id} rows={entry.rows} />;
        }
        if (entry.kind === 'tool') {
          return <LightweightToolRow key={entry.id} row={entry.row} />;
        }
        if (entry.kind === 'user') {
          return (
            <div
              key={entry.id}
              className="xn-lightweight-msg xn-lightweight-msg--user"
              data-testid={`timeline-item-user-${entry.row.seq}`}
              data-role="user"
            >
              <div className="xn-lightweight-msg__bubble">{entry.row.text}</div>
            </div>
          );
        }
        if (entry.kind === 'assistant') {
          const r = entry.row;
          return (
            <div
              key={entry.id}
              className="xn-lightweight-msg xn-lightweight-msg--assistant"
              data-testid={`timeline-item-assistant-${r.seq}`}
              data-role="assistant"
            >
              {r.reasoning && (
                <LightweightReasoning reasoning={r.reasoning} streaming={r.streaming} />
              )}
              {r.text?.trim() ? (
                <div className="xn-lightweight-msg__prose">
                  <SimpleMarkdown text={r.text} />
                </div>
              ) : r.streaming ? (
                <p className="xn-lightweight-stream-status" role="status">{tr('正在生成回复…')}</p>
              ) : null}
            </div>
          );
        }
        if (entry.kind === 'completion') {
          return (
            <div
              key={entry.id}
              className="xn-lightweight-msg xn-lightweight-msg--completion"
              data-testid={`timeline-item-completion-${entry.row.seq}`}
            >
              <TimelineCard role="completion" status={entry.row.verified ? 'ok' : 'warn'} body={entry.row.summary || tr('运行结束')} seq={entry.row.seq} />
            </div>
          );
        }
        return null;
      })}
      {streamingPending && !rows.some((row) => row.kind === 'assistant' && row.streaming) && (
        <div className="xn-lightweight-streaming" data-testid="lightweight-timeline-streaming">
          <span className="xn-lightweight-streaming-dot" />
          <span className="xn-lightweight-streaming-dot" />
          <span className="xn-lightweight-streaming-dot" />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 极简输入框与键盘优先操作 (Lightweight Composer & Keyboard First)
// ---------------------------------------------------------------------------

/**
 * 滚动时间线视口到底部（清屏式滚到底）。
 */
export function scrollToTimelineBottom(): void {
  const scroller = typeof document === 'undefined' ? null : document.querySelector<HTMLElement>(
    '.xn-session-timeline-viewport__scroll, [data-testid="session-timeline-scroller"], .xn-conversation__stream'
  );
  if (scroller) {
    scroller.scrollTop = scroller.scrollHeight;
  }
}

export type LightweightComposerKeyAction =
  | 'clear_screen'
  | 'stop'
  | 'history_prev'
  | 'history_next'
  | 'send'
  | 'newline'
  | null;

export function evaluateLightweightComposerKey(
  e: {
    key: string;
    shiftKey?: boolean;
    ctrlKey?: boolean;
    metaKey?: boolean;
    keyCode?: number;
    isComposing?: boolean;
    nativeEvent?: { isComposing?: boolean };
  },
  context: { text: string; historyIndex: number | null; historyCount: number; running: boolean; stopping: boolean }
): LightweightComposerKeyAction {
  if (e.isComposing || e.nativeEvent?.isComposing || e.keyCode === 229) return null;
  if ((e.ctrlKey || e.metaKey) && (e.key === 'l' || e.key === 'L')) {
    return 'clear_screen';
  }
  if (e.key === 'Escape') {
    return context.running && !context.stopping ? 'stop' : null;
  }
  if (e.key === 'ArrowUp') {
    if (context.historyCount > 0) {
      if (context.historyIndex === null && context.text.trim() === '') return 'history_prev';
      if (context.historyIndex !== null && context.historyIndex > 0) return 'history_prev';
    }
    return null;
  }
  if (e.key === 'ArrowDown') {
    if (context.historyIndex !== null && context.historyCount > 0) return 'history_next';
    return null;
  }
  if (e.key === 'Enter') {
    return e.shiftKey ? 'newline' : 'send';
  }
  return null;
}

export type LightweightComposerProps = {
  draftKey?: string;
  draftStore?: React.MutableRefObject<Map<string, ComposerDraftState>>;
  onSend?(text: string, draft?: ComposerInput): void | Promise<unknown>;
  onStop?(): void;
  disabled?: boolean;
  sendDisabled?: boolean;
  running?: boolean;
  stopping?: boolean;
  queueWhenRunning?: boolean;
  queueBusy?: boolean;
  placeholder?: string;
  historyMessages?: string[];
  onClearScreen?(): void;
  controls?: React.ReactNode;
  inputRef?: React.Ref<HTMLTextAreaElement>;
  autoFocus?: boolean;
};

/**
 * 轻量极简输入区：
 * - 单行起步自动增高
 * - Enter 发送 / Shift+Enter 换行
 * - Esc 中断运行中的回合（复用 onStop）
 * - 运行中继续输入进入排队发送
 * - Up/Down 在空输入框中调出本会话历史输入
 * - Ctrl/Cmd+L 清屏式滚到底
 */
export function LightweightComposer({
  draftKey = 'default',
  draftStore,
  onSend,
  onStop,
  disabled = false,
  sendDisabled = false,
  running = false,
  stopping = false,
  queueWhenRunning = false,
  queueBusy = false,
  placeholder = tr('输入消息（Enter 发送，Shift+Enter 换行，Esc 中断）'),
  historyMessages = [],
  onClearScreen = scrollToTimelineBottom,
  controls,
  inputRef,
  autoFocus = false,
}: LightweightComposerProps): React.JSX.Element {
  const initialText = draftStore?.current.get(draftKey)?.text ?? '';
  const [text, setTextState] = useState(initialText);
  const localInputRef = useRef<HTMLTextAreaElement | null>(null);

  // 历史浏览游标：null 表示不在浏览历史，数字表示浏览中的历史索引
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const draftBeforeHistoryRef = useRef<string>('');
  const isComposingRef = useRef<boolean>(false);

  const validHistory = React.useMemo(
    () => historyMessages.filter((m) => typeof m === 'string' && m.trim().length > 0),
    [historyMessages],
  );

  const attachRef = useCallback((el: HTMLTextAreaElement | null) => {
    localInputRef.current = el;
    if (typeof inputRef === 'function') inputRef(el);
    else if (inputRef && typeof inputRef === 'object') {
      (inputRef as React.MutableRefObject<HTMLTextAreaElement | null>).current = el;
    }
  }, [inputRef]);

  const updateText = useCallback((nextText: string) => {
    setTextState(nextText);
    if (draftStore && draftKey) {
      const current = draftStore.current.get(draftKey);
      if (current) {
        draftStore.current.set(draftKey, { ...current, text: nextText, revision: current.revision + 1 });
      } else {
        draftStore.current.set(draftKey, {
          text: nextText,
          revision: 1,
          attachments: [],
          goal: false,
          selectedContext: { files: [], sessions: [], skills: [], plugins: [] },
          submissionError: '',
          attachmentError: '',
        });
      }
    }
  }, [draftStore, draftKey]);

  // 单行起步，根据输入内容自动增高（最大 160px）
  useEffect(() => {
    const el = localInputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const scrollHeight = el.scrollHeight;
    const nextHeight = Math.min(Math.max(scrollHeight, 24), 160);
    el.style.height = `${nextHeight}px`;
    el.style.overflowY = scrollHeight > 160 ? 'auto' : 'hidden';
  }, [text]);

  const isSendDisabled =
    disabled ||
    sendDisabled ||
    (running ? (!queueWhenRunning || queueBusy) : false) ||
    !text.trim();

  const handleSend = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed || isSendDisabled || stopping || !onSend) return;

    const inputData: ComposerInput = {
      attachments: [],
      files: [],
      sessions: [],
      skills: [],
      plugins: [],
      goal: false,
    };

    updateText('');
    setHistoryIndex(null);
    draftBeforeHistoryRef.current = '';

    try {
      await onSend(trimmed, inputData);
    } catch {
      // 失败时恢复草稿
      updateText(trimmed);
    }
  }, [text, isSendDisabled, stopping, onSend, updateText]);

  const setCursorToEnd = useCallback(() => {
    if (typeof requestAnimationFrame !== 'undefined') {
      requestAnimationFrame(() => {
        const el = localInputRef.current;
        if (el) {
          const len = el.value.length;
          el.setSelectionRange(len, len);
        }
      });
    }
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (isComposingRef.current) return;

    const action = evaluateLightweightComposerKey(e, {
      text,
      historyIndex,
      historyCount: validHistory.length,
      running,
      stopping,
    });

    if (action === 'clear_screen') {
      e.preventDefault();
      onClearScreen();
      return;
    }

    if (action === 'stop') {
      e.preventDefault();
      onStop?.();
      return;
    }

    if (action === 'history_prev') {
      e.preventDefault();
      if (validHistory.length > 0) {
        if (historyIndex === null) {
          draftBeforeHistoryRef.current = text;
          const target = validHistory.length - 1;
          setHistoryIndex(target);
          updateText(validHistory[target]);
          setCursorToEnd();
        } else if (historyIndex > 0) {
          const target = historyIndex - 1;
          setHistoryIndex(target);
          updateText(validHistory[target]);
          setCursorToEnd();
        }
      }
      return;
    }

    if (action === 'history_next') {
      e.preventDefault();
      if (historyIndex !== null && validHistory.length > 0) {
        if (historyIndex < validHistory.length - 1) {
          const target = historyIndex + 1;
          setHistoryIndex(target);
          updateText(validHistory[target]);
          setCursorToEnd();
        } else {
          setHistoryIndex(null);
          updateText(draftBeforeHistoryRef.current);
          setCursorToEnd();
        }
      }
      return;
    }

    if (action === 'send') {
      e.preventDefault();
      void handleSend();
      return;
    }
  };

  return (
    <div className="xn-lightweight-composer" data-testid="lightweight-composer">
      <div className="xn-lightweight-composer__input-wrap">
        <textarea
          ref={attachRef}
          className="xn-lightweight-composer__textarea"
          value={text}
          onChange={(e) => {
            updateText(e.target.value);
            if (historyIndex !== null) setHistoryIndex(null);
          }}
          onKeyDown={handleKeyDown}
          onCompositionStart={() => {
            isComposingRef.current = true;
          }}
          onCompositionEnd={() => {
            isComposingRef.current = false;
          }}
          placeholder={placeholder}
          rows={1}
          disabled={disabled}
          autoFocus={autoFocus}
          aria-label={placeholder}
          data-testid="lightweight-composer-input"
        />
        <div className="xn-lightweight-composer__actions">
          {running && onStop && (
            <button
              type="button"
              className="xn-lightweight-composer__btn xn-lightweight-composer__btn--stop"
              disabled={stopping}
              aria-label={stopping ? tr('正在停止') : tr('停止')}
              title={stopping ? tr('正在停止') : tr('停止当前任务')}
              data-testid="composer-stop"
              onClick={onStop}
            >
              <Square size={13} aria-hidden="true" />
            </button>
          )}
          {running && queueWhenRunning ? (
            <button
              type="button"
              className="xn-lightweight-composer__btn xn-lightweight-composer__btn--send"
              disabled={isSendDisabled}
              aria-label={tr('加入队列')}
              title={tr('加入队列')}
              data-testid="composer-queue"
              onClick={() => void handleSend()}
            >
              <ArrowUp size={14} aria-hidden="true" />
            </button>
          ) : !running ? (
            <button
              type="button"
              className="xn-lightweight-composer__btn xn-lightweight-composer__btn--send"
              disabled={isSendDisabled}
              aria-label={tr('发送')}
              title={tr('发送')}
              data-testid="composer-send"
              onClick={() => void handleSend()}
            >
              <ArrowUp size={14} aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </div>
      {controls && (
        <div className="xn-lightweight-composer__controls">
          {controls}
        </div>
      )}
    </div>
  );
}
