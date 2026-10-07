import test from "node:test";
import assert from "node:assert/strict";
import {
  isAtBottom,
  reconcileFollowingForContentAnchor,
  resolveFollowingAfterScroll,
  resolveTimelineScrollEventSource,
  shouldShowBackToBottom,
  timelineTouchScrollIntent,
  timelineWheelScrollIntent,
} from "./timelineScrollAnchor";

const atBottom = { scrollTop: 920, viewportHeight: 400, contentHeight: 1320 }; // distance 0
const away = { scrollTop: 500, viewportHeight: 400, contentHeight: 1320 }; // distance 420

test("only the user source can change following", () => {
  assert.equal(isAtBottom(atBottom), true);
  assert.equal(isAtBottom(away), false);
  // 程序化贴底落点在底部 → 保持原跟随态。
  assert.equal(resolveFollowingAfterScroll({ following: false, metrics: atBottom, source: "programmatic" }), false);
  assert.equal(resolveFollowingAfterScroll({ following: true, metrics: away, source: "programmatic" }), true);
  // 布局补偿 scroll 不改变滚动权。
  assert.equal(resolveFollowingAfterScroll({ following: true, metrics: away, source: "layout" }), true);
  // 用户滚动按落点裁决。
  assert.equal(resolveFollowingAfterScroll({ following: true, metrics: away, source: "user" }), false);
  assert.equal(resolveFollowingAfterScroll({ following: false, metrics: atBottom, source: "user" }), true);
});

test("scroll source keeps active smooth scrolling programmatic until user input arrives", () => {
  assert.equal(resolveTimelineScrollEventSource({ userScrollIntent: "none", programmaticScrollActive: true }), "programmatic");
  assert.equal(resolveTimelineScrollEventSource({ userScrollIntent: "awayFromBottom", programmaticScrollActive: true }), "user");
  assert.equal(resolveTimelineScrollEventSource({ userScrollIntent: "none", programmaticScrollActive: false }), "user");
});

test("reconcile protects an upscroll that the scroll event has not delivered yet", () => {
  // 明确上滚意图 → 立即解除，哪怕几何上还在底部。
  assert.equal(
    reconcileFollowingForContentAnchor({
      following: true,
      metrics: atBottom,
      lastObservedScrollTop: 920,
      userScrollIntent: "awayFromBottom",
    }),
    false,
  );
  // 无用户输入 → 原样保持（测高抖动不算上滚）。
  assert.equal(
    reconcileFollowingForContentAnchor({
      following: true,
      metrics: atBottom,
      lastObservedScrollTop: 920,
      userScrollIntent: "none",
    }),
    true,
  );
  // 未观察到的明显回退（事件未派发）→ 解除跟随。
  assert.equal(
    reconcileFollowingForContentAnchor({
      following: true,
      metrics: { scrollTop: 800, viewportHeight: 400, contentHeight: 1320 },
      lastObservedScrollTop: 920,
      userScrollIntent: "unknown",
    }),
    false,
  );
  // 亚像素回退不算上滚 → 保持。
  assert.equal(
    reconcileFollowingForContentAnchor({
      following: true,
      metrics: { scrollTop: 919, viewportHeight: 400, contentHeight: 1319 },
      lastObservedScrollTop: 920,
      userScrollIntent: "unknown",
    }),
    true,
  );
});

test("back-to-bottom button shows only when unfollowed with content", () => {
  assert.equal(shouldShowBackToBottom(false, 3), true);
  assert.equal(shouldShowBackToBottom(false, 0), false);
  assert.equal(shouldShowBackToBottom(true, 3), false);
});

test("wheel/touch intent helpers map direction to scroll intent", () => {
  assert.equal(timelineWheelScrollIntent(-10), "awayFromBottom");
  assert.equal(timelineWheelScrollIntent(10), "towardBottom");
  assert.equal(timelineWheelScrollIntent(0), "none");
  // 手指下移 → 阅读更早内容。
  assert.equal(timelineTouchScrollIntent(100, 140), "awayFromBottom");
  assert.equal(timelineTouchScrollIntent(140, 100), "towardBottom");
  assert.equal(timelineTouchScrollIntent(100, 100), "none");
});
