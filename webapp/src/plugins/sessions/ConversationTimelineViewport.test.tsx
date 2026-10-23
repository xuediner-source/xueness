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

test("empty state and composer dock share the same scroll viewport", () => {
  const html = renderToStaticMarkup(
    <ConversationTimelineViewport autoScroll={false} rowsVersion={[]} centerEmptyStateWithDock
      emptyState={<div data-testid="empty-copy">Start here</div>}
      bottomDock={<div data-testid="empty-composer">Composer</div>}/>,
  );
  assert.equal((html.match(/data-testid="session-timeline-scroller"/g) ?? []).length, 1);
  assert.match(html, /data-testid="empty-copy"/);
  assert.match(html, /data-testid="empty-composer"/);
  assert.match(html, /xn-session-timeline-empty--centered/);
  assert.match(html, /data-testid="session-composer-dock"/);
});
