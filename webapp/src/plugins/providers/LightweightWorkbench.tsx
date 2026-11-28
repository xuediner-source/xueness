import React, { useEffect, useState } from 'react';
import { t as tr, tf } from '../../i18n';
import { sessionStatusPresentation, type SessionStatusPresentation } from '../sessions/statusPresentation';
import { lightweightLayoutActive } from './useLightweightWorkbench';
import {
  evaluateLightweightGlobalKey, hasOpenLightweightOverlay, isEditableKeyTarget,
  lightweightGlobalKeyContextFromEvent, OVERLAY_SELECTOR, scrollToTimelineBottom,
  type LightweightGlobalKeyAction, type LightweightGlobalKeyContext,
} from './lightweightGlobalKeys';
import './LightweightWorkbench.css';

export {
  evaluateLightweightGlobalKey, hasOpenLightweightOverlay, isEditableKeyTarget,
  lightweightGlobalKeyContextFromEvent, lightweightLayoutActive, OVERLAY_SELECTOR, scrollToTimelineBottom,
  type LightweightGlobalKeyAction, type LightweightGlobalKeyContext,
};

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

// Lightweight global key helpers live in ./lightweightGlobalKeys and are re-exported above.

