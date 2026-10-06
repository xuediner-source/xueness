import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ArrowUp, Square } from 'lucide-react';
import { XuenessComposerToolbar } from '../sessions/XuenessComposerToolbar';
import { completionPresentation } from '../sessions/completionPresentation';
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
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
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
  inputRef,
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
    inputRef={inputRef}
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
  /** 中断请求已发出、尚未收到终态：标准档靠按钮禁用表达，极简状态行同样要说出来。 */
  stopping?: boolean;
  /** 本轮流式输出被中断（session.streaming.status === 'interrupted'）。 */
  interrupted?: boolean;
  /** 待发送的排队消息条数。 */
  queueCount?: number;
  isNarrow?: boolean;
};

export type LightweightStatusTone = 'idle' | 'running' | 'paused' | 'error' | 'done';

export type LightweightStatusPresentation = { label: string; tone: LightweightStatusTone };

/**
 * 把会话状态映射成极简状态行的读数，词表与标准档保持一致（侧栏 StatusDot、
 * SessionQueue、命令面板使用同一批状态字符串）。未知状态回落为空闲文案，
 * 不虚构状态。
 */
export function lightweightStatusPresentation(
  status?: string | null,
  context: { stopping?: boolean; interrupted?: boolean; queueCount?: number } = {},
): LightweightStatusPresentation {
  const value = typeof status === 'string' ? status.trim() : '';
  if (context.stopping) return { label: tr('正在停止'), tone: 'running' };
  if (value === 'running' || value === 'streaming' || value === 'stopping') return { label: tr('运行中'), tone: 'running' };
  if (value === 'pending' || value === 'queued') return { label: tr('等待中'), tone: 'paused' };
  if (value === 'paused') return { label: tr('已暂停'), tone: 'paused' };
  if (value === 'needs_review') return { label: tr('需要审核'), tone: 'paused' };
  if (value === 'awaiting_user') return { label: tr('等待用户'), tone: 'paused' };
  if (value === 'stalled') return { label: tr('运行停滞'), tone: 'paused' };
  if (value === 'interrupted' || context.interrupted) return { label: tr('已中断'), tone: 'paused' };
  if (value === 'error' || value === 'failed' || value === 'provider_error') return { label: tr('出错了'), tone: 'error' };
  if (value === 'cancelled') return { label: tr('已取消'), tone: 'idle' };
  if (value === 'completed') return { label: tr('已完成'), tone: 'done' };
  if ((context.queueCount ?? 0) > 0) return { label: tr('队列中'), tone: 'paused' };
  return { label: tr('空闲'), tone: 'idle' };
}

const STATUS_DOT_CLASS: Record<LightweightStatusTone, string> = {
  running: 'xn-lightweight-status__dot--running',
  error: 'xn-lightweight-status__dot--error',
  paused: 'xn-lightweight-status__dot--paused',
  done: 'xn-lightweight-status__dot--done',
  idle: 'xn-lightweight-status__dot--idle',
};

/** 状态行右侧读数：状态本身，外加排队条数（不编造没有的队列）。 */
export function lightweightStatusReadout(
  presentation: LightweightStatusPresentation,
  queueCount?: number,
): string {
  return (queueCount ?? 0) > 0
    ? `${presentation.label} · ${tf('队列 {0}', [queueCount])}`
    : presentation.label;
}

/**
 * 极简状态行（Pi 风格底部 footer）：只展示当前模型名、工作区路径缩写、
 * 真实报告的 Token 用量（缺失显示「—」）和当前运行状态。
 *
 * 读数区是 `role="region"` 地标，屏幕阅读器可以主动浏览但不自动播报；只有
 * 右侧状态读数在 polite 实时区内，且 `aria-atomic` 保证状态翻转时只念这一句。
 * Token 用量与路径每轮都可能变，刻意留在实时区外，避免持续打断朗读。
 */
export function LightweightStatusBar({
  modelName,
  workspaceRoot,
  reportedUsage,
  status = 'idle',
  stopping = false,
  interrupted = false,
  queueCount,
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
  let tokenSpeech = tr('暂无报告用量');
  if (reportedUsage && (typeof reportedUsage.inputTokens === 'number' || typeof reportedUsage.outputTokens === 'number')) {
    const inTokens = formatTokens(reportedUsage.inputTokens);
    const outTokens = formatTokens(reportedUsage.outputTokens);
    tokenDisplay = `↑${inTokens} ↓${outTokens}`;
    tokenSpeech = tf('服务报告的 Token 用量：输入 {0}，输出 {1}', [inTokens, outTokens]);
  }

  const presentation = lightweightStatusPresentation(status, { stopping, interrupted, queueCount });
  const readout = lightweightStatusReadout(presentation, queueCount);
  const statusDotClass = STATUS_DOT_CLASS[presentation.tone];

  const isNarrowActive = typeof isNarrow === 'boolean' ? isNarrow : narrowAuto;

  return (
    <footer
      className={`xn-lightweight-statusbar${isNarrowActive ? ' xn-lightweight-statusbar--narrow' : ''}`}
      data-testid="lightweight-statusbar"
      data-tone={presentation.tone}
      role="region"
      aria-label={tr('轻量模式状态行')}
    >
      <div className="xn-lightweight-statusbar__left" role="group" aria-label={tr('运行读数')}>
        <span className="xn-lightweight-statusbar__item xn-lightweight-statusbar__cwd" title={workspaceRoot ?? undefined}>
          {pathDisplay}
        </span>
        <span className="xn-lightweight-statusbar__sep" aria-hidden="true">•</span>
        <span className="xn-lightweight-statusbar__item xn-lightweight-statusbar__model" title={modelDisplay}>
          {modelDisplay}
        </span>
        <span className="xn-lightweight-statusbar__sep" aria-hidden="true">•</span>
        <span className="xn-lightweight-statusbar__item xn-lightweight-statusbar__tokens" title={tr('服务报告的 Token 用量')}>
          <span className="xn-lightweight-statusbar__sr">{tokenSpeech}</span>
          <span aria-hidden="true">{tokenDisplay}</span>
        </span>
      </div>
      <div className="xn-lightweight-statusbar__right">
        <span className={`xn-lightweight-status__dot ${statusDotClass}`} aria-hidden="true" />
        <span
          className="xn-lightweight-statusbar__status-text"
          role="status"
          aria-live="polite"
          aria-atomic="true"
          data-testid="lightweight-status-readout"
        >
          {readout}
        </span>
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
  | { kind: 'pending_question'; row: Extract<TimelineRow, { kind: 'pending_question' }>; id: string }
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
        // key 只取组首 seq：流式期间组每多吸一行不重挂载，展开态与焦点不丢
        result.push({ kind: 'read-only-group', rows: group, id: `ro-group-${group[0].seq}` });
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
    } else if (row.kind === 'pending_question') {
      result.push({ kind: 'pending_question', row, id: `question-${row.seq}` });
      i++;
    } else {
      // 类型上已穷尽，但行来自服务端事件：出现未知 kind 时不吞掉，留作占位
      const unknown = row as TimelineRow;
      result.push({ kind: 'other', row: unknown, id: `${unknown.kind}-${(unknown as { seq?: number }).seq ?? i}` });
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
  /** 这行就是当前等待用户回答的 ask_user：徽标改念「等待回答」。 */
  awaitingAnswer?: boolean;
};

export function lightweightToolStatusLabel(status: string, awaitingAnswer = false): string {
  return awaitingAnswer ? tr('等待回答') : toolStatusLabel(status);
}

/** 单行工具卡片：默认折叠为单行，点击/回车展开详情 */
export function LightweightToolRow({
  row,
  defaultOpen = false,
  awaitingAnswer = false,
}: LightweightToolRowProps): React.JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
  const summary = extractToolKeySummary(row.name, row.subject, row.input);
  const status = row.status ?? 'ok';
  const statusLabel = lightweightToolStatusLabel(status, awaitingAnswer);
  const badgeStatus = awaitingAnswer ? 'pending' : status;
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
        onKeyDown={(e) => {
          if (evaluateLightweightDisclosureKey(e) !== 'toggle') return;
          e.preventDefault();
          setOpen((prev) => !prev);
        }}
      >
        <span className="xn-lightweight-tool__name">{row.name}</span>
        {summary && <span className="xn-lightweight-tool__args" title={summary}>{summary}</span>}
        <span className="xn-lightweight-tool__status" data-status={badgeStatus}>{statusLabel}</span>
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
        onKeyDown={(e) => {
          if (evaluateLightweightDisclosureKey(e) !== 'toggle') return;
          e.preventDefault();
          setOpen((prev) => !prev);
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
        onKeyDown={(e) => {
          if (evaluateLightweightDisclosureKey(e) !== 'toggle') return;
          e.preventDefault();
          setOpen((prev) => !prev);
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
  /** 与标准档同一入参：JSON 工具协议下完成行要拆信封再展示。 */
  jsonToolProtocol?: boolean;
};

/**
 * 轻量紧凑时间线：
 * - 工具调用默认折叠为单行（工具名 + 关键参数摘要 + 状态 + 耗时）
 * - 连续只读工具调用自动合并为一个组
 * - 思考内容默认折叠
 *
 * 朗读策略：整条时间线是 `role="log"` 地标（标准档同样如此，两档一致），
 * additions 级 polite 播报让新增的一行工具/回复可被感知；流式期间标
 * `aria-busy`，逐 Token 重渲染不打断朗读，收尾后再播报完成的那条消息。
 */
export function LightweightTimeline({
  rows,
  streamingPending = false,
  emptyText = tr('暂无事件'),
  className = '',
  jsonToolProtocol = false,
}: LightweightTimelineProps): React.JSX.Element {
  const grouped = React.useMemo(() => groupLightweightTimelineRows(rows ?? []), [rows]);
  // pending_question 行答完即消失，用它决定 ask_user 念「等待回答」而不是「已完成」
  const awaitingQuestion = grouped.some((entry) => entry.kind === 'pending_question');

  const timelineProps = {
    'data-testid': 'lightweight-timeline',
    role: 'log' as const,
    'aria-label': tr('紧凑时间线'),
    'aria-live': 'polite' as const,
    'aria-atomic': false,
    'aria-relevant': 'additions' as const,
    'aria-busy': streamingPending,
  };

  if (!rows || rows.length === 0) {
    if (streamingPending) {
      return (
        <div
          className="xn-lightweight-timeline xn-lightweight-empty"
          {...timelineProps}
          data-testid="lightweight-timeline-loading"
        >
          <p className="xn-lightweight-stream-status" role="status">{tr('正在生成回复…')}</p>
        </div>
      );
    }
    return (
      <div
        className="xn-lightweight-timeline xn-lightweight-empty"
        {...timelineProps}
        data-testid="lightweight-timeline-empty"
      >
        <p>{emptyText}</p>
      </div>
    );
  }

  return (
    <div
      className={`xn-lightweight-timeline${className ? ` ${className}` : ''}`}
      {...timelineProps}
    >
      {grouped.map((entry) => {
        if (entry.kind === 'read-only-group') {
          return <LightweightToolGroup key={entry.id} rows={entry.rows} />;
        }
        if (entry.kind === 'tool') {
          return (
            <LightweightToolRow
              key={entry.id}
              row={entry.row}
              awaitingAnswer={awaitingQuestion && entry.row.name === 'ask_user'}
            />
          );
        }
        if (entry.kind === 'user') {
          return (
            <div
              key={entry.id}
              className="xn-lightweight-msg xn-lightweight-msg--user"
              data-testid={`timeline-item-user-${entry.row.seq}`}
              data-role="user"
            >
              <span className="xn-lightweight-msg__author">{tr('我的消息')}</span>
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
              <span className="xn-lightweight-msg__author">{tr('Xueness 回复')}</span>
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
          // 与标准档同一判定：通过/未通过/未完成的结论与标签都来自 completionPresentation
          const presentation = completionPresentation(
            entry.row as typeof entry.row & Parameters<typeof completionPresentation>[0],
            jsonToolProtocol,
          );
          return (
            <div
              key={entry.id}
              className="xn-lightweight-msg xn-lightweight-msg--completion"
              data-testid={`timeline-item-completion-${entry.row.seq}`}
              data-role="completion"
            >
              <TimelineCard
                role="completion"
                title={presentation.title}
                status={presentation.status}
                statusLabel={presentation.label}
                body={presentation.summary ?? ''}
                seq={entry.row.seq}
              />
            </div>
          );
        }
        if (entry.kind === 'pending_question') {
          return (
            <div
              key={entry.id}
              className="xn-lightweight-msg xn-lightweight-msg--question"
              data-testid={`timeline-item-question-${entry.row.seq}`}
              data-role="pending_question"
            >
              <TimelineCard
                role="question"
                title={tr('等待回答')}
                status="pending"
                body={entry.row.question}
                seq={entry.row.seq}
              />
            </div>
          );
        }
        return null;
      })}
      {streamingPending && !rows.some((row) => row.kind === 'assistant' && row.streaming) && (
        <div className="xn-lightweight-streaming" data-testid="lightweight-timeline-streaming">
          <span className="xn-lightweight-streaming-dots" aria-hidden="true">
            <span className="xn-lightweight-streaming-dot" />
            <span className="xn-lightweight-streaming-dot" />
            <span className="xn-lightweight-streaming-dot" />
          </span>
          <p className="xn-lightweight-stream-status" role="status">{tr('正在生成回复…')}</p>
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

/** 模态层选择器：与标准档 Composer 的 Esc 守卫使用同一套判据，保持两档一致。 */
/**
 * 前景浮层判定用的选择器。只列「打开时才挂载」的节点：工具条菜单是
 * `role="menu"` 的 popover，命令面板是 `.xn-command-overlay` ＋ `role="listbox"`，
 * 对话框一律 `role="dialog"`。`.xn-composer-toolbar__*` 上的 `[open]` 是死选择器
 * （这些菜单不是 `<details>`），用它会让 Esc 永远让位、停不掉回合。
 */
export const OVERLAY_SELECTOR = '[role="dialog"], [aria-modal="true"], [role="menu"], [role="listbox"], .xn-command-overlay, .xn-select-menu';

/** 是否有对话框/命令面板一类的模态层在前景，轻量档的全局按键必须让位。 */
export function hasOpenLightweightOverlay(): boolean {
  if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return false;
  return Boolean(document.querySelector(OVERLAY_SELECTOR));
}

/** 焦点是否落在可编辑控件里（含其它插件的输入框、终端、下拉与富文本）。 */
export function isEditableKeyTarget(target: unknown): boolean {
  const element = target as { closest?: (selector: string) => unknown } | null;
  if (!element || typeof element.closest !== 'function') return false;
  return Boolean(element.closest("textarea, input, select, [contenteditable='true']"));
}

/** 轻量档全局按键的 DOM 侧写：把事件转成纯判定函数的输入。 */
export function lightweightGlobalKeyContextFromEvent(
  event: { target: unknown },
  state: { panelOpen: boolean; running: boolean; stopping: boolean },
): LightweightGlobalKeyContext {
  const inEditableField = isEditableKeyTarget(event.target);
  const inComposer = Boolean((event.target as HTMLElement | null)?.closest?.('[data-testid="lightweight-composer-input"]'));
  return {
    inComposer,
    inEditableField,
    overlayOpen: hasOpenLightweightOverlay(),
    panelOpen: state.panelOpen,
    running: state.running,
    stopping: state.stopping,
  };
}

export type LightweightComposerKeyAction =
  | 'clear_screen'
  | 'stop'
  | 'history_prev'
  | 'history_next'
  | 'send'
  | 'newline'
  | null;

export type LightweightSendShortcut = 'enter' | 'mod-enter';

export type LightweightComposerKeyContext = {
  text: string;
  historyIndex: number | null;
  historyCount: number;
  running: boolean;
  stopping: boolean;
  /** 跟随用户的「发送快捷键」设置，与标准档 Composer 同一语义。 */
  sendShortcut?: LightweightSendShortcut;
  /** 有浮层（工具条菜单、命令面板、对话框）展开时让位，Esc 不能既关浮层又中断回合。 */
  overlayOpen?: boolean;
};

export function evaluateLightweightComposerKey(
  e: {
    key: string;
    shiftKey?: boolean;
    ctrlKey?: boolean;
    metaKey?: boolean;
    altKey?: boolean;
    keyCode?: number;
    isComposing?: boolean;
    nativeEvent?: { isComposing?: boolean };
  },
  context: LightweightComposerKeyContext,
): LightweightComposerKeyAction {
  if (e.isComposing || e.nativeEvent?.isComposing || e.keyCode === 229) return null;
  const mod = Boolean(e.ctrlKey || e.metaKey);
  // 只认裸 Mod+L：Ctrl+Shift+L / Ctrl+Alt+L 属于浏览器与其它插件，不劫持
  if (mod && !e.altKey && !e.shiftKey && (e.key === 'l' || e.key === 'L')) {
    return 'clear_screen';
  }
  if (e.key === 'Escape') {
    if (context.overlayOpen) return null;
    return context.running && !context.stopping ? 'stop' : null;
  }
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    // 历史翻找只用裸方向键：带修饰键的上下键交给光标移动与其它处理器
    if (mod || e.altKey || e.shiftKey) return null;
    if (context.overlayOpen) return null;
    if (e.key === 'ArrowUp') {
      if (context.historyCount > 0) {
        if (context.historyIndex === null && context.text.trim() === '') return 'history_prev';
        if (context.historyIndex !== null && context.historyIndex > 0) return 'history_prev';
      }
      return null;
    }
    if (context.historyIndex !== null && context.historyCount > 0) return 'history_next';
    return null;
  }
  if (e.key === 'Enter') {
    const sendShortcut = context.sendShortcut ?? 'enter';
    if (sendShortcut === 'mod-enter') {
      // ⌘/Ctrl+Enter 发送；裸 Enter 换行，与标准档一致。
      if (mod && !e.shiftKey) return 'send';
      return null;
    }
    return e.shiftKey ? 'newline' : 'send';
  }
  return null;
}

/** 折叠项（工具行、只读组、思考过程）的可展开按键：Enter 与空格都应切换。 */
export function evaluateLightweightDisclosureKey(e: {
  key: string;
  isComposing?: boolean;
  nativeEvent?: { isComposing?: boolean };
  keyCode?: number;
}): 'toggle' | null {
  if (e.isComposing || e.nativeEvent?.isComposing || e.keyCode === 229) return null;
  return e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar' ? 'toggle' : null;
}

export type LightweightGlobalKeyAction = 'clear-screen' | 'close-panel' | 'stop' | null;

export type LightweightGlobalKeyContext = {
  /** 焦点在轻量输入框：由 composer 自己的按键处理，容器不重复执行。 */
  inComposer: boolean;
  /** 焦点落在任意可编辑控件（其它插件的编辑器、搜索框、下拉、富文本）。 */
  inEditableField: boolean;
  /** 对话框、命令面板或工具条浮层展开中。 */
  overlayOpen: boolean;
  /** 当前显示的是二级面板而不是对话页。 */
  panelOpen: boolean;
  running: boolean;
  stopping: boolean;
};

/**
 * 轻量档挂在 window 上的补充快捷键判定（纯函数，便于回归）。
 *
 * Mod+L 在本应用里是浏览器保留键（快捷键录制器明确拒绝它），所以只在轻量档
 * 作为「滚到底」使用，且不越过输入控件与浮层：焦点在其它插件的输入框、
 * 终端或对话框里时一律不接管。输入框内的 Mod+L 由 composer 自己处理。
 */
export function evaluateLightweightGlobalKey(
  e: {
    key: string;
    ctrlKey?: boolean;
    metaKey?: boolean;
    altKey?: boolean;
    shiftKey?: boolean;
    repeat?: boolean;
    defaultPrevented?: boolean;
    isComposing?: boolean;
    keyCode?: number;
  },
  context: LightweightGlobalKeyContext,
): LightweightGlobalKeyAction {
  if (e.defaultPrevented || e.repeat || e.isComposing || e.keyCode === 229) return null;
  if (context.overlayOpen) return null;
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === 'l' || e.key === 'L')) {
    if (context.inComposer) return null;
    return context.inEditableField ? null : 'clear-screen';
  }
  if (e.key === 'Escape') {
    if (context.panelOpen) return 'close-panel';
    if (context.inEditableField) return null;
    return context.running && !context.stopping ? 'stop' : null;
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
  /** 跟随用户的发送快捷键设置（与标准档同一选项）。 */
  sendShortcut?: LightweightSendShortcut;
};

/** 轻量档键盘提示行：与标准档同一措辞分支，同时作为输入框的说明文本。 */
export function lightweightComposerHint(
  sendShortcut: LightweightSendShortcut,
  running: boolean,
  queueWhenRunning: boolean,
): string {
  const send = sendShortcut === 'mod-enter'
    ? tr('⌘/Ctrl+Enter 发送')
    : tr('Enter 发送 · Shift+Enter 换行');
  const parts = [send];
  if (running && queueWhenRunning) parts.push(tr('排队追加'));
  parts.push(tr('Esc 中断'));
  parts.push(tr('Ctrl/Cmd+L 滚到底'));
  return parts.join(' · ');
}

/**
 * 轻量极简输入区：
 * - 单行起步自动增高
 * - Enter 发送 / Shift+Enter 换行（可在设置里改为 ⌘/Ctrl+Enter 发送）
 * - Esc 中断运行中的回合（复用 onStop），浮层展开时让位
 * - 运行中继续输入进入排队发送
 * - Up/Down 在空输入框中调出本会话历史输入
 * - Ctrl/Cmd+L 清屏式滚到底（只在输入框内，不越过其它插件的输入控件）
 *
 * 无障碍：整块是带名称的 form 地标；输入框有稳定的可访问名（不长挂 placeholder
 * 文案），键盘提示通过 aria-describedby 关联；发送/停止按钮始终有文字级可访问名。
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
  placeholder = tr('输入消息'),
  historyMessages = [],
  onClearScreen = scrollToTimelineBottom,
  controls,
  inputRef,
  autoFocus = false,
  sendShortcut = 'enter',
}: LightweightComposerProps): React.JSX.Element {
  const initialText = draftStore?.current.get(draftKey)?.text ?? '';
  const [text, setTextState] = useState(initialText);
  const [sending, setSending] = useState(false);
  const textRevisionRef = useRef(0);
  const sendingRef = useRef(false);
  const localInputRef = useRef<HTMLTextAreaElement | null>(null);
  const hintId = useId();

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
    textRevisionRef.current += 1;
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
    sending ||
    (running ? (!queueWhenRunning || queueBusy) : false) ||
    !text.trim();

  const handleSend = useCallback(async () => {
    const trimmed = text.trim();
    if (sendingRef.current || !trimmed || isSendDisabled || stopping || !onSend) return;

    const submittedRevision = textRevisionRef.current;
    sendingRef.current = true;
    setSending(true);

    const inputData: ComposerInput = {
      attachments: [],
      files: [],
      sessions: [],
      skills: [],
      plugins: [],
      goal: false,
    };

    try {
      const accepted = await onSend(trimmed, inputData);
      if (accepted !== false && textRevisionRef.current === submittedRevision) {
        updateText('');
        setHistoryIndex(null);
        draftBeforeHistoryRef.current = '';
      }
    } catch {
      // Keep the exact draft as typed, including whitespace around the submitted text.
    } finally {
      sendingRef.current = false;
      setSending(false);
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
      sendShortcut,
      overlayOpen: hasOpenLightweightOverlay(),
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
    <form
      className="xn-lightweight-composer"
      data-testid="lightweight-composer"
      aria-label={tr('消息输入')}
      onSubmit={(e) => {
        e.preventDefault();
        void handleSend();
      }}
    >
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
          aria-label={tr('消息输入框')}
          aria-describedby={hintId}
          data-testid="lightweight-composer-input"
        />
        <div className="xn-lightweight-composer__actions">
          {running && onStop && (
            <button
              type="button"
              className="xn-lightweight-composer__btn xn-lightweight-composer__btn--stop"
              disabled={stopping}
              aria-label={stopping ? tr('正在停止') : tr('停止当前任务')}
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
              aria-label={queueBusy ? tr('正在排队…') : tr('加入队列')}
              title={queueBusy ? tr('正在排队…') : tr('加入队列')}
              data-testid="composer-queue"
              onClick={() => void handleSend()}
            >
              <ArrowUp size={14} aria-hidden="true" />
            </button>
          ) : !running ? (
            <button
              type="submit"
              className="xn-lightweight-composer__btn xn-lightweight-composer__btn--send"
              disabled={isSendDisabled}
              aria-label={tr('发送')}
              title={tr('发送')}
              data-testid="composer-send"
            >
              <ArrowUp size={14} aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </div>
      <div className="xn-lightweight-composer__meta">
        <span id={hintId} className="xn-lightweight-composer__hint">
          {lightweightComposerHint(sendShortcut, running, queueWhenRunning)}
        </span>
        {queueBusy && <span className="xn-lightweight-composer__status" role="status">{tr('正在排队…')}</span>}
      </div>
      {controls && (
        <div className="xn-lightweight-composer__controls" role="group" aria-label={tr('运行选项')}>
          {controls}
        </div>
      )}
    </form>
  );
}
