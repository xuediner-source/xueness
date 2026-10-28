import React from "react";
import { flushSync } from "react-dom";
import { TimelineInitialTailOverrideContext, TimelineUserScrollIntentContext } from "./ConversationTimelineViewport";
import type { TimelineUserScrollIntent } from "./timelineScrollAnchor";

import { TimelineWindowModel, type TimelineWindowSnapshot } from "./TimelineWindowModel";
export * from "./TimelineWindowModel";

function findTimelineScroller(stream: HTMLElement | null): HTMLElement | null {
  return stream?.closest<HTMLElement>(".xn-conversation__stream, [data-timeline-scroller]") ?? null;
}

type UseTimelineVirtualWindowProps = {
  count: number;
  enabled: boolean;
  initialTail: boolean;
  followTail?: boolean;
  /** Reset height and reading-anchor state when this view changes sessions. */
  scopeKey?: string | null;
};

export type TimelineVirtualWindowController = {
  snapshot: TimelineWindowSnapshot;
  streamRef: React.RefObject<HTMLDivElement | null>;
  /** 窗口移动到目标条目附近并同步完成重渲染（供历史轨道跳转使用）。 */
  reveal: (index: number) => void;
};

/** 把窗口规划器接到时间线流容器上：滚动监听、提交后测量与尺寸变化重测。 */
export function useTimelineVirtualWindow({ count, enabled, initialTail, followTail = true, scopeKey }: UseTimelineVirtualWindowProps): TimelineVirtualWindowController {
  const restoredTailOverride = React.useContext(TimelineInitialTailOverrideContext);
  const effectiveInitialTail = initialTail && restoredTailOverride !== false;
  const getUserScrollIntent = React.useContext(TimelineUserScrollIntentContext);
  const sessionScope = React.useRef(scopeKey ?? null);
  const streamRef = React.useRef<HTMLDivElement | null>(null);
  const entryNodes = React.useRef(new Map<number, HTMLElement>());
  const entryHeights = React.useRef(new WeakMap<HTMLElement, number>());
  const observedNodes = React.useRef(new Set<HTMLElement>());
  const resizeObserver = React.useRef<ResizeObserver | null>(null);
  const [scroller, setScroller] = React.useState<HTMLElement | null>(null);
  const [model] = React.useState(() => new TimelineWindowModel({
    readViewport: () => {
      const scroller = findTimelineScroller(streamRef.current);
      return scroller
        ? { scrollTop: scroller.scrollTop, clientHeight: scroller.clientHeight, scrollHeight: scroller.scrollHeight }
        : null;
    },
    setScrollTop: (top) => {
      const scroller = findTimelineScroller(streamRef.current);
      if (scroller) scroller.scrollTop = top;
    },
    measureEntry: (index) => {
      const stream = streamRef.current;
      if (!stream) return null;
      const node = entryNodes.current.get(index);
      if (!node) return null;
      let height = entryHeights.current.get(node);
      if (height === undefined) { height = node.getBoundingClientRect().height; entryHeights.current.set(node, height); }
      return height;
    },
    readEntryTop: (index) => {
      const stream = streamRef.current;
      const scroller = findTimelineScroller(stream);
      if (!stream || !scroller) return null;
      const node = stream.querySelector<HTMLElement>(`[data-window-index="${index}"]`);
      if (!node) return null;
      return node.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    },
    readRowGap: () => {
      const stream = streamRef.current;
      if (!stream || typeof window === "undefined" || typeof window.getComputedStyle !== "function") return 0;
      const gapValue = Number.parseFloat(window.getComputedStyle(stream).rowGap);
      return Number.isFinite(gapValue) ? gapValue : 0;
    },
  }, { enabled, initialTail: effectiveInitialTail, followTail, initialCount: count }));

  const subscribe = React.useCallback((listener: () => void) => model.subscribe(listener), [model]);
  const getSnapshot = React.useCallback(() => model.getSnapshot(), [model]);
  const snapshot = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  React.useLayoutEffect(() => {
    const stream = streamRef.current;
    const nextScroller = findTimelineScroller(stream);
    if (nextScroller !== scroller) setScroller(nextScroller);
    const nodes = new Map<number, HTMLElement>();
    stream?.querySelectorAll<HTMLElement>('[data-window-index]').forEach(node => nodes.set(Number(node.dataset.windowIndex), node));
    entryNodes.current = nodes;
    const next = new Set(nodes.values());
    for (const node of observedNodes.current) if (!next.has(node)) resizeObserver.current?.unobserve(node);
    for (const node of next) if (!observedNodes.current.has(node)) resizeObserver.current?.observe(node);
    observedNodes.current = next;
  });

  React.useLayoutEffect(() => {
    const nextScope = scopeKey ?? null;
    if (sessionScope.current !== nextScope) {
      sessionScope.current = nextScope;
      model.resetForSession(effectiveInitialTail, followTail);
    } else {
      model.setFollowTailAllowed(followTail);
    }
    model.setEnabled(enabled);
    model.setCount(count);
  });

  React.useLayoutEffect(() => {
    model.syncAfterCommit(getUserScrollIntent());
  });

  React.useEffect(() => {
    if (!scroller) return;
    const onScroll = () => model.onScrolled();
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => scroller.removeEventListener("scroll", onScroll);
  }, [model, scroller]);

  React.useEffect(() => {
    const stream = streamRef.current;
    if (!stream || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(entries => {
      for (const entry of entries) {
        if (entry.target !== stream) entryHeights.current.set(entry.target as HTMLElement, entry.borderBoxSize[0]?.blockSize ?? entry.target.getBoundingClientRect().height);
      }
      model.syncAfterCommit(getUserScrollIntent());
    });
    resizeObserver.current = observer;
    observer.observe(stream);
    for (const node of observedNodes.current) observer.observe(node);
    return () => { observer.disconnect(); resizeObserver.current = null; };
  }, [model, scroller, getUserScrollIntent]);

  const reveal = React.useCallback((index: number) => {
    if (!model.getSnapshot().windowed) {
      const target = streamRef.current?.querySelector<HTMLElement>(`[data-window-index="${index}"]`);
      target?.scrollIntoView({ block: 'nearest' });
      return;
    }
    flushSync(() => model.reveal(index));
  }, [model]);

  return { snapshot, streamRef, reveal };
}
