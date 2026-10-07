import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowDown } from "lucide-react";
import { t as tr } from "../../i18n";
import {
  initialFollowing,
  reconcileFollowingForContentAnchor,
  resolveFollowingAfterScroll,
  resolveTimelineScrollEventSource,
  shouldShowBackToBottom,
  timelineTouchScrollIntent,
  timelineWheelScrollIntent,
  type TimelineUserScrollIntent,
} from "./timelineScrollAnchor";
import {
  buildSessionScrollMemoryKey,
  readSessionScrollMemoryState,
  resolveScrollRestoreTop,
  saveSessionScrollMemoryState,
} from "./sessionScrollMemory";
import "./sessions.css";

export type ConversationTimelineViewportProps = {
  children: React.ReactNode;
  autoScroll: boolean;
  rowsVersion: unknown;
  streamingText?: string;
  queuedMessages?: unknown;
  /** 滚动记忆的 session 作用域；未提供时不做记忆读写。 */
  sessionId?: string | null;
};

const FOLLOW_TAIL_DISTANCE = 80;

/** A restored reading position must initialize the virtual window away from its tail. */
export const TimelineInitialTailOverrideContext = React.createContext<boolean | null>(null);

/** 用户滚动意图的存活窗口：超过该时长未再出现输入即视为过期。 */
const USER_SCROLL_INTENT_TTL_MS = 1200;

export function isAwayFromTimelineTail(scrollHeight: number, scrollTop: number, clientHeight: number): boolean {
  return Math.max(0, scrollHeight - scrollTop - clientHeight) >= FOLLOW_TAIL_DISTANCE;
}

type SessionViewportHandle = {
  element: HTMLDivElement;
  setFollowing: (following: boolean) => void;
  scrollToBottom: () => void;
};

/** sessionId → 存活视口句柄，供 restoreSessionScroll 在不 remount 时做命令式恢复。 */
const sessionViewportHandles = new Map<string, SessionViewportHandle>();

/**
 * 供容器在会话切换时调用：按该会话上次的滚动记忆恢复位置。
 * - pinned（上次贴底）→ 贴底 + 跟随；
 * - 否则 → clamp 恢复阅读位置 + 解除跟随；
 * - 无记忆或视口未注册 → "none"。
 */
export function restoreSessionScroll(sessionId: string | null | undefined): "pinned" | "restored" | "none" {
  const key = buildSessionScrollMemoryKey({ sessionId });
  if (!key) return "none";
  const handle = sessionViewportHandles.get(key);
  if (!handle) return "none";
  const state = readSessionScrollMemoryState(key);
  if (!state) return "none";
  if (state.wasPinnedToBottom) {
    handle.setFollowing(true);
    handle.scrollToBottom();
    return "pinned";
  }
  handle.setFollowing(false);
  handle.element.scrollTop = resolveScrollRestoreTop(state, handle.element);
  return "restored";
}

/** Sessions-owned scroll container keeps new output in view until the reader moves away. */
export function ConversationTimelineViewport({ children, autoScroll, rowsVersion, streamingText, queuedMessages, sessionId }: ConversationTimelineViewportProps): React.JSX.Element {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(initialFollowing());
  const smoothScrollRef = useRef(false);
  const smoothScrollTimerRef = useRef<number | undefined>(undefined);
  const programmaticScrollFrameRef = useRef<number | null>(null);
  const userScrollIntentRef = useRef<{ intent: TimelineUserScrollIntent; observedAt: number }>({ intent: "none", observedAt: 0 });
  const touchClientYRef = useRef<number | null>(null);
  const lastObservedScrollTopRef = useRef(0);
  const sessionIdRef = useRef<string | null>(null);
  sessionIdRef.current = sessionId?.trim() ? sessionId.trim() : null;
  const pendingRestoreRef = useRef<{ kind: "pinned" } | { kind: "position"; scrollTop: number } | null>(null);
  const [awayFromTail, setAwayFromTail] = useState(false);

  const rowCount = Array.isArray(rowsVersion) ? rowsVersion.length : 1;
  const rowCountRef = useRef(rowCount);
  rowCountRef.current = rowCount;
  const initialMemoryState = sessionIdRef.current
    ? readSessionScrollMemoryState(buildSessionScrollMemoryKey({ sessionId: sessionIdRef.current }))
    : null;
  const initialTailOverride = initialMemoryState?.wasPinnedToBottom === false ? false : null;

  const commitFollowing = useCallback((next: boolean) => {
    if (followingRef.current === next) return;
    followingRef.current = next;
    setAwayFromTail(shouldShowBackToBottom(next, rowCountRef.current));
  }, []);

  const clearSmoothScrollTimer = useCallback(() => {
    if (smoothScrollTimerRef.current === undefined) return;
    window.clearTimeout(smoothScrollTimerRef.current);
    smoothScrollTimerRef.current = undefined;
  }, []);

  /** 程序化滚动标记：rAF 窗口内派发的 scroll 事件不改变跟随态。 */
  const markProgrammaticScroll = useCallback(() => {
    if (programmaticScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(programmaticScrollFrameRef.current);
    }
    programmaticScrollFrameRef.current = window.requestAnimationFrame(() => {
      programmaticScrollFrameRef.current = null;
    });
  }, []);

  const clearUserScrollIntent = useCallback(() => {
    userScrollIntentRef.current = { intent: "none", observedAt: 0 };
    touchClientYRef.current = null;
  }, []);

  const getActiveUserScrollIntent = useCallback((): TimelineUserScrollIntent => {
    const current = userScrollIntentRef.current;
    if (touchClientYRef.current !== null) {
      return current.intent === "none" ? "unknown" : current.intent;
    }
    return Date.now() - current.observedAt <= USER_SCROLL_INTENT_TTL_MS ? current.intent : "none";
  }, []);

  const saveScrollMemory = useCallback(() => {
    const scroller = scrollerRef.current;
    const key = buildSessionScrollMemoryKey({ sessionId: sessionIdRef.current });
    if (!scroller || !key) return;
    saveSessionScrollMemoryState(key, {
      scrollTop: scroller.scrollTop,
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
      wasPinnedToBottom: followingRef.current,
      updatedAt: Date.now(),
    });
  }, []);

  // 贴底必须 instant（scrollTop 赋值）：smooth 的中间帧会被 scroll 判定误读为「离底」。
  const scrollToBottom = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    markProgrammaticScroll();
    scroller.scrollTop = scroller.scrollHeight;
    // 回读取钳制后的落点入账（浏览器会把赋值钳到最大可滚动距离）。
    lastObservedScrollTopRef.current = scroller.scrollTop;
    commitFollowing(true);
    setAwayFromTail(false);
    saveScrollMemory();
  }, [commitFollowing, markProgrammaticScroll, saveScrollMemory]);

  /** wheel/touch 捕获阶段的滚动意图预判：上滚意图立即解除跟随，不等 scroll 事件派发。 */
  const markUserScrollIntent = useCallback((intent: TimelineUserScrollIntent) => {
    if (intent === "none") return;
    userScrollIntentRef.current = { intent, observedAt: Date.now() };
    const scroller = scrollerRef.current;
    if (intent === "awayFromBottom" && scroller && scroller.scrollHeight > scroller.clientHeight) {
      commitFollowing(false);
    }
  }, [commitFollowing]);

  const updatePosition = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const isAtTail = !isAwayFromTimelineTail(scroller.scrollHeight, scroller.scrollTop, scroller.clientHeight);
    if (isAtTail) {
      followingRef.current = true;
      smoothScrollRef.current = false;
      clearSmoothScrollTimer();
    } else if (!smoothScrollRef.current) {
      followingRef.current = false;
    }
    setAwayFromTail(!isAtTail && !smoothScrollRef.current);
  }, [clearSmoothScrollTimer]);

  const handleScroll = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const userScrollIntent = getActiveUserScrollIntent();
    // 用户输入优先；程序化贴底不改变滚动权；其余未分类事件按真实用户滚动处理，
    // 兼容原生滚动条和辅助技术。
    const scrollSource = resolveTimelineScrollEventSource({
      userScrollIntent,
      programmaticScrollActive: programmaticScrollFrameRef.current !== null || smoothScrollRef.current,
    });
    lastObservedScrollTopRef.current = scroller.scrollTop;
    const following = resolveFollowingAfterScroll({
      following: followingRef.current,
      source: scrollSource,
      metrics: {
        scrollTop: scroller.scrollTop,
        viewportHeight: scroller.clientHeight,
        contentHeight: scroller.scrollHeight,
      },
      epsilonPx: FOLLOW_TAIL_DISTANCE,
    });
    commitFollowing(following);
    if (scrollSource === "user") {
      saveScrollMemory();
    }
  }, [commitFollowing, getActiveUserScrollIntent, saveScrollMemory]);

  // 会话绑定：注册视口句柄，并按滚动记忆决定初始跟随态；位置恢复在内容 effect 中执行。
  useLayoutEffect(() => {
    const sid = sessionIdRef.current;
    const scroller = scrollerRef.current;
    if (scroller && sid) {
      sessionViewportHandles.set(sid, {
        element: scroller,
        setFollowing: (next: boolean) => commitFollowing(next),
        scrollToBottom: () => scrollToBottom(),
      });
    }
    pendingRestoreRef.current = null;
    if (!sid) {
      commitFollowing(initialFollowing());
      return () => { if (sid) sessionViewportHandles.delete(sid); };
    }
    const state = readSessionScrollMemoryState(buildSessionScrollMemoryKey({ sessionId: sid }));
    if (!state) {
      commitFollowing(initialFollowing());
    } else if (state.wasPinnedToBottom) {
      commitFollowing(true);
      pendingRestoreRef.current = { kind: "pinned" };
    } else {
      commitFollowing(false);
      pendingRestoreRef.current = { kind: "position", scrollTop: state.scrollTop };
    }
    return () => { if (sid) sessionViewportHandles.delete(sid); };
  }, [sessionId, commitFollowing, scrollToBottom]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    // 会话切换恢复：pinned → 贴底，否则 clamp 恢复上次阅读位置并解除跟随。
    const pendingRestore = pendingRestoreRef.current;
    if (pendingRestore) {
      pendingRestoreRef.current = null;
      markProgrammaticScroll();
      if (pendingRestore.kind === "pinned") {
        scroller.scrollTop = scroller.scrollHeight;
      } else {
        scroller.scrollTop = resolveScrollRestoreTop({ scrollTop: pendingRestore.scrollTop }, scroller);
      }
      lastObservedScrollTopRef.current = scroller.scrollTop;
      updatePosition();
      return;
    }
    if (!autoScroll) {
      updatePosition();
      return;
    }
    // 贴底前对账用户滚动意图：scroll 事件比内容 commit 晚一帧派发，
    // 不对账会把"用户刚上滚、事件还没派发"的阅读位置拽回底部。
    const reconciled = reconcileFollowingForContentAnchor({
      following: followingRef.current,
      metrics: {
        scrollTop: scroller.scrollTop,
        viewportHeight: scroller.clientHeight,
        contentHeight: scroller.scrollHeight,
      },
      lastObservedScrollTop: lastObservedScrollTopRef.current,
      userScrollIntent: getActiveUserScrollIntent(),
      bottomEpsilonPx: FOLLOW_TAIL_DISTANCE,
    });
    commitFollowing(reconciled);
    if (reconciled) {
      scrollToBottom();
    } else {
      updatePosition();
    }
  }, [autoScroll, rowsVersion, streamingText, queuedMessages, commitFollowing, getActiveUserScrollIntent, markProgrammaticScroll, scrollToBottom, updatePosition]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    const content = scroller ? Array.from(scroller.children) : [];
    if (!scroller || !content.length || typeof ResizeObserver === "undefined") return;
    const onResize = () => {
      const reconciled = reconcileFollowingForContentAnchor({
        following: followingRef.current,
        metrics: {
          scrollTop: scroller.scrollTop,
          viewportHeight: scroller.clientHeight,
          contentHeight: scroller.scrollHeight,
        },
        lastObservedScrollTop: lastObservedScrollTopRef.current,
        userScrollIntent: getActiveUserScrollIntent(),
        bottomEpsilonPx: FOLLOW_TAIL_DISTANCE,
      });
      commitFollowing(reconciled);
      if (autoScroll && reconciled) {
        scrollToBottom();
      } else updatePosition();
    };
    const observer = new ResizeObserver(onResize);
    observer.observe(scroller);
    content.forEach(child => observer.observe(child));
    return () => observer.disconnect();
  }, [autoScroll, commitFollowing, getActiveUserScrollIntent, scrollToBottom, updatePosition]);

  useEffect(() => () => {
    clearSmoothScrollTimer();
    if (programmaticScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(programmaticScrollFrameRef.current);
      programmaticScrollFrameRef.current = null;
    }
  }, [clearSmoothScrollTimer]);

  const finishSmoothScroll = useCallback(() => {
    if (!smoothScrollRef.current) return;
    smoothScrollRef.current = false;
    clearSmoothScrollTimer();
    updatePosition();
  }, [clearSmoothScrollTimer, updatePosition]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    scroller.addEventListener("scrollend", finishSmoothScroll);
    return () => scroller.removeEventListener("scrollend", finishSmoothScroll);
  }, [finishSmoothScroll]);

  const backToBottom = () => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    clearUserScrollIntent();
    commitFollowing(true);
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
    if (reducedMotion || typeof scroller.scrollTo !== "function") {
      scrollToBottom();
      return;
    }
    smoothScrollRef.current = true;
    setAwayFromTail(false);
    markProgrammaticScroll();
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
    clearSmoothScrollTimer();
    smoothScrollTimerRef.current = window.setTimeout(() => {
      smoothScrollTimerRef.current = undefined;
      smoothScrollRef.current = false;
      updatePosition();
      saveScrollMemory();
    }, 2000);
  };

  const cancelSmoothScroll = () => {
    if (!smoothScrollRef.current) return;
    smoothScrollRef.current = false;
    clearSmoothScrollTimer();
    updatePosition();
  };

  const handleWheelCapture = (e: React.WheelEvent) => {
    cancelSmoothScroll();
    markUserScrollIntent(timelineWheelScrollIntent(e.deltaY));
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    cancelSmoothScroll();
    const touch = e.touches[0];
    touchClientYRef.current = touch ? touch.clientY : null;
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    const touch = e.touches[0];
    const previousClientY = touchClientYRef.current;
    if (touch && previousClientY !== null) {
      markUserScrollIntent(timelineTouchScrollIntent(previousClientY, touch.clientY));
    }
    if (touch) touchClientYRef.current = touch.clientY;
  };

  const handleTouchEnd = () => {
    touchClientYRef.current = null;
  };

  return (
    <div className="xn-session-timeline-viewport" data-testid="session-timeline-viewport">
      <div
        ref={scrollerRef}
        className="xn-conversation__stream xn-session-timeline-viewport__scroll"
        onScroll={handleScroll}
        onWheelCapture={handleWheelCapture}
        onWheel={cancelSmoothScroll}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onPointerDown={cancelSmoothScroll}
        data-testid="session-timeline-scroller"
      >
        <TimelineInitialTailOverrideContext.Provider value={initialTailOverride}>
          {children}
        </TimelineInitialTailOverrideContext.Provider>
      </div>
      {awayFromTail && <button
        type="button"
        className="xn-session-back-to-bottom"
        data-testid="session-back-to-bottom"
        aria-label={tr("回到底部")}
        title={tr("回到底部")}
        onClick={backToBottom}
      ><ArrowDown size={15} aria-hidden="true" /><span>{tr("回到底部")}</span></button>}
    </div>
  );
}
