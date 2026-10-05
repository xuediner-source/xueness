/**
 * 工作台用量速览（usage 插件功能）。
 *
 * 输入框工具行中的小「用量」按钮：点开弹出本会话与今日的 Token 统计卡片。
 * 只显示服务商实际报告的用量——本会话来自本地留存的 provider_usage 记录，
 * 今日来自 /api/usage 的按日汇总；没有任何报告时显示「暂无实际用量」，
 * 不做任何估算。usage 插件未生效时整个入口不渲染（fail-closed）。
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { ChartLine, ExternalLink, RefreshCw } from "lucide-react";
import { t as tr } from "../../i18n";
import { loadUsage, type UsageSummary } from "../../xuenessWorkspace";
import "../../styles/usage-quick-card.css";

/** 一次完整报告的 Token 汇总；requests 是报告完整的请求次数。 */
export type UsageQuickTotals = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  requests: number;
};

/**
 * 累加 provider_usage 记录中服务商完整报告的输入/输出 Token。
 * 缺少任一侧或数值非法的记录不参与求和（与用量面板的口径一致）。
 * 没有完整报告时返回 null，而不是编造 0。
 */
export function sumSessionProviderUsage(records: unknown): UsageQuickTotals | null {
  if (!Array.isArray(records)) return null;
  let inputTokens = 0;
  let outputTokens = 0;
  let requests = 0;
  for (const record of records) {
    if (!record || typeof record !== "object" || Array.isArray(record)) continue;
    const usage = (record as Record<string, unknown>).usage;
    if (!usage || typeof usage !== "object" || Array.isArray(usage)) continue;
    const bucket = usage as Record<string, unknown>;
    const input = bucket.prompt_tokens ?? bucket.input_tokens;
    const output = bucket.completion_tokens ?? bucket.output_tokens;
    if (typeof input !== "number" || !Number.isInteger(input) || input < 0) continue;
    if (typeof output !== "number" || !Number.isInteger(output) || output < 0) continue;
    inputTokens += input;
    outputTokens += output;
    requests += 1;
  }
  return requests > 0 ? { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, requests } : null;
}

function localDateKey(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/** 今日服务商实际报告的 Token；按日汇总里没有今天或为 0 时返回 null。 */
export function todayUsageFromSummary(
  usage: UsageSummary | null | undefined,
  now = new Date(),
): UsageQuickTotals | null {
  const today = localDateKey(now);
  const day = (usage?.dailyUsage ?? []).find((entry) => entry?.date === today);
  if (!day || !(day.totalTokens > 0)) return null;
  return {
    inputTokens: day.inputTokens,
    outputTokens: day.outputTokens,
    totalTokens: day.totalTokens,
    requests: day.requestCount,
  };
}

export function UsageQuickTotalsRow({ usage }: { usage: UsageQuickTotals | null }): React.JSX.Element {
  if (!usage) return <p className="xn-usage-quick__empty">{tr("暂无实际用量")}</p>;
  return (
    <p className="xn-usage-quick__totals" data-reported={usage.totalTokens > 0 ? "true" : undefined}>
      <span>{tr("输入 Token")} <strong>{usage.inputTokens.toLocaleString()}</strong></span>
      <span>{tr("输出 Token")} <strong>{usage.outputTokens.toLocaleString()}</strong></span>
      <span className="xn-usage-quick__requests">{usage.requests.toLocaleString()} {tr("次请求")}</span>
    </p>
  );
}

export type XuenessUsageQuickCardViewProps = {
  sessionUsage: UsageQuickTotals | null;
  todayUsage: UsageQuickTotals | null;
  loading: boolean;
  error: string;
  cardRef?: React.Ref<HTMLDivElement>;
  onRefresh(): void;
  onOpenPanel(): void;
  onClose(restoreFocus?: boolean): void;
};

/** 弹出的速览卡片本体；独立导出以便在 SSR 测试中直接断言内容。 */
export function XuenessUsageQuickCardView({
  sessionUsage,
  todayUsage,
  loading,
  error,
  cardRef,
  onRefresh,
  onOpenPanel,
  onClose,
}: XuenessUsageQuickCardViewProps): React.JSX.Element {
  return (
    <div
      ref={cardRef}
      role="dialog"
      aria-label={tr("用量速览")}
      tabIndex={-1}
      className="xn-usage-quick__card"
      data-testid="usage-quick-card"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        onClose(true);
      }}
    >
      <div className="xn-usage-quick__head">
        <strong>{tr("用量速览")}</strong>
        <button
          type="button"
          className="xn-usage-quick__refresh"
          onClick={onRefresh}
          disabled={loading}
          aria-label={tr("刷新用量")}
          title={tr("刷新用量")}
          data-testid="usage-quick-refresh"
        >
          <RefreshCw size={13} className={loading ? "is-spinning" : undefined} aria-hidden="true" />
        </button>
      </div>
      <div className="xn-usage-quick__section" data-testid="usage-quick-session">
        <span className="xn-usage-quick__label">{tr("本会话")}</span>
        <UsageQuickTotalsRow usage={sessionUsage} />
      </div>
      <div className="xn-usage-quick__section" data-testid="usage-quick-today">
        <span className="xn-usage-quick__label">{tr("今日")}</span>
        <UsageQuickTotalsRow usage={todayUsage} />
      </div>
      {error && <p role="alert" className="xn-usage-quick__error">{tr("获取用量数据失败：")}{error}</p>}
      <p className="xn-usage-quick__note">{tr("仅统计服务商实际报告的用量，缺失部分不作估算。")}</p>
      <button type="button" className="xn-usage-quick__open" data-testid="usage-quick-open" onClick={onOpenPanel}>
        <ExternalLink size={12} aria-hidden="true" />
        <span>{tr("打开用量面板")}</span>
      </button>
    </div>
  );
}

export type XuenessUsageQuickCardProps = {
  /** Fail-closed：usage 插件未生效时不渲染入口，也不发起任何请求。 */
  enabled: boolean;
  /** 当前会话的原始 provider_usage 记录（由宿主从会话数据透传）。 */
  sessionProviderUsage?: unknown;
  onOpenPanel?(): void;
};

export function XuenessUsageQuickCard({
  enabled,
  sessionProviderUsage,
  onOpenPanel,
}: XuenessUsageQuickCardProps): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const requestId = useRef(0);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(async () => {
    const current = ++requestId.current;
    setLoading(true);
    setError("");
    const result = await loadUsage("7d");
    if (current !== requestId.current) return;
    setLoading(false);
    if (result.ok) setSummary(result.value);
    else setError(result.error);
  }, []);

  useEffect(() => {
    if (!open) return;
    void refresh();
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      requestId.current += 1;
    };
  }, [open, refresh]);

  useEffect(() => {
    if (open) cardRef.current?.focus();
  }, [open]);

  if (!enabled) return null;

  const close = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  };

  return (
    <div className="xn-usage-quick" ref={wrapRef}>
      <button
        type="button"
        ref={triggerRef}
        className="xn-usage-quick__trigger"
        aria-label={tr("用量速览")}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={tr("用量速览")}
        data-testid="usage-quick-trigger"
        onClick={() => setOpen((value) => !value)}
      >
        <ChartLine size={14} aria-hidden="true" />
        <span>{tr("用量")}</span>
      </button>
      {open && (
        <XuenessUsageQuickCardView
          sessionUsage={sumSessionProviderUsage(sessionProviderUsage)}
          todayUsage={todayUsageFromSummary(summary)}
          loading={loading}
          error={error}
          cardRef={cardRef}
          onRefresh={() => void refresh()}
          onOpenPanel={() => {
            close();
            onOpenPanel?.();
          }}
          onClose={close}
        />
      )}
    </div>
  );
}
