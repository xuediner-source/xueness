import React, { useEffect, useState } from 'react';
import { t as tr, tf } from '../../i18n';
import { isImeComposingEvent, isModKeyPressed } from '../../xuenessShortcutDisplay';
import { sessionStatusPresentation, type SessionStatusPresentation } from '../sessions/statusPresentation';
import './LightweightWorkbench.css';

/**
 * 轻量档极简工作台（providers 插件功能）。
 *
 * 对标 Pi coding agent 的极简形态：选中本地轻量档时只保留与本地小模型运行
 * 直接相关的界面。输入区单行起步自动增高、时间线紧凑折叠（连续只读工具自动
 * 合并分组、思考过程折叠）、极简状态行显示工作区/已报告 Token 用量；模型名由
 * 输入区的单一选择器展示。
 */

/** 轻量极简布局只在 providers 插件生效且当前运行档位为轻量时启用。 */
export function lightweightLayoutActive(
  runtimeProfile: string | null | undefined,
  providersEffective: boolean,
): boolean {
  return providersEffective && runtimeProfile === 'lightweight';
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
  /** @deprecated The composer model selector is now the single visible model label. */
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

export type LightweightStatusTone = SessionStatusPresentation['tone'];

export type LightweightStatusPresentation = { label: string; tone: LightweightStatusTone };

/**
 * 极简栏复用会话插件的状态词表，needs_review 保持“需要复核”这一中性状态；
 * 只有明确失败状态才显示失败色。未知状态不猜测。
 */
export function lightweightStatusPresentation(
  status?: string | null,
  context: { stopping?: boolean; interrupted?: boolean; queueCount?: number } = {},
): LightweightStatusPresentation {
  return sessionStatusPresentation(status, context) ?? { label: tr('空闲'), tone: 'idle' };
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
 * 极简状态行（Pi 风格底部 footer）：显示工作区路径缩写、真实报告的 Token
 * 用量（缺失显示「—」）和当前运行状态。当前模型已由输入区模型选择器展示，
 * 此处不再重复一遍。
 *
 * 读数区是 `role="region"` 地标，屏幕阅读器可以主动浏览但不自动播报；只有
 * 右侧状态读数在 polite 实时区内，且 `aria-atomic` 保证状态翻转时只念这一句。
 * Token 用量与路径每轮都可能变，刻意留在实时区外，避免持续打断朗读。
 */
export function LightweightStatusBar({
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
  state: { panelOpen: boolean; running: boolean; stopping: boolean; platform?: string },
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
    platform: state.platform,
  };
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
  platform?: string;
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
    nativeEvent?: { isComposing?: boolean; keyCode?: number };
    compositionActive?: boolean;
  },
  context: LightweightGlobalKeyContext,
): LightweightGlobalKeyAction {
  if (e.defaultPrevented || e.repeat || isImeComposingEvent(e)) return null;
  if (context.overlayOpen) return null;
  const isMod = context.platform
    ? isModKeyPressed(e, context.platform)
    : Boolean((e.ctrlKey && !e.metaKey) || (e.metaKey && !e.ctrlKey));
  if (isMod && !e.altKey && !e.shiftKey && (e.key === 'l' || e.key === 'L')) {
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

