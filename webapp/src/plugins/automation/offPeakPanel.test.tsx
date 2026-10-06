import React from "react";
import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { setLocale } from "../../i18n";
import { OffPeakTaskCard, OffPeakTasks } from "./OffPeakTasks";
import {
  attemptIds,
  describeWindow,
  emptyOffPeakDraft,
  offPeakDraftForApi,
  pendingNotices,
  queuedCount,
  validateOffPeakDraft,
  validateWindow,
} from "./offPeakModel";
import type { OffPeakTaskRecord } from "../../xuenessApi";

const queued: OffPeakTaskRecord = {
  id: "task-1",
  name: "周报",
  prompt: "整理本周的构建日志",
  root: "/workspace/project",
  model: "local-model",
  provider_id: null,
  deadlineSeconds: 3600,
  onlyWhenIdle: true,
  window: null,
  timezone: null,
  status: "queued",
  createdAt: 1_799_000_000,
  nextEligibleAt: 1_799_000_000,
  holdUntil: 1_799_030_000,
  approved: false,
  allowReal: false,
  runId: null,
  workflowId: null,
  claimedAt: null,
  finishedAt: null,
  digest: "0123456789abcdef0123456789abcdef",
  history: [{ id: "attempt-1", at: 1_799_000_500, status: "awaiting_approval", error: "operator approval is required" }],
};

const finished: OffPeakTaskRecord = {
  ...queued,
  id: "task-2",
  name: "依赖升级体检",
  status: "completed",
  approved: true,
  history: [
    { id: "attempt-1", at: 1_799_000_500, status: "awaiting_approval" },
    { id: "attempt-2", at: 1_799_010_000, status: "completed", workflowId: "workflow-9" },
  ],
};

const cardProps = {
  busy: false,
  approving: false,
  approveReal: true,
  onApproveReal: () => {},
  onBeginApprove: () => {},
  onCancelApprove: () => {},
  onApprove: () => {},
  onRun: () => {},
  onCancel: () => {},
};

test("off-peak panel renders nothing and issues no request while its plugin is closed", () => {
  assert.equal(renderToStaticMarkup(<OffPeakTasks />), "");
  assert.equal(renderToStaticMarkup(<OffPeakTasks enabled={false} />), "");
});

test("off-peak panel opens the queue with its window and an explicit approval notice", () => {
  const html = renderToStaticMarkup(<OffPeakTasks enabled />);
  assert.match(html, /offpeak-panel/);
  assert.match(html, /闲时任务/);
  assert.match(html, /00:00–08:00/);
  assert.match(html, /设置闲时窗口/);
  assert.match(html, /排入闲时任务/);
  assert.match(html, /等待窗口/);
  // Server rendering has not run the first list request yet.
  assert.match(html, /正在加载队列/);
  // 表单默认收起，批准选项不能凭空出现在页面上。
  assert.doesNotMatch(html, /批准该不可变计划/);
});

test("off-peak card keeps the immutable plan, the queue hold and the approval gap visible", () => {
  const html = renderToStaticMarkup(<OffPeakTaskCard row={queued} {...cardProps} />);
  assert.match(html, /周报/);
  assert.match(html, /整理本周的构建日志/);
  assert.match(html, /排队中/);
  assert.match(html, /待审批/);
  assert.match(html, /仅在空闲时/);
  assert.match(html, /0123456789ab/);
  assert.match(html, /operator approval is required/);
  assert.match(html, /批准计划/);
  assert.match(html, /立即运行一次/);
});

test("a settled task stops offering run and cancel actions", () => {
  const html = renderToStaticMarkup(<OffPeakTaskCard row={finished} {...cardProps} />);
  assert.match(html, /已完成/);
  assert.match(html, /workflow-9/);
  assert.doesNotMatch(html, /立即运行一次/);
  assert.doesNotMatch(html, /取消任务/);
});

test("notices report one settled attempt once and never replay retained history", () => {
  assert.deepEqual(attemptIds([queued, finished]), ["attempt-1", "attempt-2"]);
  const fresh = pendingNotices([finished], attemptIds([finished]));
  assert.deepEqual(fresh, []);
  const noticed = pendingNotices([finished], []);
  assert.equal(noticed.length, 1);
  assert.equal(noticed[0].attemptId, "attempt-2");
  assert.equal(noticed[0].workflowId, "workflow-9");
  assert.equal(pendingNotices([queued], []).length, 1);
  // 仍在运行的尝试只有一条 started 记录，不构成完成通知。
  assert.equal(pendingNotices([{ ...finished, status: "running", history: [{ id: "attempt-3", at: 1_799_011_000, status: "started" }] }], []).length, 0);
  assert.equal(queuedCount([queued, finished]), 1);
});

test("draft validation mirrors the queue limits before a request leaves the browser", () => {
  const base = { ...emptyOffPeakDraft("/workspace/project") };
  assert.equal(validateOffPeakDraft({ ...base, prompt: "整理日志" }), null);
  assert.match(validateOffPeakDraft({ ...base, prompt: "  " }) || "", /任务说明/);
  assert.match(validateOffPeakDraft({ ...base, prompt: "x", root: "relative/path" }) || "", /绝对路径/);
  assert.match(validateOffPeakDraft({ ...base, prompt: "x", deadlineSeconds: 30 }) || "", /60 到 14400/);
  assert.match(validateOffPeakDraft({ ...base, prompt: "x", allowReal: true }) || "", /批准/);

  const payload = offPeakDraftForApi({ ...base, prompt: "  整理日志  ", name: "  ", model: " x ", allowReal: true, approveExecution: true });
  assert.equal(payload.prompt, "整理日志");
  assert.equal(payload.name, undefined);
  assert.equal(payload.model, "x");
  assert.equal(payload.confirm, true);
  assert.equal(payload.allowReal, true);
});

test("window copy explains a range that crosses midnight", () => {
  assert.equal(describeWindow({ start: "00:00", end: "08:00" }), "00:00–08:00");
  assert.equal(describeWindow({ start: "22:00", end: "06:00" }, (key) => key), "22:00–06:00（跨午夜）");
  assert.equal(validateWindow({ start: "02:00", end: "02:00" }), "窗口的开始与结束时间不能相同。");
  assert.equal(validateWindow({ start: "25:00", end: "06:00" }), "窗口时间需要是 HH:MM。");
  assert.equal(validateWindow({ start: "01:00", end: "05:00" }), null);
});

test("off-peak copy is translated in English", () => {
  try {
    setLocale("en");
    const html = renderToStaticMarkup(<OffPeakTasks enabled />);
    assert.match(html, /Off-peak tasks/);
    assert.match(html, /Set the off-peak window/);
    assert.match(html, /Queue an off-peak task/);
    const card = renderToStaticMarkup(<OffPeakTaskCard row={queued} {...cardProps} />);
    assert.match(card, /Queued/);
    assert.match(card, /Awaiting approval/);
    assert.match(card, /Idle only/);
  } finally {
    setLocale("zh");
  }
});
