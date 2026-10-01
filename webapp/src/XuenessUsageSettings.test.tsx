import React from "react";
import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import {
  buildUsageChartDays,
  buildUsageHeatmapWeeks,
  XuenessUsageSettingsView,
} from "./XuenessUsageSettings";
import type { UsageSummary } from "./xuenessApi";

function makeUsage(range: string): UsageSummary {
  return {
    range,
    totals: { sessions: 3, steps: 8, completed: 2 },
    series: [],
    updatedAt: "2026-10-01T02:00:00Z",
    tokens: { input: 80, output: 20, total: 100, reportedRequests: 2, unknownRequests: 1 },
    costs: { USD: 0.001 },
    dailyUsage: [
      {
        date: "2026-10-01", inputTokens: 80, outputTokens: 20, totalTokens: 100,
        requestCount: 2, unknownRequests: 1, costs: { USD: 0.001 },
        models: [{
          model: "model-a", protocol: "openai", inputTokens: 80, outputTokens: 20,
          totalTokens: 100, requestCount: 2, unknownRequests: 1, costs: {},
        }],
      },
    ],
    models: [
      { model: "model-a", protocol: "openai", inputTokens: 80, outputTokens: 20, totalTokens: 100, requestCount: 2, unknownRequests: 0, costs: {} },
      { model: null, protocol: null, inputTokens: 0, outputTokens: 0, totalTokens: 0, requestCount: 1, unknownRequests: 1, costs: {} },
    ],
    tokenActivity: { activeDays: 1, peakDayTokens: 100, currentStreakDays: 1, longestStreakDays: 1 },
  };
}

test("usage chart fills missing calendar days without inventing token counts", () => {
  const usage = makeUsage("7d");
  const days = buildUsageChartDays(usage, "7d", new Date("2026-10-01T12:00:00"));
  assert.equal(days.length, 8); // API's rolling seven-day boundary can include eight date labels.
  assert.equal(days[0].date, "2026-09-24");
  assert.equal(days.at(-1)?.date, "2026-10-01");
  assert.equal(days.find((day) => day.date === "2026-10-01")?.totalTokens, 100);
  assert.equal(days.find((day) => day.date === "2026-09-30")?.totalTokens, 0);
});

test("year heatmap has aligned 52-week columns and reports empty days as zero", () => {
  const weeks = buildUsageHeatmapWeeks(makeUsage("all").dailyUsage, new Date("2026-10-01T12:00:00"));
  assert.equal(weeks.length, 52);
  const cells = weeks.flatMap((week) => week.days);
  assert.equal(cells.length, 364);
  assert.equal(cells.find((cell) => cell.date === "2026-10-01")?.level, 4);
  assert.equal(cells.find((cell) => cell.date === "2026-09-30")?.level, 0);
});

test("usage view shows lifetime stats, range tabs, daily chart, costs, and honest unknown model bucket", () => {
  const usage = makeUsage("30d");
  const out = renderToStaticMarkup(<XuenessUsageSettingsView
    locale="zh"
    range="30d"
    onRangeChange={() => {}}
    period={{ usage, error: "", loading: false }}
    lifetime={{ usage: makeUsage("all"), error: "", loading: false }}
    now={new Date("2026-10-01T12:00:00")}
  />);

  assert.match(out, /data-testid="xn-usage-lifetime-stats"/);
  assert.match(out, /role="tab" aria-selected="true">30 天/);
  assert.match(out, /role="img" aria-label=/);
  assert.match(out, /model-a/);
  assert.match(out, /未报告模型/);
  assert.match(out, /0\.001 USD/);
  assert.match(out, /role="grid" aria-label="年度 Token 用量热力图"/);
});

test("usage view keeps a previous-range response out of the newly selected range", () => {
  const out = renderToStaticMarkup(<XuenessUsageSettingsView
    locale="zh"
    range="30d"
    onRangeChange={() => {}}
    period={{ usage: makeUsage("7d"), error: "", loading: true }}
    lifetime={{ usage: makeUsage("all"), error: "", loading: false }}
    now={new Date("2026-10-01T12:00:00")}
  />);
  assert.match(out, /aria-selected="true">30 天/);
  assert.doesNotMatch(out, /id="xn-usage-chart-title"/);
  assert.match(out, /role="status"/);
});

test("usage view renders load errors with retry affordance and loading state", () => {
  const out = renderToStaticMarkup(<XuenessUsageSettingsView
    locale="zh"
    range="7d"
    onRangeChange={() => {}}
    period={{ usage: null, error: "host offline", loading: false }}
    lifetime={{ usage: null, error: "", loading: true }}
    now={new Date("2026-10-01T12:00:00")}
  />);
  assert.match(out, /role="alert"/);
  assert.match(out, /host offline/);
  assert.match(out, /role="status"/);
  assert.match(out, />重试</);
});
