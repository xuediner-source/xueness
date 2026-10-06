import React from "react";
import { t as tr, tf } from "../../i18n";
import type { TimelineRow } from "../../xuenessWorkbench";
import { useUniformListWindow } from "./ListVirtualWindow";

export type ConversationHistoryItem = {
  seq: number;
  userText: string;
  assistantText?: string;
};

function previewText(value: string, limit = 220): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit - 1).trimEnd()}…`;
}

/** Derive one navigation stop per actual user message; public assistant text is
 * included only as a hover hint and is recomputed as a streamed reply grows. */
export function buildConversationHistoryItems(rows: TimelineRow[]): ConversationHistoryItem[] {
  const items: ConversationHistoryItem[] = [];
  for (const row of rows) {
    if (row.kind === "user") {
      items.push({ seq: row.seq, userText: previewText(row.text) });
    } else if (row.kind === "assistant" && row.text.trim()) {
      const current = items[items.length - 1];
      if (current) current.assistantText = previewText(row.text);
    }
  }
  return items;
}

export function resolveVisibleHistorySequence(
  positions: ReadonlyArray<{ seq: number; top: number }>,
  threshold: number,
): number | null {
  if (positions.length === 0) return null;
  let visible = positions[0]!.seq;
  for (const position of positions) {
    if (position.top <= threshold) visible = position.seq;
    else break;
  }
  return visible;
}

export function getConversationHistoryScrollTop(
  scrollerTop: number,
  scrollerScrollTop: number,
  targetTop: number,
  topInset = 16,
): number {
  return Math.max(0, scrollerScrollTop + targetTop - scrollerTop - topInset);
}

export function getNextHistoryFocusIndex(key: string, currentIndex: number, count: number): number | null {
  if (count <= 0) return null;
  if (key === "ArrowDown" || key === "ArrowRight") return Math.min(count - 1, currentIndex + 1);
  if (key === "ArrowUp" || key === "ArrowLeft") return Math.max(0, currentIndex - 1);
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}

export function getHistoryRailScrollTop(
  currentScrollTop: number,
  viewportTop: number,
  viewportBottom: number,
  itemTop: number,
  itemBottom: number,
): number {
  if (itemTop < viewportTop) return Math.max(0, currentScrollTop + itemTop - viewportTop);
  if (itemBottom > viewportBottom) return Math.max(0, currentScrollTop + itemBottom - viewportBottom);
  return currentScrollTop;
}

function nearestVisibleHistoryStop(track: HTMLElement): HTMLButtonElement | null {
  const viewport = track.getBoundingClientRect();
  const midpoint = viewport.top + track.clientHeight / 2;
  let nearest: { button: HTMLButtonElement; distance: number } | null = null;
  for (const button of track.querySelectorAll<HTMLButtonElement>("button[data-history-seq]")) {
    const rect = button.getBoundingClientRect();
    if (rect.bottom <= viewport.top || rect.top >= viewport.bottom) continue;
    const distance = Math.abs((rect.top + rect.bottom) / 2 - midpoint);
    if (!nearest || distance < nearest.distance) nearest = { button, distance };
  }
  return nearest?.button ?? null;
}

export type XuenessConversationHistoryRailProps = {
  rows: TimelineRow[];
  timelineRootRef: React.RefObject<HTMLDivElement | null>;
  /** 目标用户消息尚未渲染时，请求时间线把窗口展开到该消息（长会话虚拟化）。 */
  requestReveal?: (seq: number) => void;
};

/** 停靠点窗口化参数：12px 停靠点 + 3px 间隔（移动端 11px + 2px，滚动后自动实测）。 */
const RAIL_WINDOW_PAGE_SIZE = 40;
const RAIL_WINDOW_OVERSCAN_PX = 300;
const RAIL_STRIDE_ESTIMATE_PX = 15;

function findConversationScroller(root: HTMLElement): HTMLElement | null {
  return root.closest<HTMLElement>(".xn-conversation__stream");
}

export function XuenessConversationHistoryRail({ rows, timelineRootRef, requestReveal }: XuenessConversationHistoryRailProps): React.JSX.Element | null {
  const items = React.useMemo(() => buildConversationHistoryItems(rows), [rows]);
  const [activeSeq, setActiveSeq] = React.useState<number | null>(items[0]?.seq ?? null);
  const [rovingSeq, setRovingSeq] = React.useState<number | null>(items[0]?.seq ?? null);
  const [focusSeq, setFocusSeq] = React.useState<number | null>(null);
  const [hoveredSeq, setHoveredSeq] = React.useState<number | null>(null);
  const trackRef = React.useRef<HTMLDivElement>(null);
  const stopsRef = React.useRef<HTMLDivElement>(null);
  const navId = React.useId().replace(/:/gu, "");
  const restoreFocusAfterScrollRef = React.useRef(false);

  // 停靠点窗口化：只挂载轨道可视区附近的行；键盘焦点附近的停靠点软性保持挂载。
  const pinnedIndices = React.useMemo(() => {
    const indices: number[] = [];
    for (const seq of [activeSeq, rovingSeq, focusSeq]) {
      if (seq === null) continue;
      const index = items.findIndex((item) => item.seq === seq);
      if (index >= 0) indices.push(index);
    }
    return indices;
  }, [items, activeSeq, rovingSeq, focusSeq]);
  const { snapshot, ensureIndex } = useUniformListWindow({
    count: items.length,
    listRef: stopsRef,
    findScroller: (list) => list.closest<HTMLElement>(".xn-conversation-history-rail__track"),
    pageSize: RAIL_WINDOW_PAGE_SIZE,
    overscanPx: RAIL_WINDOW_OVERSCAN_PX,
    estimateStridePx: RAIL_STRIDE_ESTIMATE_PX,
    pinned: pinnedIndices,
  });

  // Scrolling can make a remotely pinned button fall outside the bounded
  // window. If that button held DOM focus, hand focus to the nearest visible
  // stop after the virtual window commits so keyboard navigation continues.
  React.useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    let frame = 0;
    const onScrollCapture = () => {
      const active = document.activeElement;
      if (!(active instanceof HTMLElement) || !track.contains(active) || !active.hasAttribute("data-history-seq")) return;
      restoreFocusAfterScrollRef.current = true;
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (!restoreFocusAfterScrollRef.current) return;
        const current = document.activeElement;
        const viewport = track.getBoundingClientRect();
        const currentRect = current instanceof HTMLElement && track.contains(current) ? current.getBoundingClientRect() : null;
        const stillVisible = Boolean(currentRect && currentRect.bottom > viewport.top && currentRect.top < viewport.bottom);
        if (stillVisible) {
          restoreFocusAfterScrollRef.current = false;
          return;
        }
        const next = nearestVisibleHistoryStop(track);
        if (!next) return;
        const seq = Number(next.dataset.historySeq);
        restoreFocusAfterScrollRef.current = false;
        if (Number.isInteger(seq)) setRovingSeq(seq);
        next.focus({ preventScroll: true });
      });
    };
    track.addEventListener("scroll", onScrollCapture, { capture: true, passive: true });
    return () => {
      track.removeEventListener("scroll", onScrollCapture, true);
      if (frame) cancelAnimationFrame(frame);
      restoreFocusAfterScrollRef.current = false;
    };
  }, []);

  React.useEffect(() => {
    if (!items.some((item) => item.seq === rovingSeq)) setRovingSeq(items[0]?.seq ?? null);
    if (!items.some((item) => item.seq === focusSeq)) setFocusSeq(null);
    if (!items.some((item) => item.seq === hoveredSeq)) setHoveredSeq(null);
  }, [items, rovingSeq, focusSeq, hoveredSeq]);

  React.useEffect(() => {
    const root = timelineRootRef.current;
    const scroller = root ? findConversationScroller(root) : null;
    if (!root || !scroller || items.length === 0) return;

    const updateActive = () => {
      const threshold = scroller.getBoundingClientRect().top + Math.min(112, scroller.clientHeight * 0.28);
      const positions = items.flatMap((item) => {
        const target = root.querySelector<HTMLElement>(`[data-history-user-seq="${item.seq}"]`);
        return target ? [{ seq: item.seq, top: target.getBoundingClientRect().top }] : [];
      });
      const nextSeq = resolveVisibleHistorySequence(positions, threshold);
      setActiveSeq((previous) => previous === nextSeq ? previous : nextSeq);
    };

    updateActive();
    scroller.addEventListener("scroll", updateActive, { passive: true });
    window.addEventListener("resize", updateActive);
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updateActive);
    resizeObserver?.observe(root);
    return () => {
      scroller.removeEventListener("scroll", updateActive);
      window.removeEventListener("resize", updateActive);
      resizeObserver?.disconnect();
    };
  }, [items, timelineRootRef]);

  const keepRailStopVisible = React.useCallback((seq: number | null) => {
    const track = trackRef.current;
    const stops = stopsRef.current;
    if (!track || !stops || seq === null || !(snapshot.stride > 0)) return;
    const index = items.findIndex((item) => item.seq === seq);
    if (index < 0) return;
    // 等高停靠点的几何是精确的：垫片把未挂载区域补齐，停靠点 i 在轨道内容中
    // 的位置 = 停靠区内边距 + i × 节距。无需停靠点已挂载即可定位滚动。
    const cssPadTop = Number.parseFloat(window.getComputedStyle(stops).paddingTop) || 0;
    const stopTop = cssPadTop + index * snapshot.stride;
    const stopBottom = stopTop + snapshot.stride;
    const nextScrollTop = getHistoryRailScrollTop(track.scrollTop, track.scrollTop, track.scrollTop + track.clientHeight, stopTop, stopBottom);
    if (Math.abs(nextScrollTop - track.scrollTop) >= 1) track.scrollTop = nextScrollTop;
  }, [items, snapshot.stride]);

  React.useEffect(() => keepRailStopVisible(activeSeq), [activeSeq, items, keepRailStopVisible]);
  React.useEffect(() => keepRailStopVisible(focusSeq), [focusSeq, items, keepRailStopVisible]);

  if (items.length === 0) return null;

  const revealItem = (seq: number) => {
    const root = timelineRootRef.current;
    const scroller = root ? findConversationScroller(root) : null;
    let target = root?.querySelector<HTMLElement>(`[data-history-user-seq="${seq}"]`);
    let revealedRemotely = false;
    if (!target && requestReveal) {
      // 虚拟化时间线：先把窗口展开到目标消息（同步重渲染），再定位滚动。
      // 跨窗口的远距离跳转用瞬时滚动：平滑动画会被窗口补偿的定位写入打断。
      requestReveal(seq);
      target = root?.querySelector<HTMLElement>(`[data-history-user-seq="${seq}"]`);
      revealedRemotely = true;
    }
    if (!scroller || !target) return;
    const nextTop = getConversationHistoryScrollTop(
      scroller.getBoundingClientRect().top,
      scroller.scrollTop,
      target.getBoundingClientRect().top,
    );
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const behavior: ScrollBehavior = reduceMotion || revealedRemotely ? "auto" : "smooth";
    scroller.scrollTo({ top: nextTop, behavior });
    setActiveSeq(seq);
    setRovingSeq(seq);
  };

  const moveFocus = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    const nextIndex = getNextHistoryFocusIndex(event.key, index, items.length);
    if (nextIndex === null) return;
    event.preventDefault();
    const item = items[nextIndex]!;
    setRovingSeq(item.seq);
    // 目标停靠点可能尚未挂载（窗口化）：先同步扩大窗口，再聚焦。
    ensureIndex(nextIndex);
    trackRef.current?.querySelector<HTMLElement>(`[data-history-seq="${item.seq}"]`)?.focus({ preventScroll: true });
  };

  const previewSeq = hoveredSeq ?? focusSeq;
  const previewIndex = items.findIndex((item) => item.seq === previewSeq);
  const previewItem = previewIndex >= 0 ? items[previewIndex] : null;

  return (
    <nav
      className="xn-conversation-history-rail"
      aria-label={tr("对话历史")}
      data-testid="conversation-history-rail"
      onMouseLeave={() => setHoveredSeq(null)}
    >
      <div ref={trackRef} className="xn-conversation-history-rail__track">
        <div
          ref={stopsRef}
          className="xn-conversation-history-rail__stops"
          style={snapshot.windowed ? { marginTop: `${snapshot.topPad}px`, marginBottom: `${snapshot.bottomPad}px` } : undefined}
        >
          {items.slice(snapshot.start, snapshot.end).map((item, offset) => {
            const index = snapshot.start + offset;
            const isActive = item.seq === activeSeq;
            const isPreviewed = item.seq === previewSeq;
            const buttonId = `${navId}-${item.seq}`;
            const tooltipId = `${buttonId}-summary`;
            const label = tf("跳转到第 {0} 条用户消息", [index + 1]);
            return (
              <button
                key={item.seq}
                id={buttonId}
                type="button"
                className="xn-conversation-history-rail__stop"
                data-history-seq={item.seq}
                data-active={isActive ? "true" : undefined}
                aria-label={`${label}${item.userText ? `: ${item.userText}` : ""}`}
                aria-current={isActive ? "location" : undefined}
                aria-describedby={isPreviewed ? tooltipId : undefined}
                tabIndex={item.seq === rovingSeq ? 0 : -1}
                onClick={() => revealItem(item.seq)}
                onFocus={() => { setRovingSeq(item.seq); setFocusSeq(item.seq); }}
                onBlur={() => setFocusSeq((current) => current === item.seq ? null : current)}
                onMouseEnter={() => setHoveredSeq(item.seq)}
                onKeyDown={(event) => moveFocus(event, index)}
              >
                <span className="xn-conversation-history-rail__tick" aria-hidden="true" />
              </button>
            );
          })}
        </div>
      </div>
      {previewItem && (
        <div
          className="xn-conversation-history-rail__summary"
          id={`${navId}-${previewItem.seq}-summary`}
          role="tooltip"
          data-testid="conversation-history-summary"
        >
          <strong>{tf("用户消息 {0}", [previewIndex + 1])}</strong>
          {previewItem.userText && <span>{previewItem.userText}</span>}
          {previewItem.assistantText && <span className="xn-conversation-history-rail__reply">{previewItem.assistantText}</span>}
        </div>
      )}
    </nav>
  );
}
