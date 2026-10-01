import React from "react";
import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { XuenessDiagnosticsPanel } from "./plugins/diagnostics";
import { XuenessMemoryEditor } from "./plugins/memory";
import { XuenessAutomationsPanel } from "./plugins/automation";
import { XuenessMarketplace } from "./plugins/extensions";
import { XuenessMcpTools } from "./plugins/mcp";

test("memory editor never loads private track content on mount", () => {
  const html = renderToStaticMarkup(<XuenessMemoryEditor />);
  assert.match(html, /memory-editor/);
  assert.match(html, /加载内容/);
  assert.doesNotMatch(html, /<textarea/);
});

test("diagnostics exposes reviewable export and cleanup controls without auto-cleaning", () => {
  const html = renderToStaticMarkup(<XuenessDiagnosticsPanel />);
  assert.match(html, /diagnostics-panel/);
  assert.match(html, /导出脱敏 JSON/);
  assert.match(html, /disabled=""[^>]*>导出脱敏 JSON/);
  assert.doesNotMatch(html, /清理旧日志/);
  assert.doesNotMatch(html, /role="alertdialog"/);
});

test("automation shows supported scheduled work while the marketplace remains a safe empty state", () => {
  const automation = renderToStaticMarkup(<XuenessAutomationsPanel />);
  assert.match(automation, /automations-panel/);
  assert.match(automation, /定时计划/);
  assert.match(automation, /当前支持定时触发/);
  assert.match(automation, /新建定时计划/);
  assert.doesNotMatch(automation, /闲时任务/);
  const marketplace = renderToStaticMarkup(<XuenessMarketplace />);
  assert.match(marketplace, /marketplace-panel/);
  assert.match(marketplace, /不执行下载的代码/);
});

test("MCP tools render no connection action for an empty catalog", () => {
  const html = renderToStaticMarkup(<XuenessMcpTools />);
  assert.match(html, /mcp-management/);
  assert.match(html, /只有点击并确认后才连接服务器/);
  assert.doesNotMatch(html, /发现资源/);
});
