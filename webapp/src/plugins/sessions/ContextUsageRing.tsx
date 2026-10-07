import React from 'react';
import { t } from '../../i18n';
import './ContextUsageRing.css';

export type ContextUsageSource = 'provider-reported' | 'estimated';
export type ContextCapacitySource = 'context-window' | 'input-budget';

/** A current request's input compared with a clearly identified capacity. */
export type ContextUsageReading = {
  usedTokens: number;
  capacityTokens: number;
  usageSource: ContextUsageSource;
  capacitySource: ContextCapacitySource;
};

export type ContextUsageReadingInput = {
  /** Input tokens reported for the latest request only, not cumulative usage. */
  reportedInputTokens?: unknown;
  /** Local prepared-prompt estimate for the latest request. */
  estimatedInputTokens?: unknown;
  /** Declared model context window, when known. */
  contextWindow?: unknown;
  /** Available input budget after output and safety reserves. */
  inputBudgetTokens?: unknown;
};

function tokenCount(value: unknown, allowZero = false): number | undefined {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || (!allowZero && value === 0)) return undefined;
  return value;
}

/**
 * Prefer the latest provider-reported input count, then a request-local estimate.
 * The capacity source travels with the reading so an input budget is never
 * described as the model's full context window. Missing data stays unknown.
 */
export function contextUsageReading(input: ContextUsageReadingInput | null | undefined): ContextUsageReading | null {
  if (!input) return null;
  const contextWindow = tokenCount(input.contextWindow);
  const inputBudget = tokenCount(input.inputBudgetTokens);
  const reported = tokenCount(input.reportedInputTokens, true);
  if (reported !== undefined) {
    if (contextWindow !== undefined) {
      return { usedTokens: reported, capacityTokens: contextWindow, usageSource: 'provider-reported', capacitySource: 'context-window' };
    }
    if (inputBudget !== undefined) {
      return { usedTokens: reported, capacityTokens: inputBudget, usageSource: 'provider-reported', capacitySource: 'input-budget' };
    }
  }
  const estimated = tokenCount(input.estimatedInputTokens, true);
  if (estimated !== undefined && inputBudget !== undefined) {
    return { usedTokens: estimated, capacityTokens: inputBudget, usageSource: 'estimated', capacitySource: 'input-budget' };
  }
  return null;
}

export function contextUsagePercent(reading: ContextUsageReading | null | undefined): number | null {
  if (!reading || !Number.isSafeInteger(reading.usedTokens) || reading.usedTokens < 0 ||
      !Number.isSafeInteger(reading.capacityTokens) || reading.capacityTokens <= 0) return null;
  return Math.min(100, Math.max(0, (reading.usedTokens / reading.capacityTokens) * 100));
}

export type ContextUsageRingProps = {
  /** The sessions/providers host must pass false when its owning plugin is ineffective. */
  enabled: boolean;
  reading?: ContextUsageReading | null;
};

const RING_RADIUS = 7;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

export function ContextUsageRing({ enabled, reading }: ContextUsageRingProps): React.JSX.Element | null {
  const tooltipId = React.useId();
  const hostRef = React.useRef<HTMLSpanElement | null>(null);
  const tooltipRef = React.useRef<HTMLSpanElement | null>(null);
  const positionTooltip = () => {
    const host = hostRef.current;
    const tooltip = tooltipRef.current;
    if (!host || !tooltip) return;
    const anchor = host.getBoundingClientRect();
    const { width, height } = tooltip.getBoundingClientRect();
    const left = Math.max(12, Math.min(anchor.right - width + 8, window.innerWidth - width - 12));
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${Math.max(12, Math.min(anchor.top - height - 7, window.innerHeight - height - 12))}px`;
    tooltip.style.bottom = 'auto';
    tooltip.style.right = 'auto';
  };
  if (!enabled) return null;
  const percent = contextUsagePercent(reading);
  const validReading = percent !== null && reading ? reading : null;
  const known = validReading !== null;
  const label = known
    ? `${t('上下文用量')}：${validReading.usedTokens.toLocaleString()} / ${validReading.capacityTokens.toLocaleString()} ${t('Token')}`
    : `${t('上下文用量')}：${t('不可用')}`;
  const usageOrigin = known
    ? validReading.usageSource === 'provider-reported' ? t('服务报告的 Token 用量') : t('输入数值为本地估算，不是服务商报告的实际用量。')
    : t('不可用');
  const capacityOrigin = known
    ? validReading.capacitySource === 'context-window' ? t('上下文窗口') : t('输入预算估算')
    : '';
  const strokeOffset = percent === null ? RING_CIRCUMFERENCE : RING_CIRCUMFERENCE * (1 - percent / 100);

  return (
    <span ref={hostRef} className="xn-context-usage-ring" onMouseEnter={positionTooltip}>
      <span
        className="xn-context-usage-ring__indicator"
        role="progressbar"
        tabIndex={0}
        onFocus={positionTooltip}
        aria-label={t('上下文用量')}
        aria-valuemin={known ? 0 : undefined}
        aria-valuemax={known ? 100 : undefined}
        aria-valuenow={percent === null ? undefined : Math.round(percent)}
        aria-valuetext={known ? label : `${t('上下文用量')}：${t('不可用')}`}
        aria-describedby={tooltipId}
        data-testid="context-usage-ring"
        data-known={known}
        data-usage-source={validReading?.usageSource}
        data-capacity-source={validReading?.capacitySource}
      >
        <svg className="xn-context-usage-ring__graphic" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
          <circle className="xn-context-usage-ring__track" cx="10" cy="10" r={RING_RADIUS} />
          {known && <circle
            className="xn-context-usage-ring__value"
            cx="10"
            cy="10"
            r={RING_RADIUS}
            strokeDasharray={`${RING_CIRCUMFERENCE} ${RING_CIRCUMFERENCE}`}
            strokeDashoffset={strokeOffset}
            transform="rotate(-90 10 10)"
          />}
        </svg>
      </span>
      <span ref={tooltipRef} className="xn-context-usage-ring__tooltip" role="tooltip" id={tooltipId}>
        <strong>{t('上下文用量')}</strong>
        {known ? <>
          <span>{validReading.usedTokens.toLocaleString()} / {validReading.capacityTokens.toLocaleString()} {t('Token')}</span>
          <small>{t('最近一次请求的输入上下文')}</small>
          <small>{usageOrigin} · {capacityOrigin}</small>
        </> : <span>{t('不可用')}</span>}
      </span>
    </span>
  );
}
