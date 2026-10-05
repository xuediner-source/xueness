/**
 * 工作台用量速览（usage.quick_card）的前端回归。
 *
 * 全部走 renderToStaticMarkup：断言只统计服务商实际报告的用量、没有报告时
 * 显示「暂无实际用量」，以及 usage 插件关闭时入口完全不渲染（fail-closed）。
 */
import React from "react";
import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import {
  XuenessUsageQuickCard,
  XuenessUsageQuickCardView,
  sumSessionProviderUsage,
  todayUsageFromSummary,
} from "./XuenessUsageQuickCard";
import type { UsageSummary } from "../../xuenessWorkspace";

// -- 纯聚合函数 ---------------------------------------------------------------

test("sumSessionProviderUsage: 累加完整报告的请求，缺失或非法记录不参与求和", () => {
  assert.equal(sumSessionProviderUsage(undefined), null);
  assert.equal(sumSessionProviderUsage([]), null);
  assert.equal(sumSessionProviderUsage("not-a-list"), null);
  assert.deepEqual(
    sumSessionProviderUsage([
      { usage: { prompt_tokens: 10, completion_tokens: 5 } },
      { usage: { input_tokens: 7, output_tokens: 3 } },
    ]),
    { inputTokens: 17, outputTokens: 8, totalTokens: 25, requests: 2 },
  );
  // 缺输出、缺输入、负值、非对象记录都被跳过；没有完整报告就返回 null。
  assert.equal(sumSessionProviderUsage([
    { usage: { prompt_tokens: 10 } },
    { usage: { completion_tokens: 2 } },
    { usage: { prompt_tokens: -1, completion_tokens: 2 } },
    "junk",
    null,
    { noUsage: true },
  ]), null);
});

test("todayUsageFromSummary: 只取今天的按日报告；没有今天或总量为零返回 null", () => {
  const now = new Date(2026, 9, 5, 12, 0, 0); // 本地 2026-10-05
  const usage = {
    dailyUsage: [
      { date: "2026-10-04", inputTokens: 1, outputTokens: 1, totalTokens: 999, requestCount: 1 },
      { date: "2026-10-05", inputTokens: 200, outputTokens: 100, totalTokens: 300, requestCount: 3 },
    ],
  } as UsageSummary;
  assert.deepEqual(todayUsageFromSummary(usage, now), {
    inputTokens: 200, outputTokens: 100, totalTokens: 300, requests: 3,
  });
  const yesterdayOnly = { dailyUsage: usage.dailyUsage?.slice(0, 1) } as UsageSummary;
  assert.equal(todayUsageFromSummary(yesterdayOnly, now), null);
  const zeroToday = { dailyUsage: [{ date: "2026-10-05", inputTokens: 0, outputTokens: 0, totalTokens: 0, requestCount: 0 }] } as UsageSummary;
  assert.equal(todayUsageFromSummary(zeroToday, now), null);
  assert.equal(todayUsageFromSummary(null, now), null);
  assert.equal(todayUsageFromSummary({} as UsageSummary, now), null);
});

// -- 组件 ---------------------------------------------------------------------

test("usage 插件关闭时不渲染用量入口，也不留任何标记", () => {
  const html = renderToStaticMarkup(<XuenessUsageQuickCard enabled={false} />);
  assert.equal(html, "");
});

test("用量速览入口：插件生效时渲染小按钮并透传会话用量", () => {
  const html = renderToStaticMarkup(
    <XuenessUsageQuickCard
      enabled
      sessionProviderUsage={[{ usage: { prompt_tokens: 12, completion_tokens: 8 } }]}
      onOpenPanel={() => undefined}
    />,
  );
  assert.match(html, /data-testid="usage-quick-trigger"/);
  assert.match(html, /aria-haspopup="dialog"/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /用量/);
});

test("用量速览卡片：本会话与今日分开展示，无报告显示「暂无实际用量」", () => {
  const html = renderToStaticMarkup(
    <XuenessUsageQuickCardView
      sessionUsage={{ inputTokens: 12, outputTokens: 8, totalTokens: 20, requests: 1 }}
      todayUsage={null}
      loading={false}
      error=""
      onRefresh={() => undefined}
      onOpenPanel={() => undefined}
      onClose={() => undefined}
    />,
  );
  assert.match(html, /data-testid="usage-quick-card"/);
  assert.match(html, /role="dialog"/);
  assert.match(html, /本会话/);
  assert.match(html, /今日/);
  assert.match(html, /<strong>12<\/strong>/);
  assert.match(html, /<strong>8<\/strong>/);
  // 今日没有服务商报告 → 明确写「暂无实际用量」，不编造 0。
  assert.match(html, /暂无实际用量/);
  // 刷新与「打开用量面板」都在。
  assert.match(html, /data-testid="usage-quick-refresh"/);
  assert.match(html, /data-testid="usage-quick-open"/);
  assert.match(html, /打开用量面板/);
});

test("用量速览卡片：加载与失败状态可见，两个区块都没有报告时统一显示暂无", () => {
  const loading = renderToStaticMarkup(
    <XuenessUsageQuickCardView
      sessionUsage={null} todayUsage={null} loading error=""
      onRefresh={() => undefined} onOpenPanel={() => undefined} onClose={() => undefined}
    />,
  );
  assert.match(loading, /is-spinning/);
  assert.match(loading, /disabled/);
  const failed = renderToStaticMarkup(
    <XuenessUsageQuickCardView
      sessionUsage={null} todayUsage={null} loading={false} error="HTTP 500"
      onRefresh={() => undefined} onOpenPanel={() => undefined} onClose={() => undefined}
    />,
  );
  assert.match(failed, /role="alert"/);
  assert.match(failed, /HTTP 500/);
  const empty = renderToStaticMarkup(
    <XuenessUsageQuickCardView
      sessionUsage={null} todayUsage={null} loading={false} error=""
      onRefresh={() => undefined} onOpenPanel={() => undefined} onClose={() => undefined}
    />,
  );
  assert.equal((empty.match(/暂无实际用量/g) ?? []).length, 2);
});
