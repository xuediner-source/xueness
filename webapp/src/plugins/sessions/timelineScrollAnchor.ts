// 会话时间线底部锚定状态机（纯函数，无 DOM/React 依赖）。
//
// 语义（scrollAnchor）：
// - 用户位于底部 → following=true，新内容（新行 / 流式 delta / 测高变化）自动贴底；
// - 用户上滚离底 → following=false，流式增量不得拉回阅读位置，出现「回到底部」按钮；
// - 用户手动滚回底部（或点按钮）→ 恢复跟随。
//
// following 表达用户滚动权，不是瞬时几何快照：只有真实用户滚动输入可以改变它；
// 程序化贴底和布局测高补偿产生的 scroll 事件只更新几何账目。
//

/** 离底判定容差：小于该距离视为「在底部」。取值覆盖亚像素滚动与最后一行 padding。 */
const BOTTOM_ANCHOR_EPSILON_PX = 48;

interface TimelineScrollMetrics {
  /** 滚动容器 scrollTop。 */
  scrollTop: number;
  /** 滚动容器可视高度（clientHeight）。 */
  viewportHeight: number;
  /** 内容总高度（scrollHeight）。 */
  contentHeight: number;
}

/** 距底部的剩余可滚动距离（内容不足一屏时为 0）。 */
export function distanceToBottom(metrics: TimelineScrollMetrics): number {
  return Math.max(0, metrics.contentHeight - metrics.viewportHeight - metrics.scrollTop);
}

export function isAtBottom(
  metrics: TimelineScrollMetrics,
  epsilonPx: number = BOTTOM_ANCHOR_EPSILON_PX,
): boolean {
  return distanceToBottom(metrics) <= epsilonPx;
}

/**
 * scroll 事件后的跟随态。规则：落点在底部 ⇔ 跟随。
 * 覆盖三种来源且无需区分：用户上滚（离底 → 解除）、用户滚回（贴底 → 恢复）、
 * 程序化贴底（落点即底部 → 保持）。
 */
function nextFollowingAfterScroll(
  metrics: TimelineScrollMetrics,
  epsilonPx: number = BOTTOM_ANCHOR_EPSILON_PX,
): boolean {
  return isAtBottom(metrics, epsilonPx);
}

export type TimelineScrollEventSource = "user" | "programmatic" | "layout";

/** Resolve the owner of a scroll event from captured input and the active
 * programmatic-scroll window. A changed scrollTop is expected during smooth
 * programmatic motion, so magnitude cannot distinguish it from user input. */
export function resolveTimelineScrollEventSource(input: {
  userScrollIntent: TimelineUserScrollIntent;
  programmaticScrollActive: boolean;
}): TimelineScrollEventSource {
  if (input.userScrollIntent !== "none") return "user";
  return input.programmaticScrollActive ? "programmatic" : "user";
}

/**
 * scroll 事件后的滚动权裁决。布局/程序化 scroll 不得改变用户意图；只有用户输入
 * 才按最终落点决定是否跟随。
 */
export function resolveFollowingAfterScroll(input: {
  following: boolean;
  metrics: TimelineScrollMetrics;
  source: TimelineScrollEventSource;
  epsilonPx?: number;
}): boolean {
  if (input.source !== "user") return input.following;
  return nextFollowingAfterScroll(input.metrics, input.epsilonPx);
}

/** 未观察滚动的判定容差：小于该值的 scrollTop 回退视为亚像素抖动，不算用户上滚。 */
const UNOBSERVED_SCROLL_EPSILON_PX = 2;

export type TimelineUserScrollIntent = "none" | "awayFromBottom" | "towardBottom" | "unknown";

/** wheel 的 deltaY 与 scrollTop 同向：负值阅读更早内容，正值靠近底部。 */
export function timelineWheelScrollIntent(deltaY: number): TimelineUserScrollIntent {
  if (deltaY < 0) return "awayFromBottom";
  if (deltaY > 0) return "towardBottom";
  return "none";
}

/** touch 手指位移与 scrollTop 反向：手指下移表示阅读更早内容。 */
export function timelineTouchScrollIntent(
  previousClientY: number,
  nextClientY: number,
): TimelineUserScrollIntent {
  if (nextClientY > previousClientY) return "awayFromBottom";
  if (nextClientY < previousClientY) return "towardBottom";
  return "none";
}

/**
 * 内容变化 commit 贴底前，对账用户滚动意图。
 *
 * 跟随态由 scroll 事件驱动，但 scroll 事件在滚动发生后的下一渲染帧才派发：
 * 用户上滚（wheel）之后、事件派发之前，若恰好落进一个内容变化的 commit
 * （流式 delta、ResizeObserver 测高修正），贴底 effect 会拿着**过期的
 * following=true** 把 scrollTop 拽回底部，且回弹落点让随后的 scroll 事件把跟随
 * 判回 true——用户的上滚被整体吞掉。
 *
 * 对账规则（在贴底动作之前执行，输入为 commit 时刻的实时指标）：
 * 1. 明确向上滚动 → 立即解除跟随，同帧 commit 也必须让位；
 * 2. 没有用户输入 → 原样保持 following，测高导致的 scrollTop 回退不算上滚；
 * 3. 方向未知或向下的用户输入 → 落点在底则恢复跟随，明显回退则解除，其余保持。
 */
export function reconcileFollowingForContentAnchor(input: {
  /** 当前跟随态（scroll 事件驱动的既有值）。 */
  following: boolean;
  /** commit 时刻（贴底动作前）的实时滚动指标。 */
  metrics: TimelineScrollMetrics;
  /** 组件最近一次「已账目」的 scrollTop（scroll 事件读取值或程序化写入后的回读值）。 */
  lastObservedScrollTop: number;
  /** 当前内容 commit 前捕获到的用户滚动意图；省略时按旧的未知来源对账。 */
  userScrollIntent?: TimelineUserScrollIntent;
  bottomEpsilonPx?: number;
  scrollEpsilonPx?: number;
}): boolean {
  const userScrollIntent = input.userScrollIntent ?? "unknown";
  if (userScrollIntent === "awayFromBottom") return false;
  if (userScrollIntent === "none") return input.following;
  if (isAtBottom(input.metrics, input.bottomEpsilonPx ?? BOTTOM_ANCHOR_EPSILON_PX)) {
    return true;
  }
  const unobservedUpscroll =
    input.metrics.scrollTop <
    input.lastObservedScrollTop - (input.scrollEpsilonPx ?? UNOBSERVED_SCROLL_EPSILON_PX);
  if (unobservedUpscroll) {
    return false;
  }
  return input.following;
}

/** 「回到底部」按钮可见性：仅在解除跟随且确实存在内容时展示。 */
export function shouldShowBackToBottom(following: boolean, rowCount: number): boolean {
  return !following && rowCount > 0;
}

/** 会话切换 / 首次绑定：重置为跟随（打开会话定位到最新消息）。 */
export function initialFollowing(): boolean {
  return true;
}
