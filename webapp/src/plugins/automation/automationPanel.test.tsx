import React from "react";
import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { setLocale } from "../../i18n";
import { AutomationCard, AutomationDetail, XuenessAutomationsPanel } from "./index";
import type { AutomationRecord } from "../../xuenessApi";

const record: AutomationRecord = {
  id: "automation-1",
  name: "Weekday check",
  schedule: "0 9 * * 1-5",
  timezone: "Asia/Shanghai",
  enabled: true,
  approved: false,
  approvalRequired: true,
  nextRunAt: 1_800_000_000,
  workflow: {
    root: "/workspace/project",
    name: "Review",
    concurrency: 2,
    nodes: [
      { id: "lint", kind: "command", needs: [], argv: ["npm", "run", "lint"], cwd: ".", timeout: 120 },
      { id: "review", kind: "agent", needs: ["lint"], prompt: "Review changes", cwd: ".", timeout: 300 },
    ],
  },
  history: [
    { id: "run-1", at: 1_799_000_000, status: "awaiting_approval", workflowId: "workflow-1" },
    { id: "run-2", at: 1_799_500_000, status: "failed", error: "workflow launch failed" },
  ],
};

test("automation card summarizes schedule, approval, workflow, and the latest backend run", () => {
  const html = renderToStaticMarkup(<AutomationCard record={record} busy={false} onOpen={() => {}} onEdit={() => {}} onApprove={() => {}} onRun={() => {}} onDelete={() => {}} />);
  assert.match(html, /Weekday check/);
  assert.match(html, /工作日 · 09:00/);
  assert.match(html, /待审批/);
  assert.match(html, /Review/);
  assert.match(html, /启动失败/);
  assert.match(html, /查看详情和历史/);
  assert.match(html, /xn-automation__button--primary/);
  assert.match(html, /xn-automation__next-run/);
});

test("the overview provides loading feedback before the initial request resolves", () => {
  const html = renderToStaticMarkup(<XuenessAutomationsPanel />);
  assert.match(html, /data-testid="automation-overview"/);
  assert.match(html, /role="status"/);
  assert.match(html, /正在加载计划/);
});

test("the prominent card action follows approval state", () => {
  const approved = { ...record, approved: true };
  const html = renderToStaticMarkup(<AutomationCard record={approved} busy={false} onOpen={() => {}} onEdit={() => {}} onApprove={() => {}} onRun={() => {}} onDelete={() => {}} />);
  assert.match(html, /class="xn-automation__button--primary"[^>]*>立即运行</);
  assert.doesNotMatch(html, /class="xn-automation__button--primary"[^>]*>批准计划</);
});

test("automation detail shows the executable workflow model and retained run history", () => {
  const html = renderToStaticMarkup(<AutomationDetail record={record} busy={false} onBack={() => {}} onEdit={() => {}} onApprove={() => {}} onRun={() => {}} onDelete={() => {}} />);
  assert.match(html, /data-testid="automation-detail"/);
  assert.match(html, /工作流步骤/);
  assert.match(html, /npm run lint/);
  assert.match(html, /Review changes/);
  assert.match(html, /运行历史/);
  assert.match(html, /workflow-1/);
  assert.match(html, /workflow launch failed/);
});

test("automation cards and history use the new English translations", () => {
  try {
    setLocale("en");
    const card = renderToStaticMarkup(<AutomationCard record={record} busy={false} onOpen={() => {}} onEdit={() => {}} onApprove={() => {}} onRun={() => {}} onDelete={() => {}} />);
    const detail = renderToStaticMarkup(<AutomationDetail record={record} busy={false} onBack={() => {}} onEdit={() => {}} onApprove={() => {}} onRun={() => {}} onDelete={() => {}} />);
    assert.match(card, /Weekdays · 09:00/);
    assert.match(card, /Awaiting approval/);
    assert.match(card, /View details and history/);
    assert.match(detail, /Run history/);
    assert.match(detail, /Workflow steps/);
  } finally {
    setLocale("zh");
  }
});
