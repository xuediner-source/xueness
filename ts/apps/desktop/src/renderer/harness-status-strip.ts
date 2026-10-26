/**
 * H12.05 — Desktop harness status strip.
 *
 * Pure view model for the desktop renderer's status strip: it turns an H06
 * profiler `ProfileSummary` (plus an optional token quota) into the rows a
 * strip renders — per model and overall — each showing the model id, token
 * usage against the quota, and the KV prefix-cache hit rate, with a traffic
 * light state (`idle` / `ok` / `warn` / `critical` / `exhausted`).
 *
 * No DOM access and no I/O: the renderer only renders the frozen snapshots
 * this module returns. Deterministic by construction — the same summary and
 * options always produce byte-identical rows and `render()` output.
 */

import type { ProfileAggregate, ProfileSummary } from "../../../../plugins/deepseek_harness/src/bench/profiler.ts";

/** Token budget for one strip (or one model's share of it). */
export interface TokenQuota {
  /** Budget in total tokens (prompt + completion). Must be > 0. */
  totalTokens: number;
}

/** Traffic light of a row, derived from quota usage thresholds. */
export type StripState = "idle" | "ok" | "warn" | "critical" | "exhausted";

/** Quota usage shown on a row; null when the strip has no budget. */
export interface QuotaUsage {
  budgetTokens: number;
  usedTokens: number;
  remainingTokens: number;
  /** usedTokens / budgetTokens, rounded to 6 decimals; 0 before any call. */
  usedFraction: number;
}

/** One rendered strip row: a model, or `*` for the whole run. */
export interface StatusStripRow {
  /** Model id this row aggregates; `*` for the overall row. */
  model: string;
  /** Display label (`model` with the overall row spelled `harness`). */
  label: string;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  /** H01.03 prefix-based hit rate (0..1); 0 for a run with no cacheable call. */
  cacheHitRate: number;
  /** Provider-reported prompt cache ratio, or null when never reported. */
  providerCacheHitRate: number | null;
  warmCalls: number;
  coldCalls: number;
  partialCalls: number;
  /** Median latency in ms across the row's calls; 0 with no calls. */
  medianLatencyMs: number;
  quota: QuotaUsage | null;
  state: StripState;
  /** Rendered one-line segment for this row (see `renderStatusLine`). */
  text: string;
}

export interface StatusStripOptions {
  /** Token budget; without it rows show plain totals and never leave `ok`. */
  quota?: TokenQuota;
  /** Usage fraction at which a row turns `warn`; default 0.8. */
  warnAt?: number;
  /** Usage fraction at which a row turns `critical`; default 0.95. */
  criticalAt?: number;
  /** Strip title prefix in `render()`; default "harness". */
  title?: string;
}

export interface HarnessStatusStrip {
  readonly rows: readonly StatusStripRow[];
  /** Overall (`*`) row; always present, `idle` for an empty summary. */
  readonly overall: StatusStripRow;
  /** Row of one model id, or null when the summary has no calls for it. */
  byModel(model: string): StatusStripRow | null;
  /** The whole strip as one deterministic line: title + rows joined by " | ". */
  render(): string;
}

/** Compact deterministic token count: `950`, `12.3k`, `4.56M`. */
export function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "0";
  if (value < 1000) return String(Math.round(value));
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 2 : 1)}k`;
  return `${(value / 1_000_000).toFixed(2)}M`;
}

/** Deterministic percentage with one decimal: 0.875 -> "87.5%". */
export function formatRate(rate: number): string {
  if (!Number.isFinite(rate) || rate <= 0) return "0.0%";
  return `${(Math.min(rate, 1) * 100).toFixed(1)}%`;
}

const round6 = (value: number): number => Math.round(value * 1e6) / 1e6;

function quotaUsage(usedTokens: number, budget: number): QuotaUsage {
  return {
    budgetTokens: budget,
    usedTokens,
    remainingTokens: Math.max(0, budget - usedTokens),
    usedFraction: round6(budget === 0 ? 0 : usedTokens / budget),
  };
}

/**
 * Traffic light: `idle` before any call, `exhausted` at/over budget, then
 * `critical`/`warn`/`ok` by usage fraction. Without a budget a row with
 * calls is always `ok` (an idle row stays `idle`).
 */
export function stripState(calls: number, usedFraction: number | null, warnAt = 0.8, criticalAt = 0.95): StripState {
  if (calls === 0) return "idle";
  if (usedFraction === null) return "ok";
  if (usedFraction >= 1) return "exhausted";
  if (usedFraction >= criticalAt) return "critical";
  if (usedFraction >= warnAt) return "warn";
  return "ok";
}

/** One row's one-line segment, e.g. `deepseek-chat 12.34k tok (24.7% of 50.00k) · cache 87.5% · ok`. */
export function renderStatusLine(row: StatusStripRow): string {
  const parts: string[] = [row.label];
  if (row.calls === 0) {
    parts.push("idle");
    return parts.join(" ");
  }
  const quota = row.quota;
  const tokens = quota
    ? `${formatTokens(row.totalTokens)} tok (${formatRate(quota.usedFraction)} of ${formatTokens(quota.budgetTokens)}, ${formatTokens(quota.remainingTokens)} left)`
    : `${formatTokens(row.totalTokens)} tok`;
  parts.push(tokens);
  parts.push(`cache ${formatRate(row.cacheHitRate)}`);
  if (row.providerCacheHitRate !== null) parts.push(`provider ${formatRate(row.providerCacheHitRate)}`);
  parts.push(`${row.calls} calls w${row.warmCalls}/p${row.partialCalls}/c${row.coldCalls}`);
  parts.push(row.state);
  return parts.join(" ");
}

function buildRow(aggregate: ProfileAggregate, quota: TokenQuota | undefined, warnAt: number, criticalAt: number, label: string): StatusStripRow {
  const usage = quota ? quotaUsage(aggregate.totalTokens, quota.totalTokens) : null;
  const row: StatusStripRow = {
    model: aggregate.model,
    label,
    calls: aggregate.calls,
    promptTokens: aggregate.promptTokens,
    completionTokens: aggregate.completionTokens,
    totalTokens: aggregate.totalTokens,
    cachedTokens: aggregate.cachedTokens,
    cacheHitRate: aggregate.cacheHitRate,
    providerCacheHitRate: aggregate.cachedTokens > 0 && aggregate.promptTokens > 0 ? round6(aggregate.cachedTokens / aggregate.promptTokens) : null,
    warmCalls: aggregate.warmCalls,
    coldCalls: aggregate.coldCalls,
    partialCalls: aggregate.partialCalls,
    medianLatencyMs: aggregate.latency.medianMs,
    quota: usage,
    state: stripState(aggregate.calls, usage ? usage.usedFraction : null, warnAt, criticalAt),
    text: "",
  };
  row.text = renderStatusLine(row);
  return Object.freeze(row);
}

/**
 * Build the status strip view from an H06 profiler summary. Rows are frozen
 * snapshots: per model sorted by name (the summary's order), then the
 * overall row last. An empty summary yields a single idle overall row.
 */
export function buildStatusStrip(summary: ProfileSummary, options: StatusStripOptions = {}): HarnessStatusStrip {
  const quota = options.quota && options.quota.totalTokens > 0 ? { totalTokens: Math.round(options.quota.totalTokens) } : undefined;
  if (options.quota && options.quota.totalTokens <= 0) throw new Error("status strip quota must be a positive token budget");
  const warnAt = options.warnAt ?? 0.8;
  const criticalAt = options.criticalAt ?? 0.95;
  const title = options.title ?? "harness";

  const modelRows = summary.models.map((aggregate) => buildRow(aggregate, quota, warnAt, criticalAt, aggregate.model));
  const overall = buildRow(summary.overall, quota, warnAt, criticalAt, title);
  const rows = Object.freeze([...modelRows, overall]);

  return {
    rows,
    overall,
    byModel(model: string): StatusStripRow | null {
      return rows.find((row) => row.model === model) ?? null;
    },
    render(): string {
      const line = rows.map((row) => row.text).join(" | ");
      return `[${title}] ${line}`;
    },
  };
}
