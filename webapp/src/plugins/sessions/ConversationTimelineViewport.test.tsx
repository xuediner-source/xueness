import React from "react";
import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { isAwayFromTimelineTail, ConversationTimelineViewport } from "./ConversationTimelineViewport";

test("the return-to-bottom control is offered only after scrolling away from the tail", () => {
  assert.equal(isAwayFromTimelineTail(1000, 500, 400), true);
  assert.equal(isAwayFromTimelineTail(1000, 519, 400), true);
  assert.equal(isAwayFromTimelineTail(1000, 521, 400), false);
  assert.equal(isAwayFromTimelineTail(400, 0, 500), false);

  const html = renderToStaticMarkup(<ConversationTimelineViewport autoScroll rowsVersion={[]}><p>Conversation</p></ConversationTimelineViewport>);
  assert.match(html, /data-testid="session-timeline-viewport"/);
  assert.match(html, /data-testid="session-timeline-scroller"/);
  assert.match(html, /Conversation/);
  assert.doesNotMatch(html, /session-back-to-bottom/, "the button does not appear at the tail");
});
