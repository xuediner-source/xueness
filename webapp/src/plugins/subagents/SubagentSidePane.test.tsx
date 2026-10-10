import React from "react";
import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import {
  SubagentSidePane,
  formatTaskDuration,
  formatTaskStatus,
  type SubagentTaskItem,
} from "./SubagentSidePane";

test('context summary distinguishes completed, failed and cancelled tasks without inventing completion',()=>{
  const initialTasks=['completed','failed','cancelled'].map((status,index)=>({id:String(index),status,steps:0}));
  const html=renderToStaticMarkup(<SubagentSidePane mode="summary" sessionId="session" initialTasks={initialTasks} onOpenTasks={()=>undefined} />);
  assert.match(html,/1 已完成/u);
  assert.match(html,/1 失败/u);
  assert.match(html,/1 已取消/u);
  assert.doesNotMatch(html,/3 已完成/u);
  assert.equal(renderToStaticMarkup(<SubagentSidePane mode="summary" lightweight initialTasks={initialTasks} />),'');
});

test("formatTaskDuration formats various durations properly", () => {
  assert.equal(formatTaskDuration(null, null), "-");
  assert.equal(formatTaskDuration(undefined, undefined), "-");
  assert.equal(formatTaskDuration(0, 0), "-");
  assert.equal(formatTaskDuration(-5, 0), "-");

  // Sub-second
  assert.equal(formatTaskDuration(100, 100.5), "< 1s");

  // Under a minute
  assert.equal(formatTaskDuration(100, 115.2), "15.2s");

  // Over a minute
  assert.equal(formatTaskDuration(100, 225), "2m 5s");
  assert.equal(formatTaskDuration(100, 160), "1m 0s");
});

test("formatTaskStatus maps statuses to localized labels and tones", () => {
  assert.deepEqual(formatTaskStatus("running"), { label: "运行中", tone: "warn" });
  assert.deepEqual(formatTaskStatus("completed"), { label: "已完成", tone: "ok" });
  assert.deepEqual(formatTaskStatus("failed"), { label: "失败", tone: "error" });
  assert.deepEqual(formatTaskStatus("cancelled"), { label: "已取消", tone: "muted" });
  assert.deepEqual(formatTaskStatus("custom_state"), { label: "custom_state", tone: "muted" });
});

test("lightweight mode suppresses rendering and returns null", () => {
  const htmlExplicit = renderToStaticMarkup(
    <SubagentSidePane
      sessionId="sess-1"
      isOpen={true}
      lightweight={true}
      initialTasks={[{ id: "task-1", status: "running", steps: 1 }]}
    />
  );
  assert.equal(htmlExplicit, "");

  const htmlProfile = renderToStaticMarkup(
    <SubagentSidePane
      sessionId="sess-1"
      isOpen={true}
      activeRuntimeProfile="lightweight"
      initialTasks={[{ id: "task-1", status: "running", steps: 1 }]}
    />
  );
  assert.equal(htmlProfile, "");
});

test("closed sidepane returns null in sidepane mode but renders in panel mode", () => {
  const htmlSidepaneClosed = renderToStaticMarkup(
    <SubagentSidePane
      sessionId="sess-1"
      isOpen={false}
      mode="sidepane"
      initialTasks={[]}
    />
  );
  assert.equal(htmlSidepaneClosed, "");

  const htmlPanelClosed = renderToStaticMarkup(
    <SubagentSidePane
      sessionId="sess-1"
      isOpen={false}
      mode="panel"
      initialTasks={[]}
    />
  );
  assert.match(htmlPanelClosed, /xn-subagent-sidepane--panel/);
});

test("renders disabled state when subagents plugin is not effective", () => {
  const html = renderToStaticMarkup(
    <SubagentSidePane
      sessionId="sess-1"
      isOpen={true}
      subagentsEnabled={false}
    />
  );
  assert.match(html, /子代理插件已禁用/);
  assert.match(html, /subagent-sidepane-disabled/);
});

test("renders no-session placeholder when sessionId is null", () => {
  const html = renderToStaticMarkup(
    <SubagentSidePane
      sessionId={null}
      isOpen={true}
      subagentsEnabled={true}
    />
  );
  assert.match(html, /选择会话后查看子代理任务。/);
  assert.match(html, /subagent-sidepane-no-session/);
});

test("renders empty state when there are no subagent tasks", () => {
  const html = renderToStaticMarkup(
    <SubagentSidePane
      sessionId="sess-1"
      isOpen={true}
      subagentsEnabled={true}
      initialTasks={[]}
    />
  );
  assert.match(html, /暂无子代理任务/);
  assert.match(html, /subagent-sidepane-empty/);
});

test("renders running, completed, failed, and cancelled tasks", () => {
  const tasks: SubagentTaskItem[] = [
    {
      id: "task-run-1",
      agent: "explorer",
      status: "running",
      steps: 4,
      startedAt: 1000,
      endedAt: null,
      summary: "Scanning files...",
    },
    {
      id: "task-done-2",
      agent: "analyzer",
      status: "completed",
      steps: 8,
      startedAt: 1000,
      endedAt: 1025,
      summary: "Analysis complete with 0 issues.",
    },
    {
      id: "task-fail-3",
      agent: "builder",
      status: "failed",
      steps: 2,
      startedAt: 1000,
      endedAt: 1010,
      error: "Command timed out after 10s",
    },
    {
      id: "task-cancel-4",
      status: "cancelled",
      steps: 1,
      startedAt: 1000,
      endedAt: 1005,
    },
  ];

  const html = renderToStaticMarkup(
    <SubagentSidePane
      sessionId="sess-1"
      isOpen={true}
      subagentsEnabled={true}
      initialTasks={tasks}
    />
  );

  // Header count badge reflects running tasks
  assert.match(html, /1 运行中/);

  // Section headers
  assert.match(html, /运行中 · 1/);
  assert.match(html, /已结束 · 3/);

  // Running task card
  assert.match(html, /data-testid="subagent-task-task-run-1"/);
  assert.match(html, /explorer/);
  assert.match(html, /第 4 步/);

  // Completed task card
  assert.match(html, /data-testid="subagent-task-task-done-2"/);
  assert.match(html, /analyzer/);
  assert.match(html, /已完成/);
  assert.match(html, /第 8 步/);
  assert.match(html, /Analysis complete with 0 issues\./);
  assert.doesNotMatch(html, /data-testid="subagent-cancel-task-done-2"/);

  // Failed task card
  assert.match(html, /data-testid="subagent-task-task-fail-3"/);
  assert.match(html, /builder/);
  assert.match(html, /失败/);
  assert.match(html, /Command timed out after 10s/);

  // Cancelled task card (uses default agent label 'general-purpose')
  assert.match(html, /data-testid="subagent-task-task-cancel-4"/);
  assert.match(html, /general-purpose/);
  assert.match(html, /已取消/);

  // With the experiment off, the sidepane keeps exactly one stop control: the
  // session-level one in the header. No per-card control and no stale copy.
  assert.match(html, /data-testid="subagent-stop-session"/);
  assert.match(html, /中止整个会话/);
  assert.doesNotMatch(html, /停止会话（取消全部子任务）/);
  assert.doesNotMatch(html, /目前没有单个子任务的取消接口/);
});

const MIXED_TASKS: SubagentTaskItem[] = [
  { id: "task-live-1", agent: "explorer", status: "running", steps: 3, startedAt: 1000, endedAt: null },
  { id: "task-live-2", agent: "reviewer", status: "running", steps: 1, startedAt: 1001, endedAt: null },
  { id: "task-over-1", agent: "builder", status: "completed", steps: 6, startedAt: 1002, endedAt: 1030 },
  { id: "task-over-2", agent: "analyzer", status: "failed", steps: 2, startedAt: 1003, endedAt: 1010 },
  { id: "task-over-3", status: "cancelled", steps: 1, startedAt: 1004, endedAt: 1006 },
];

test("cancel-one experiment adds a per-task cancel control to running tasks only", () => {
  const html = renderToStaticMarkup(
    <SubagentSidePane
      sessionId="sess-1"
      isOpen={true}
      subagentsEnabled={true}
      cancelOneEnabled={true}
      initialTasks={MIXED_TASKS}
    />
  );

  // Every running task gets its own cooperative cancel control with the
  // copy that promises a single-subtask scope.
  assert.match(html, /data-testid="subagent-cancel-task-live-1"/);
  assert.match(html, /data-testid="subagent-cancel-task-live-2"/);
  assert.match(html, /取消此项/);
  assert.match(html, /只取消此子任务；主会话和其他子任务继续运行。/);
  assert.doesNotMatch(html, /正在取消此项…/);

  // Ended tasks never expose a cancel control, even with the experiment on.
  for (const id of ["task-over-1", "task-over-2", "task-over-3"]) {
    assert.doesNotMatch(html, new RegExp(`data-testid="subagent-cancel-${id}"`));
  }
  assert.equal([...html.match(/data-testid="subagent-cancel-/g) ?? []].length, 2);

  // The session-level stop control stays available alongside it.
  assert.match(html, /data-testid="subagent-stop-session"/);
  assert.match(html, /停止主会话并取消全部运行中的子任务。/);
});

test("per-task cancel control is absent while the session stop control is not gated by the experiment", () => {
  const render = (cancelOneEnabled: boolean) => renderToStaticMarkup(
    <SubagentSidePane
      sessionId="sess-1"
      isOpen={true}
      subagentsEnabled={true}
      cancelOneEnabled={cancelOneEnabled}
      initialTasks={MIXED_TASKS}
    />
  );

  const off = render(false);
  const on = render(true);

  assert.doesNotMatch(off, /data-testid="subagent-cancel-/);
  assert.doesNotMatch(off, /取消此项/);
  assert.match(on, /data-testid="subagent-cancel-task-live-1"/);

  // Aborting the whole session is not part of the experiment, so it is offered
  // in both flag states and never disappears when the flag is off.
  for (const html of [off, on]) {
    assert.match(html, /data-testid="subagent-stop-session"/);
    assert.match(html, /中止整个会话/);
  }
});

test("session stop control only appears when a subtask is actually running", () => {
  const endedOnly: SubagentTaskItem[] = [
    { id: "task-over-1", agent: "builder", status: "completed", steps: 6, startedAt: 1002, endedAt: 1030 },
  ];

  const noRunning = renderToStaticMarkup(
    <SubagentSidePane sessionId="sess-1" isOpen={true} initialTasks={endedOnly} />
  );
  assert.doesNotMatch(noRunning, /data-testid="subagent-stop-session"/);

  const empty = renderToStaticMarkup(
    <SubagentSidePane sessionId="sess-1" isOpen={true} initialTasks={[]} />
  );
  assert.doesNotMatch(empty, /data-testid="subagent-stop-session"/);

  const noSession = renderToStaticMarkup(
    <SubagentSidePane sessionId={null} isOpen={true} subagentsEnabled={true}
      initialTasks={[{ id: "task-live-1", status: "running", steps: 1 }]} />
  );
  assert.doesNotMatch(noSession, /data-testid="subagent-stop-session"/);

  const pluginOff = renderToStaticMarkup(
    <SubagentSidePane sessionId="sess-1" isOpen={true} subagentsEnabled={false}
      initialTasks={[{ id: "task-live-1", status: "running", steps: 1 }]} />
  );
  assert.doesNotMatch(pluginOff, /data-testid="subagent-stop-session"/);
});

test("sidepane stop controls disappear in lightweight mode with zero rendered chrome", () => {
  const html = renderToStaticMarkup(
    <SubagentSidePane
      sessionId="sess-1"
      isOpen={true}
      lightweight={true}
      cancelOneEnabled={true}
      initialTasks={MIXED_TASKS}
    />
  );
  assert.equal(html, "");
});

test("fetchTasksFn is never called when closed or lightweight", async () => {
  let callCount = 0;
  const mockFetch = async () => {
    callCount += 1;
    return { tasks: [] };
  };

  // Rendering static markup doesn't run useEffect, but verify the component mounts cleanly with custom fetcher
  const html = renderToStaticMarkup(
    <SubagentSidePane
      sessionId="sess-1"
      isOpen={false}
      lightweight={true}
      fetchTasksFn={mockFetch}
    />
  );
  assert.equal(html, "");
  assert.equal(callCount, 0);
});

test("renders custom title alongside agent label and summary fallbacks", () => {
  const tasks: SubagentTaskItem[] = [
    {
      id: "task-named-1",
      title: "代码审查专家",
      agent: "auditor",
      status: "completed",
      steps: 3,
    },
    {
      id: "task-cancelled-2",
      status: "cancelled",
      steps: 1,
    },
  ];

  const htmlSidepane = renderToStaticMarkup(
    <SubagentSidePane
      sessionId="sess-1"
      isOpen={true}
      mode="sidepane"
      initialTasks={tasks}
      onClose={() => {}}
    />
  );

  // Custom title is rendered as main name, and agent type is rendered in parentheses
  assert.match(htmlSidepane, /代码审查专家/);
  assert.match(htmlSidepane, /\(auditor\)/);

  // Summary fallback for completed task without explicit summary
  assert.match(htmlSidepane, /执行完成，暂无摘要/);

  // Summary fallback for cancelled task without summary
  assert.match(htmlSidepane, /暂无进展摘要/);

  // In sidepane mode, close button is "关闭侧栏"
  assert.match(htmlSidepane, /aria-label="关闭侧栏"/);

  const htmlPanel = renderToStaticMarkup(
    <SubagentSidePane
      sessionId="sess-1"
      isOpen={true}
      mode="panel"
      initialTasks={tasks}
      onClose={() => {}}
    />
  );
  // In panel mode, close button is "关闭面板"
  assert.match(htmlPanel, /aria-label="关闭面板"/);
});

