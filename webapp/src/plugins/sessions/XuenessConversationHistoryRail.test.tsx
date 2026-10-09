import React from "react";
import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { TimelineStream } from "./XuenessTimeline";
import {
  buildConversationHistoryItems,
  getConversationHistoryScrollTop,
  getHistoryRailScrollTop,
  getNextHistoryFocusIndex,
  resolveHistoryStopTickOpacity,
  resolveHistoryStopVisualState,
  resolveActiveHistorySequence,
  resolveVisibleHistorySequence,
} from "./XuenessConversationHistoryRail";
import type { TimelineRow } from "../../xuenessWorkbench";

function makeRows(): TimelineRow[] {
  return [
    { kind: "user", seq: 3, turnId: "turn-a", text: "First user question" },
    { kind: "assistant", seq: 4, turnId: "turn-a", text: "First public reply", reasoning: "private thought" },
    { kind: "tool", seq: 5, turnId: "turn-a", toolCallId: "tool-a", name: "read", subject: "file", status: "ok", error: "", errorCode: "" },
    { kind: "user", seq: 8, turnId: "turn-b", text: "Second user question" },
    { kind: "assistant", seq: 9, turnId: "turn-b", text: "Partial answer" },
  ];
}

test("history items group by turnId and only public assistant text is used for summaries", () => {
  const rows = makeRows();
  const before = structuredClone(rows);
  assert.deepEqual(buildConversationHistoryItems(rows), [
    { turnId: "turn-a", seq: 3, userText: "First user question", assistantText: "First public reply", isRunning: false },
    { turnId: "turn-b", seq: 8, userText: "Second user question", assistantText: "Partial answer", isRunning: false },
  ]);
  assert.deepEqual(rows, before, "building the rail does not mutate timeline rows");

  const updated = [...rows.slice(0, -1), { kind: "assistant", seq: 9, turnId: "turn-b", text: "Partial answer with more streamed text" } satisfies TimelineRow];
  assert.equal(buildConversationHistoryItems(updated)[1]?.assistantText, "Partial answer with more streamed text");
  assert.doesNotMatch(JSON.stringify(buildConversationHistoryItems(rows)), /private thought/);
});

test("multiple user rows in one turn share a single stop anchored at the first user seq", () => {
  const rows: TimelineRow[] = [
    { kind: "user", seq: 1, turnId: "turn-a", text: "First question" },
    { kind: "user", seq: 2, turnId: "turn-a", text: "Follow-up in the same turn" },
    { kind: "assistant", seq: 3, turnId: "turn-a", text: "Reply" },
    { kind: "user", seq: 4, turnId: "turn-b", text: "Next turn" },
  ];
  const items = buildConversationHistoryItems(rows);
  assert.equal(items.length, 2);
  assert.deepEqual(
    items.map((item) => ({ turnId: item.turnId, seq: item.seq })),
    [{ turnId: "turn-a", seq: 1 }, { turnId: "turn-b", seq: 4 }],
  );
});

test("a streaming assistant row marks its turn as running", () => {
  const rows: TimelineRow[] = [
    { kind: "user", seq: 1, turnId: "turn-a", text: "Question" },
    { kind: "assistant", seq: 2, turnId: "turn-a", text: "Partial", streaming: true },
    { kind: "user", seq: 3, turnId: "turn-b", text: "Other" },
  ];
  const items = buildConversationHistoryItems(rows);
  assert.equal(items[0]?.isRunning, true);
  assert.equal(items[1]?.isRunning, false);
});

test("stop visual state resolves idle/mid/near/peak by distance to the visual focus", () => {
  assert.deepEqual(resolveHistoryStopVisualState(0, undefined), { opacity: 0.58, scaleX: 1, tone: "idle" });
  assert.deepEqual(resolveHistoryStopVisualState(5, undefined), { opacity: 0.58, scaleX: 1, tone: "idle" });
  assert.deepEqual(resolveHistoryStopVisualState(3, 3), { opacity: 1, scaleX: 2.6, tone: "peak" });
  assert.deepEqual(resolveHistoryStopVisualState(4, 3), { opacity: 0.86, scaleX: 1.7, tone: "near" });
  assert.deepEqual(resolveHistoryStopVisualState(1, 3), { opacity: 0.72, scaleX: 1.25, tone: "mid" });
  assert.deepEqual(resolveHistoryStopVisualState(0, 3), { opacity: 0.58, scaleX: 1, tone: "idle" });
  assert.deepEqual(resolveHistoryStopVisualState(9, 3), { opacity: 0.58, scaleX: 1, tone: "idle" });
});

test("running stops keep a minimum opacity of 0.72", () => {
  assert.equal(resolveHistoryStopTickOpacity(true, 0.58), 0.72);
  assert.equal(resolveHistoryStopTickOpacity(true, 1), 1);
  assert.equal(resolveHistoryStopTickOpacity(false, 0.58), 0.58);
});

test("visible stop follows the last user message above the reading threshold", () => {
  assert.equal(resolveVisibleHistorySequence([{ seq: 3, top: 70 }, { seq: 8, top: 320 }, { seq: 11, top: 920 }], 350), 8);
  assert.equal(resolveVisibleHistorySequence([{ seq: 3, top: 70 }, { seq: 8, top: 320 }], -1), 3);
  assert.equal(resolveVisibleHistorySequence([], 100), null);
});

test("active stop remains stable while virtualization has no user anchors mounted", () => {
  assert.equal(resolveActiveHistorySequence(8, [], 100), 8);
  assert.equal(resolveActiveHistorySequence(null, [], 100), null);
  assert.equal(resolveActiveHistorySequence(8, [{ seq: 11, top: 80 }], 100), 11);
});

test("jump math changes only the conversation scroller's scrollTop", () => {
  assert.equal(getConversationHistoryScrollTop(120, 400, 620, 16), 884);
  assert.equal(getConversationHistoryScrollTop(120, 0, 90, 16), 0);
});

test("rail visibility math adjusts only the rail track and leaves visible stops in place", () => {
  assert.equal(getHistoryRailScrollTop(0, 0, 220, 230, 242), 22);
  assert.equal(getHistoryRailScrollTop(40, 40, 260, 22, 34), 22);
  assert.equal(getHistoryRailScrollTop(40, 40, 260, 80, 92), 40);
});

test("keyboard navigation supports arrows, Home and End and stays within the rail", () => {
  assert.equal(getNextHistoryFocusIndex("ArrowDown", 0, 3), 1);
  assert.equal(getNextHistoryFocusIndex("ArrowRight", 1, 3), 2);
  assert.equal(getNextHistoryFocusIndex("ArrowUp", 0, 3), 0);
  assert.equal(getNextHistoryFocusIndex("ArrowLeft", 2, 3), 1);
  assert.equal(getNextHistoryFocusIndex("Home", 2, 3), 0);
  assert.equal(getNextHistoryFocusIndex("End", 0, 3), 2);
  assert.equal(getNextHistoryFocusIndex("Tab", 0, 3), null);
  assert.equal(getNextHistoryFocusIndex("End", 0, 0), null);
});

test("TimelineStream exposes an accessible stop for each user row and keeps target anchors in the stream", () => {
  const html = renderToStaticMarkup(<TimelineStream rows={makeRows()} />);
  assert.match(html, /aria-label="对话历史"[^>]*data-testid="conversation-history-rail"/);
  assert.match(html, /data-history-seq="3"[^>]*aria-label="跳转到第 1 条用户消息: First user question"/);
  assert.match(html, /data-history-seq="8"[^>]*aria-label="跳转到第 2 条用户消息: Second user question"/);
  assert.match(html, /aria-current="location"/);
  assert.match(html, /data-history-user-seq="3"/);
  assert.match(html, /data-history-user-seq="8"/);
  assert.match(html, /tabindex="0"/);
  assert.match(html, /tabindex="-1"/);
  assert.doesNotMatch(html.slice(0, html.indexOf("</nav>")), /private thought/);
});

test("长会话历史轨道只挂载可视区附近的停靠点，垫片补齐剩余高度", () => {
  const manyRows: TimelineRow[] = [];
  for (let index = 0; index < 300; index += 1) {
    manyRows.push({ kind: "user", seq: index + 1, turnId: `turn-${index}`, text: `第 ${index + 1} 条用户消息` });
  }
  const html = renderToStaticMarkup(<TimelineStream rows={manyRows} />);
  const stopCount = (html.match(/data-history-seq="/g) ?? []).length;
  assert.ok(stopCount > 0, "窗口内应至少挂载一个停靠点");
  assert.ok(stopCount < 300, `长会话应只挂载部分停靠点，实际 ${stopCount}`);
  assert.match(html, /data-history-seq="1"/, "窗口应从第一条开始");
  assert.match(html, /xn-conversation-history-rail__stops"[^>]*style="position:relative;height:4510px;box-sizing:border-box"/, "300 个停靠点的总高度应固定，不能随挂载窗口收缩");
  // 停靠点序号（第 N 条用户消息）必须使用绝对下标，窗口平移后标注不错位。
  assert.match(html, /aria-label="跳转到第 1 条用户消息: 第 1 条用户消息"/);
});

test("the rail is omitted when the timeline contains no user messages", () => {
  const html = renderToStaticMarkup(<TimelineStream rows={[{ kind: "assistant", seq: 4, turnId: "turn-a", text: "Only assistant" }]} />);
  assert.doesNotMatch(html, /conversation-history-rail/);
  assert.match(html, /timeline-item-assistant-4/);
});
