import React, { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { UsageDailySummary, UsageModelSummary, UsageSummary } from "./xuenessApi";
import { loadUsage } from "./xuenessWorkspace";
import { t as tr, tf, useLocale } from "./i18n";
import "./styles/usage-settings.css";

export type UsageRange = "7d" | "30d";
type UsageResultState = { usage: UsageSummary | null; error: string; loading: boolean };

export type UsageChartDay = {
  date: string;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  requestCount: number;
  unknownRequests: number;
};

export type UsageHeatmapCell = {
  date: string;
  totalTokens: number;
  level: 0 | 1 | 2 | 3 | 4;
};

export type UsageHeatmapWeek = { month: string; days: UsageHeatmapCell[] };

function dayIndex(date: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return null;
  const value = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isFinite(value) ? Math.floor(value / 86_400_000) : null;
}

function dayKey(index: number): string {
  return new Date(index * 86_400_000).toISOString().slice(0, 10);
}

function localTodayKey(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

export function buildUsageChartDays(
  usage: UsageSummary | null,
  range: UsageRange,
  now = new Date(),
): UsageChartDay[] {
  if (!usage) return [];
  const today = dayIndex(localTodayKey(now));
  if (today === null) return [];
  // The API uses a rolling 7/30*24-hour window. At the exact lower boundary,
  // activity can touch one extra calendar date, so include that date as well.
  const count = range === "7d" ? 8 : 31;
  const byDate = new Map((usage.dailyUsage ?? []).map((day) => [day.date, day]));
  return Array.from({ length: count }, (_, offset) => {
    const date = dayKey(today - count + offset + 1);
    const value = byDate.get(date);
    return {
      date,
      totalTokens: value?.totalTokens ?? 0,
      inputTokens: value?.inputTokens ?? 0,
      outputTokens: value?.outputTokens ?? 0,
      requestCount: value?.requestCount ?? 0,
      unknownRequests: value?.unknownRequests ?? 0,
    };
  });
}

export function buildUsageHeatmapWeeks(
  dailyUsage: UsageDailySummary[] | undefined,
  now = new Date(),
): UsageHeatmapWeek[] {
  const today = dayIndex(localTodayKey(now));
  if (today === null) return [];
  const totals = new Map((dailyUsage ?? []).map((day) => [day.date, day.totalTokens]));
  const weekday = new Date(today * 86_400_000).getUTCDay();
  const lastWeekStart = today - weekday;
  const firstWeekStart = lastWeekStart - 51 * 7;
  const raw = Array.from({ length: 52 }, (_, weekIndex) => {
    const firstDate = dayKey(firstWeekStart + weekIndex * 7);
    const days = Array.from({ length: 7 }, (_, offset) => {
      const date = dayKey(firstWeekStart + weekIndex * 7 + offset);
      return { date, totalTokens: totals.get(date) ?? 0, level: 0 as UsageHeatmapCell["level"] };
    });
    const monthDate = days.find((day) => day.date.endsWith("-01"))?.date ?? firstDate;
    return { monthDate, days };
  });
  const max = Math.max(0, ...raw.flatMap((week) => week.days.map((day) => day.totalTokens)));
  return raw.map((week) => ({
    month: week.days.some((day) => day.date.endsWith("-01")) ? week.monthDate : "",
    days: week.days.map((day) => ({
      ...day,
      level: day.totalTokens <= 0 || max <= 0
        ? 0
        : Math.min(4, Math.max(1, Math.ceil((day.totalTokens / max) * 4))) as UsageHeatmapCell["level"],
    })),
  }));
}

function formatCompact(value: number, locale: string): string {
  return new Intl.NumberFormat(locale === "en" ? "en-US" : "zh-CN", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(Number.isFinite(value) ? value : 0);
}

function formatCount(value: number, locale: string): string {
  return new Intl.NumberFormat(locale === "en" ? "en-US" : "zh-CN", {
    maximumFractionDigits: 0,
  }).format(Number.isFinite(value) ? value : 0);
}

function formatDate(date: string, locale: string, options?: Intl.DateTimeFormatOptions): string {
  const index = dayIndex(date);
  if (index === null) return date;
  return new Intl.DateTimeFormat(locale === "en" ? "en-US" : "zh-CN", {
    month: "short", day: "numeric", timeZone: "UTC", ...options,
  }).format(new Date(index * 86_400_000));
}

function formatMonth(date: string, locale: string): string {
  const index = dayIndex(date);
  return index === null ? "" : new Intl.DateTimeFormat(locale === "en" ? "en-US" : "zh-CN", {
    month: "short", timeZone: "UTC",
  }).format(new Date(index * 86_400_000));
}

function formatCosts(costs: Record<string, number> | undefined): string {
  return Object.entries(costs ?? {})
    .filter(([, amount]) => Number.isFinite(amount) && amount >= 0)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([currency, amount]) => `${amount.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${currency}`)
    .join(" · ");
}

function hasReportedUsage(usage: UsageSummary | null): boolean {
  if (!usage) return false;
  return Boolean(
    usage.models?.length
    || usage.tokens?.reportedRequests
    || usage.tokens?.unknownRequests
    || Object.keys(usage.costs ?? {}).length,
  );
}

function useUsageSnapshot(range: string): [UsageResultState, () => Promise<void>] {
  const [state, setState] = useState<UsageResultState>({ usage: null, error: "", loading: true });
  const requestId = useRef(0);
  const refresh = useCallback(async () => {
    const currentId = ++requestId.current;
    setState((current) => ({ ...current, loading: true, error: "" }));
    const result = await loadUsage(range);
    if (currentId !== requestId.current) return;
    if (result.ok) setState({ usage: result.value, error: "", loading: false });
    else setState((current) => ({ ...current, error: result.error, loading: false }));
  }, [range]);
  useEffect(() => {
    void refresh();
    return () => { requestId.current += 1; };
  }, [refresh]);
  return [state, refresh];
}

export function XuenessUsageSettings(): React.JSX.Element {
  const locale = useLocale();
  const [range, setRange] = useState<UsageRange>("7d");
  const [period, refreshPeriod] = useUsageSnapshot(range);
  const [lifetime, refreshLifetime] = useUsageSnapshot("all");
  const [refreshing, setRefreshing] = useState(false);

  const refresh = async () => {
    setRefreshing(true);
    try {
      await Promise.all([refreshPeriod(), refreshLifetime()]);
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <XuenessUsageSettingsView
      locale={locale}
      range={range}
      onRangeChange={setRange}
      period={period}
      lifetime={lifetime}
      refreshing={refreshing}
      onRefresh={() => { void refresh(); }}
      onRetryPeriod={() => { void refreshPeriod(); }}
      onRetryLifetime={() => { void refreshLifetime(); }}
    />
  );
}

export type XuenessUsageSettingsViewProps = {
  locale: "zh" | "en";
  range: UsageRange;
  onRangeChange: (range: UsageRange) => void;
  period: UsageResultState;
  lifetime: UsageResultState;
  refreshing?: boolean;
  onRefresh?: () => void;
  onRetryPeriod?: () => void;
  onRetryLifetime?: () => void;
  now?: Date;
};

export function XuenessUsageSettingsView({
  locale,
  range,
  onRangeChange,
  period,
  lifetime,
  refreshing = false,
  onRefresh,
  onRetryPeriod,
  onRetryLifetime,
  now = new Date(),
}: XuenessUsageSettingsViewProps): React.JSX.Element {
  // A previous range may remain cached while its successor loads; never show
  // those values beneath the newly selected range tab.
  const usage = period.usage?.range === range ? period.usage : null;
  const all = lifetime.usage;
  const chartDays = buildUsageChartDays(usage, range, now);
  const heatmapWeeks = buildUsageHeatmapWeeks(all?.dailyUsage, now);
  const chartMaximum = Math.max(0, ...chartDays.map((day) => day.totalTokens));
  const activity = all?.tokenActivity;
  const models = usage?.models ?? [];
  const largestModel = Math.max(0, ...models.map((model) => model.totalTokens));

  return (
    <section className="xn-usage-settings" data-testid="xn-usage-settings">
      <div className="xn-usage-settings__lifetime" data-testid="xn-usage-lifetime-stats">
        <UsageStat label={tr("已留存 Token 总量")} value={all?.tokens?.total === undefined ? "—" : formatCompact(all.tokens.total, locale)} />
        <UsageStat label={tr("单日峰值")} value={activity ? formatCompact(activity.peakDayTokens, locale) : "—"} />
        <UsageStat label={tr("有用量日期")} value={activity ? formatCount(activity.activeDays, locale) : "—"} />
        <UsageStat label={tr("当前连续天数")} value={activity ? formatCount(activity.currentStreakDays, locale) : "—"} />
        <UsageStat label={tr("最长连续天数")} value={activity ? formatCount(activity.longestStreakDays, locale) : "—"} />
      </div>
      <p className="xn-usage-settings__note">{tr("仅统计服务商报告且本地仍留存的 Token；每个任务最多保留最近 100 条用量请求记录，未报告的用量与价格不会估算。")}</p>

      {lifetime.error && <div className="xn-usage-settings__error" role="alert">{tr("获取用量数据失败：")}{lifetime.error}</div>}
      {lifetime.loading && !all && <div className="xn-usage-settings__loading" role="status">{tr("加载用量数据中...")}</div>}
      {!lifetime.loading && !all && lifetime.error && <button type="button" className="xn-usage-settings__retry" onClick={onRetryLifetime}>{tr("重试")}</button>}

      {all && hasReportedUsage(all) && heatmapWeeks.length > 0 && (
        <section className="xn-usage-settings__card" aria-labelledby="xn-usage-heatmap-title">
          <div className="xn-usage-settings__card-heading">
            <div>
              <h2 id="xn-usage-heatmap-title">{tr("用量活跃度")}</h2>
              <p>{tr("最近 52 周已报告 Token 用量")}</p>
            </div>
            <div className="xn-usage-settings__scale" aria-label={tr("用量由少到多") }>
              {[0, 1, 2, 3, 4].map((level) => <span key={level} data-level={level} />)}
            </div>
          </div>
          <div className="xn-usage-settings__heatmap-scroll">
            <div className="xn-usage-settings__heatmap" role="grid" aria-label={tr("年度 Token 用量热力图")}>
              {heatmapWeeks.map((week, weekIndex) => (
                <div className="xn-usage-settings__heatmap-week" role="row" key={weekIndex}>
                  <span className="xn-usage-settings__heatmap-month">{week.month ? formatMonth(week.month, locale) : ""}</span>
                  {week.days.map((day) => (
                    <span
                      key={day.date}
                      role="gridcell"
                      data-level={day.level}
                      title={`${day.date} · ${formatCount(day.totalTokens, locale)} ${tr("Token")}`}
                      aria-label={`${formatDate(day.date, locale, { weekday: "long", year: "numeric" })}: ${formatCount(day.totalTokens, locale)} ${tr("Token")}`}
                    />
                  ))}
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      <div className="xn-usage-settings__range-heading">
        <div>
          <h2>{tr("最近用量")}</h2>
          <p>{tr("按服务商实际报告的用量汇总")}</p>
        </div>
        <div className="xn-usage-settings__range-actions">
          <div className="xn-usage-settings__tabs" role="tablist" aria-label={tr("统计周期")}>
            {(["7d", "30d"] as const).map((value) => (
              <button key={value} type="button" role="tab" aria-selected={range === value} onClick={() => onRangeChange(value)}>
                {value === "7d" ? tr("7 天") : tr("30 天")}
              </button>
            ))}
          </div>
          <button className="xn-usage-settings__refresh" type="button" onClick={onRefresh} disabled={refreshing || period.loading} aria-label={tr("刷新用量")}>
            <RefreshCw size={14} aria-hidden="true" className={refreshing ? "is-spinning" : undefined} />
            <span>{tr("刷新")}</span>
          </button>
        </div>
      </div>

      {period.error && <div className="xn-usage-settings__error" role="alert">{tr("获取用量数据失败：")}{period.error}</div>}
      {period.loading && !usage && <div className="xn-usage-settings__loading" role="status">{tr("加载用量数据中...")}</div>}
      {!period.loading && !usage && period.error && <button type="button" className="xn-usage-settings__retry" onClick={onRetryPeriod}>{tr("重试")}</button>}

      {usage && (
        <>
          <section className="xn-usage-settings__card" aria-labelledby="xn-usage-chart-title">
            <div className="xn-usage-settings__card-heading">
              <div>
                <h2 id="xn-usage-chart-title">{tr("每日 Token 用量")}</h2>
                <p>{tr("仅累加服务商明确报告的总量或完整输入/输出用量")}</p>
              </div>
              <div className="xn-usage-settings__period-totals">
                <strong>{usage.tokens?.total === undefined ? "—" : formatCompact(usage.tokens.total, locale)}</strong>
                <span>{tr("Token")}</span>
              </div>
            </div>
            {period.loading && <div className="xn-usage-settings__inline-loading" role="status">{tr("刷新中…")}</div>}
            {chartDays.length > 0 && chartMaximum > 0 ? (
              <div className="xn-usage-settings__chart-scroll">
                <div className="xn-usage-settings__chart" data-range={range} role="img" aria-label={tf("{0} 天每日 Token 用量", [range === "7d" ? "7" : "30"]) }>
                  {chartDays.map((day) => {
                    const height = Math.max(day.totalTokens > 0 ? 3 : 0, chartMaximum > 0 ? day.totalTokens / chartMaximum * 100 : 0);
                    return (
                      <div className="xn-usage-settings__chart-column" key={day.date}>
                        <div className="xn-usage-settings__chart-track">
                          <span
                            className="xn-usage-settings__chart-bar"
                            style={{ height: `${height}%` }}
                            title={`${day.date}: ${formatCount(day.totalTokens, locale)} ${tr("Token")} · ${formatCount(day.requestCount, locale)} ${tr("次请求")}`}
                            aria-hidden="true"
                          />
                        </div>
                        <span className="xn-usage-settings__chart-label" title={day.date}>{formatDate(day.date, locale, { year: undefined })}</span>
                      </div>
                    );
                  })}
                </div>
                <ul className="xn-usage-settings__sr-only" aria-label={tr("每日用量数据列表")}>
                  {chartDays.map((day) => <li key={day.date}>{day.date}: {formatCount(day.totalTokens, locale)} {tr("Token")}, {formatCount(day.requestCount, locale)} {tr("次请求")}</li>)}
                </ul>
              </div>
            ) : (
              <div className="xn-usage-settings__empty-chart">{hasReportedUsage(usage) ? tr("此周期没有完整报告的 Token 总量") : tr("服务商尚未报告 Token 用量")}</div>
            )}
            <div className="xn-usage-settings__period-detail">
              <span>{tr("会话")} <strong>{formatCount(usage.totals.sessions, locale)}</strong></span>
              <span>{tr("步骤")} <strong>{formatCount(usage.totals.steps, locale)}</strong></span>
              <span>{tr("完整用量请求")} <strong>{formatCount(usage.tokens?.reportedRequests ?? 0, locale)}</strong></span>
              {(usage.tokens?.unknownRequests ?? 0) > 0 && <span>{tr("不完整用量请求")} <strong>{formatCount(usage.tokens!.unknownRequests, locale)}</strong></span>}
              {formatCosts(usage.costs) && <span>{tr("已报告费用")} <strong>{formatCosts(usage.costs)}</strong></span>}
            </div>
          </section>

          <section className="xn-usage-settings__card" aria-labelledby="xn-usage-models-title">
            <div className="xn-usage-settings__card-heading">
              <div>
                <h2 id="xn-usage-models-title">{tr("模型用量")}</h2>
                <p>{tr("按用量记录中的模型与协议汇总；未标记模型的记录单独列出")}</p>
              </div>
              <span className="xn-usage-settings__model-total">{formatCount(models.length, locale)} {tr("个模型")}</span>
            </div>
            {models.length ? (
              <div className="xn-usage-settings__models" role="list">
                {models.map((model, index) => <UsageModelRow key={`${model.protocol ?? "unknown"}-${model.model ?? "unknown"}-${index}`} model={model} locale={locale} maxTokens={largestModel} />)}
              </div>
            ) : (
              <div className="xn-usage-settings__empty-chart">{tr("此周期没有可按模型归类的报告用量")}</div>
            )}
          </section>

          <div className="xn-usage-settings__footer">
            {tr("统计周期")}: {usage.range === "7d" ? tr("最近 7 天") : usage.range === "30d" ? tr("最近 30 天") : tr("全部留存记录")}
            {usage.updatedAt && <span>{tr("更新时间:")} {usage.updatedAt}</span>}
          </div>
        </>
      )}
    </section>
  );
}

function UsageStat({ label, value }: { label: string; value: string }): React.JSX.Element {
  return <div className="xn-usage-settings__stat"><strong>{value}</strong><span>{label}</span></div>;
}

function UsageModelRow({ model, locale, maxTokens }: { model: UsageModelSummary; locale: "zh" | "en"; maxTokens: number }): React.JSX.Element {
  const label = model.model ?? tr("未报告模型");
  const total = model.totalTokens;
  return (
    <div className="xn-usage-settings__model" role="listitem">
      <div className="xn-usage-settings__model-identity">
        <span className="xn-usage-settings__model-dot" aria-hidden="true" />
        <strong title={label}>{label}</strong>
        <span className="xn-usage-settings__protocol">{model.protocol ?? tr("协议未报告")}</span>
      </div>
      <div className="xn-usage-settings__model-metrics">
        <span><strong>{formatCompact(total, locale)}</strong> {tr("Token")}</span>
        <span>{formatCount(model.requestCount, locale)} {tr("次请求")}</span>
        {model.unknownRequests > 0 && <span>{formatCount(model.unknownRequests, locale)} {tr("次请求用量不完整")}</span>}
        {Object.keys(model.costs).length > 0 && <span>{formatCosts(model.costs)}</span>}
      </div>
      <div className="xn-usage-settings__model-meter" aria-hidden="true"><span style={{ width: `${total > 0 && maxTokens > 0 ? Math.max(2, Math.min(100, total / maxTokens * 100)) : 0}%` }} /></div>
    </div>
  );
}
