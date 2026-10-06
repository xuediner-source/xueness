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

test("history items use every real user message and only public assistant text for summaries", () => {
  const rows = makeRows();
  const before = structuredClone(rows);
  assert.deepEqual(buildConversationHistoryItems(rows), [
    { seq: 3, userText: "First user question", assistantText: "First public reply" },
    { seq: 8, userText: "Second user question", assistantText: "Partial answer" },
  ]);
  assert.deepEqual(rows, before, "building the rail does not mutate timeline rows");

  const updated = [...rows.slice(0, -1), { kind: "assistant", seq: 9, turnId: "turn-b", text: "Partial answer with more streamed text" } satisfies TimelineRow];
  assert.equal(buildConversationHistoryItems(updated)[1]?.assistantText, "Partial answer with more streamed text");
  assert.doesNotMatch(JSON.stringify(buildConversationHistoryItems(rows)), /private thought/);
});

test("visible stop follows the last user message above the reading threshold", () => {
  assert.equal(resolveVisibleHistorySequence([{ seq: 3, top: 70 }, { seq: 8, top: 320 }, { seq: 11, top: 920 }], 350), 8);
  assert.equal(resolveVisibleHistorySequence([{ seq: 3, top: 70 }, { seq: 8, top: 320 }], -1), 3);
  assert.equal(resolveVisibleHistorySequence([], 100), null);
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
  assert.match(html, /xn-conversation-history-rail__stops"[^>]*style="margin-top:0px;margin-bottom:\d+px"/, "未挂载停靠点应由底部垫片补齐");
  // 停靠点序号（第 N 条用户消息）必须使用绝对下标，窗口平移后标注不错位。
  assert.match(html, /aria-label="跳转到第 1 条用户消息: 第 1 条用户消息"/);
});

test("the rail is omitted when the timeline contains no user messages", () => {
  const html = renderToStaticMarkup(<TimelineStream rows={[{ kind: "assistant", seq: 4, turnId: "turn-a", text: "Only assistant" }]} />);
  assert.doesNotMatch(html, /conversation-history-rail/);
  assert.match(html, /timeline-item-assistant-4/);
});
