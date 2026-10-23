import React from "react";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { mergeTimelineRowsByIdentity, stabilizeTimelineRows, type TimelineRow } from "../../xuenessWorkbench";
import { projectSnapshotTimelineRows } from "./paneConversation";
import { projectSubagentRows, subagentDetailAllowed, type SubagentRow } from "./subagentRows";
import { SubagentRowView } from "./SubagentRowView";
import { SubagentStepProgress } from "./subagentRowProgress";
import { ZCodeConversation } from "./ZCodeConversation";
import { conversationFindRowKey, conversationFindText } from "./ConversationFind";

const parentId = "a".repeat(32);
const childId = "b".repeat(32);
const enabled = new Set(["sessions", "subagents", "files"]);
const tool = (id: string, seq: number): TimelineRow => ({ kind: "tool", seq, turnId: "turn-1", toolCallId: id,
  name: "task", subject: "Read-only review", status: "ok", error: "", errorCode: "" });
const receipt = (call: string, task: string, summary = "bounded finding") => ({ tool_call_id: call, task_id: task,
  agent: "reviewer", label: "Review", status: "completed", summary, child_session_id: childId });
const getRow = (summary = "bounded finding"): SubagentRow => projectSubagentRows([tool("call-1", 2)], {
  message_subagents: [receipt("call-1", "task-one", summary)],
}).find((row): row is SubagentRow => row.kind === "subagent")!;

test("subagent sidecars bind concurrent calls by identity and remain idempotent", () => {
  const input = [tool("call-1", 2), tool("call-2", 3)];
  const journal = { message_subagents: [receipt("call-2", "task-two"), receipt("call-1", "task-one"), receipt("missing", "task-absent")] };
  const projected = projectSubagentRows(input, journal);
  assert.deepEqual(projected.map(row => row.kind === "subagent" ? row.taskId : row.kind), ["tool", "task-one", "tool", "task-two"]);
  assert.deepEqual(projectSubagentRows(projected, journal), projected);
  assert.deepEqual(projectSubagentRows(projected, {}), input);
  assert.deepEqual(projectSubagentRows([tool("other", 4)], journal), [tool("other", 4)]);
});

test("untrusted sidecars cannot create tasks, expose bodies or bind unrelated tools", () => {
  const raw = { ...receipt("call-1", "task-one", "x".repeat(1000)), label: "L".repeat(200), status: "invented-success",
    messages: "SECRET-TRANSCRIPT", prompt: "SECRET-PROMPT", tools: ["exec"], child_session_id: "../escape" };
  const rows = projectSubagentRows([tool("call-1", 2)], { message_subagents: [raw] });
  const row = rows[1] as SubagentRow;
  assert.equal(row.status, "unknown");
  assert.equal(row.summary.length, 600);
  assert.equal(row.label.length, 80);
  assert.equal(row.childSessionId, undefined);
  assert.doesNotMatch(JSON.stringify(rows), /SECRET|escape|exec/);
  const invalid = [receipt("call-1", "../foreign"), { ...raw, tool_call_id: "call-1\n" }];
  assert.equal(projectSubagentRows([tool("call-1", 2)], { message_subagents: invalid }).length, 1);
  assert.equal(projectSubagentRows([{ ...tool("call-1", 2), name: "read" } as TimelineRow], { message_subagents: [raw] }).length, 1);
  assert.equal(projectSubagentRows([tool("call-1", 2)], { message_subagents: [raw, raw, raw] }).length, 1);
  const many = Array.from({ length: 40 }, (_, i) => receipt(`call-${i}`, `task-${i}`));
  assert.equal(projectSubagentRows(many.map((_, i) => tool(`call-${i}`, i + 1)), { message_subagents: many })
    .filter(row => row.kind === "subagent").length, 32);
});

test("snapshot projection adds subagent work without changing events or crossing pages", () => {
  const snapshot: Parameters<typeof projectSnapshotTimelineRows>[0] = {
    session: { id: parentId, task: "review", status: "completed", steps: 1, mode: "plan", pending: [],
      approved: { write: [], edit: [], exec: [], mcp: [] }, changed_files: [] },
    journal: { messages: [{ role: "user", content: "review", _message_id: "user-1", _turn_id: "turn-1" }],
      message_subagents: [receipt("call-1", "task-one")] },
    timeline: { cursor: 0, nextCursor: 1, head: 1, hasMore: false,
      events: [{ schema: "xueness.event.v1", sessionId: parentId, type: "tool.call", seq: 1, turnId: "turn-1", toolCallId: "call-1", name: "task", subject: "review" }] },
  };
  const original = JSON.stringify(snapshot);
  const rows = projectSnapshotTimelineRows(snapshot, false);
  assert.deepEqual(rows.map(row => row.kind), ["user", "tool", "subagent"]);
  assert.equal(JSON.stringify(snapshot), original);
  const otherPage = { ...snapshot, timeline: { ...snapshot.timeline, events: [] } };
  assert.equal(projectSnapshotTimelineRows(otherPage, false).some(row => row.kind === "subagent"), false);
});

test("subagent status updates retain stable identity across transcript windows", () => {
  const initial = getRow();
  const next = { ...initial, status: "failed" as const, summary: "failed finding" };
  const counted = { ...initial, steps: 2 };
  const recounted = { ...counted, steps: 3 };
  assert.strictEqual(stabilizeTimelineRows([initial], [{ ...initial }])[0], initial);
  assert.strictEqual(stabilizeTimelineRows([initial], [next])[0], next);
  assert.strictEqual(stabilizeTimelineRows([counted], [{ ...counted }])[0], counted);
  assert.strictEqual(stabilizeTimelineRows([counted], [recounted])[0], recounted);
  assert.deepEqual(mergeTimelineRowsByIdentity([initial], [next]), [next]);
  assert.deepEqual(mergeTimelineRowsByIdentity([counted], [recounted]), [recounted]);
  assert.equal(conversationFindRowKey(initial), conversationFindRowKey(next));
  assert.match(conversationFindText(next), /failed finding/);
});

test("bounded step counts refresh the row and keep their wording out of the static shell", () => {
  const source = readFileSync(resolve(process.cwd(), "src/plugins/sessions/SubagentRowView.tsx"), "utf8");
  assert.match(source, /import\(\s*["']\.\/subagentRowProgress["']\s*\)/);
  assert.doesNotMatch(source, /from\s+["']\.\/subagentRowProgress["']/);
  const withSteps = projectSubagentRows([tool("call-1", 2)], {
    message_subagents: [{ ...receipt("call-1", "task-one"), steps: 4, work_items: ["SECRET-ITEM"], prompt: "SECRET-PROMPT" }],
  });
  const row = withSteps.find((item): item is SubagentRow => item.kind === "subagent")!;
  assert.equal(row.steps, 4);
  assert.equal(row.status, "completed");
  assert.doesNotMatch(JSON.stringify(withSteps), /SECRET|work_items/);
  for (const steps of [0, 65, 1.5, true, "4", -1, null]) {
    const projected = projectSubagentRows([tool("call-1", 2)], {
      message_subagents: [{ ...receipt("call-1", "task-one"), steps }],
    }).find((item): item is SubagentRow => item.kind === "subagent")!;
    assert.equal(projected.steps, undefined);
  }
  const shell = renderToStaticMarkup(<SubagentRowView row={row} sessionId={parentId} effectivePluginIds={enabled} />);
  assert.match(shell, /data-task-status="completed"/);
  assert.match(shell, /data-task-steps="4"/);
  assert.doesNotMatch(shell, /已进行|SECRET|subagent-row-steps/);
  const progress = renderToStaticMarkup(<SubagentStepProgress steps={4} />);
  assert.match(progress, /已进行 4 步/);
  assert.match(progress, /data-testid="subagent-row-steps"/);
  assert.doesNotMatch(progress, /SECRET|<button|javascript:/);
  assert.equal(renderToStaticMarkup(<SubagentRowView row={row} effectivePluginIds={new Set(["subagents"])} />), "");
});

test("summary rendering is safe and details fail closed with disabled owners", () => {
  const row = getRow('<img src="https://example.invalid/x" onerror="bad()"> [secret](javascript:bad())');
  const render = (plugins: Set<string> | undefined, sessionId = parentId) => renderToStaticMarkup(
    <SubagentRowView row={row} sessionId={sessionId} effectivePluginIds={plugins} findActive />);
  assert.equal(render(undefined), "");
  assert.equal(render(new Set(["subagents"])), "");
  const safe = render(new Set(["sessions"]));
  assert.match(safe, /&lt;img/);
  assert.doesNotMatch(safe, /<img|<a |subagent-row-detail|subagent-transcript-/);
  assert.match(render(enabled), /subagent-row-detail-task-one/);
  assert.doesNotMatch(render(enabled, "../foreign"), /subagent-row-detail/);
  assert.equal(subagentDetailAllowed({ ...row, childSessionId: parentId }, parentId, enabled), false);
  assert.equal(subagentDetailAllowed(row, parentId, new Set(["sessions", "files"])), false);
  assert.equal(subagentDetailAllowed(row, parentId, new Set(["sessions", "subagents"])), false);
  const collapsed = renderToStaticMarkup(<SubagentRowView row={row} sessionId={parentId} effectivePluginIds={enabled} />);
  assert.doesNotMatch(collapsed, /example.invalid|subagent-transcript-/);
});

test("conversation turn groups include searchable subagent summaries in work", () => {
  const row = getRow("unique-subagent-finding");
  const rows: TimelineRow[] = [{ kind: "user", seq: 0, turnId: "turn-1", text: "review" }, tool("call-1", 2), row,
    { kind: "assistant", seq: 3, turnId: "turn-1", text: "done" }];
  const html = renderToStaticMarkup(<ZCodeConversation rows={rows} sessionId={parentId} effectivePluginIds={enabled} findQuery="unique-subagent-finding" />);
  assert.match(html, /data-zcode-row-kind="subagent"/);
  assert.match(html, /unique-subagent-finding/);
  const disabled = renderToStaticMarkup(<ZCodeConversation rows={rows} effectivePluginIds={new Set(["subagents"])} findQuery="unique-subagent-finding" />);
  assert.doesNotMatch(disabled, /data-zcode-row-kind="subagent"|subagent-row-detail/);
});
