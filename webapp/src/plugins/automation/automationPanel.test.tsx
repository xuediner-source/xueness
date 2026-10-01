import React from "react";
import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { setLocale } from "../../i18n";
import { AutomationCard, AutomationDetail } from "./index";
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
