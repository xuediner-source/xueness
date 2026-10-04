import React, { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDown } from "lucide-react";
import { t as tr } from "../../i18n";
import "./sessions.css";

export type ConversationTimelineViewportProps = {
  children: React.ReactNode;
  autoScroll: boolean;
  rowsVersion: unknown;
  streamingText?: string;
  queuedMessages?: unknown;
};

const FOLLOW_TAIL_DISTANCE = 80;

export function isAwayFromTimelineTail(scrollHeight: number, scrollTop: number, clientHeight: number): boolean {
  return Math.max(0, scrollHeight - scrollTop - clientHeight) >= FOLLOW_TAIL_DISTANCE;
}

/** Sessions-owned scroll container keeps new output in view until the reader moves away. */
export function ConversationTimelineViewport({ children, autoScroll, rowsVersion, streamingText, queuedMessages }: ConversationTimelineViewportProps): React.JSX.Element {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const followsTailRef = useRef(true);
  const smoothScrollRef = useRef(false);
  const smoothScrollTimerRef = useRef<number | undefined>(undefined);
  const [awayFromTail, setAwayFromTail] = useState(false);

  const clearSmoothScrollTimer = useCallback(() => {
    if (smoothScrollTimerRef.current === undefined) return;
    window.clearTimeout(smoothScrollTimerRef.current);
    smoothScrollTimerRef.current = undefined;
  }, []);

  const updatePosition = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const isAtTail = !isAwayFromTimelineTail(scroller.scrollHeight, scroller.scrollTop, scroller.clientHeight);
    if (isAtTail) {
      followsTailRef.current = true;
      smoothScrollRef.current = false;
      clearSmoothScrollTimer();
    } else if (!smoothScrollRef.current) {
      followsTailRef.current = false;
    }
    setAwayFromTail(!isAtTail && !smoothScrollRef.current);
  }, [clearSmoothScrollTimer]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    if (autoScroll && followsTailRef.current) {
      scroller.scrollTop = scroller.scrollHeight;
      followsTailRef.current = true;
      setAwayFromTail(false);
    } else {
      updatePosition();
    }
  }, [autoScroll, rowsVersion, streamingText, queuedMessages, updatePosition]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    const content = scroller ? Array.from(scroller.children) : [];
    if (!scroller || !content.length || typeof ResizeObserver === "undefined") return;
    const onResize = () => {
      if (autoScroll && followsTailRef.current) {
        scroller.scrollTop = scroller.scrollHeight;
        setAwayFromTail(false);
      } else updatePosition();
    };
    const observer = new ResizeObserver(onResize);
    observer.observe(scroller);
    content.forEach(child => observer.observe(child));
    return () => observer.disconnect();
  }, [autoScroll, updatePosition]);

  useEffect(() => () => clearSmoothScrollTimer(), [clearSmoothScrollTimer]);

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
    followsTailRef.current = true;
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
    const behavior: ScrollBehavior = reducedMotion ? "auto" : "smooth";
    if (typeof scroller.scrollTo === "function") {
      smoothScrollRef.current = behavior === "smooth";
      setAwayFromTail(false);
      scroller.scrollTo({ top: scroller.scrollHeight, behavior });
      if (smoothScrollRef.current) {
        clearSmoothScrollTimer();
        smoothScrollTimerRef.current = window.setTimeout(() => {
          smoothScrollTimerRef.current = undefined;
          smoothScrollRef.current = false;
          updatePosition();
        }, 2000);
      }
    } else {
      smoothScrollRef.current = false;
      clearSmoothScrollTimer();
      scroller.scrollTop = scroller.scrollHeight;
      setAwayFromTail(false);
    }
  };

  const cancelSmoothScroll = () => {
    if (!smoothScrollRef.current) return;
    smoothScrollRef.current = false;
    clearSmoothScrollTimer();
    updatePosition();
  };

  return (
    <div className="xn-session-timeline-viewport" data-testid="session-timeline-viewport">
      <div
        ref={scrollerRef}
        className="xn-conversation__stream xn-session-timeline-viewport__scroll"
        onScroll={updatePosition}
        onWheel={cancelSmoothScroll}
        onTouchStart={cancelSmoothScroll}
        onPointerDown={cancelSmoothScroll}
        data-testid="session-timeline-scroller"
      >
        {children}
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
