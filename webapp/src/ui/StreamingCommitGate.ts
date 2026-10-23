import React from "react";

/** Shared presentation scheduler only: this module carries no session policy,
 * plugin lifecycle, requests, or permissions. The sessions plugin owns the
 * exported symbols; the lightweight provider view reuses the same cadence.
 * The default conversation reveals answers per frame (`useStreamingReveal`). */
export const STREAM_COMMIT_INTERVAL_MS = 150;

/** Rate-limit rapidly arriving display text and expose the deadline for a
 * trailing commit. Every accepted commit, including the trailing one, resets
 * the cadence so a later token cannot sneak in immediately afterward. */
export class StreamingCommitGate {
  private lastCommitAt = Number.NEGATIVE_INFINITY;
  private pending = false;

  constructor(private readonly intervalMs = STREAM_COMMIT_INTERVAL_MS) {}

  push(text: string, now: number): string | null {
    if (now - this.lastCommitAt >= this.intervalMs) return this.commit(text, now);
    this.pending = true;
    return null;
  }

  /** Record text committed by a trailing timer at its actual commit time. */
  commit(text: string, now: number): string {
    this.lastCommitAt = now;
    this.pending = false;
    return text;
  }

  dueAt(): number {
    return this.pending ? this.lastCommitAt + this.intervalMs : Number.POSITIVE_INFINITY;
  }

  reset(): void {
    this.lastCommitAt = Number.NEGATIVE_INFINITY;
    this.pending = false;
  }
}

/** Visible text advances at most once per frame of this length (~30 Hz). */
export const STREAM_REVEAL_FRAME_MS = 32;
/* Reveal pacing. The values were chosen by replaying recorded and synthetic
 * arrival traces (pushed, polled, bursty, slow) through this model. */
/** Time constant of the averaged arrival speed and arrival gap. */
const REVEAL_AVERAGE_MS = 500;
/** A longer silence is a pause (a tool call, thinking), not a slow stream. */
const REVEAL_PAUSE_MS = 1000;
/** Text kept in reserve: 2.5 measured arrival gaps, within these bounds. */
const REVEAL_RESERVE_GAPS = 2.5;
const REVEAL_RESERVE_MIN_MS = 50;
const REVEAL_RESERVE_MAX_MS = 250;
/** Time over which a reserve that is off its goal is corrected. */
const REVEAL_CORRECTION_MS = 1000;
/** The reserve is never shown faster than over this time (eases off instead
 * of running dry) nor slower than over the lag bound. */
const REVEAL_EASE_MS = 60;
const REVEAL_LAG_MS = 500;
/** After the stream ends, the remaining text drains within this window. */
const REVEAL_SETTLE_WINDOW_MS = 200;
/** A larger backlog (for example after a throttled background tab) is shown at once. */
const REVEAL_JUMP_CHARS = 4000;
const MARKDOWN_RUN = new Set(["*", "_", "~", "`", "#", "-", "=", "|", ">"]);

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Never split a surrogate pair, a combining sequence, or a run of one
 * markdown marker (`**`, a fence, a heading or a rule), so a partial marker
 * cannot flash as literal text for a frame. */
export function streamingRevealBoundary(text: string, index: number): number {
  let end = clamp(Math.floor(index), 0, text.length);
  if (end <= 0 || end >= text.length) return end;
  const previous = text.charCodeAt(end - 1);
  if (previous >= 0xd800 && previous <= 0xdbff) end += 1;
  while (end < text.length && /[\p{M}\u200d\ufe0e\ufe0f]/u.test(text[end] ?? "")) end += 1;
  const marker = text[end - 1] ?? "";
  if (MARKDOWN_RUN.has(marker)) while (end < text.length && text[end] === marker) end += 1;
  return end;
}

/** Pure pacing model for growing stream text. The reveal speed follows a
 * time-weighted average of the arrival speed rather than being recomputed
 * for every batch, so text moves at an even pace while arrivals jitter. A
 * small reserve, sized from the measured arrival gap, bridges late arrivals;
 * the speed is nudged to keep that reserve and bounded so the reveal neither
 * runs dry abruptly nor lags far behind. Rewrites keep only the common prefix. */
export class StreamingRevealPacer {
  private target: string;
  /** Revealed UTF-16 units; fractional between frames. */
  private shown: number;
  /** Averaged arrival speed (units per ms) and arrival gap (ms). */
  private speed = 0;
  private gap = 0;
  private settleRate = 0;
  private lastTickAt: number | null = null;
  private lastGrowthAt: number | null = null;
  private streaming: boolean;

  constructor(initial = "", streaming = false) {
    this.target = initial;
    this.shown = initial.length;
    this.streaming = streaming;
  }

  get done(): boolean {
    return this.shown >= this.target.length;
  }

  /** Accept the latest text. Idempotent for an unchanged text and state. */
  setTarget(text: string, now: number, streaming: boolean): void {
    const wasStreaming = this.streaming;
    const wasDone = this.done;
    this.streaming = streaming;
    if (text === this.target) {
      if (wasStreaming && !streaming) this.settle();
      return;
    }
    const visible = streamingRevealBoundary(this.target, this.shown);
    if ((!streaming && !wasStreaming && wasDone) || text.length - visible > REVEAL_JUMP_CHARS) {
      this.target = text;
      this.shown = text.length;
      return;
    }
    const growth = text.length - this.target.length;
    if (!text.startsWith(this.target.slice(0, visible))) {
      let common = 0;
      const limit = Math.min(visible, text.length);
      while (common < limit && text.charCodeAt(common) === this.target.charCodeAt(common)) common += 1;
      this.shown = common;
    } else {
      this.shown = Math.min(this.shown, text.length);
    }
    if (streaming && growth > 0) {
      const gap = this.lastGrowthAt === null ? Infinity : Math.max(1, now - this.lastGrowthAt);
      this.lastGrowthAt = now;
      if (gap <= REVEAL_PAUSE_MS) {
        // The first measured gap is taken as is; later ones are averaged by time.
        const weight = this.speed > 0 ? 1 - Math.exp(-gap / REVEAL_AVERAGE_MS) : 1;
        this.speed += (growth / gap - this.speed) * weight;
        this.gap += (gap - this.gap) * weight;
      }
    }
    this.target = text;
    // A reveal that had caught up starts again from this arrival.
    if (wasDone) this.lastTickAt = now;
    if (!streaming) this.settle();
  }

  private settle(): void {
    this.settleRate = (this.target.length - this.shown) / REVEAL_SETTLE_WINDOW_MS;
  }

  /** Show everything received so far (reduced motion: no paced reveal). */
  finish(): void {
    this.shown = this.target.length;
  }

  /** Move the reveal forward to `now`. */
  advance(now: number): void {
    const last = this.lastTickAt;
    this.lastTickAt = now;
    if (last === null || this.done) return;
    const backlog = this.target.length - this.shown;
    const reserve = clamp(this.gap * REVEAL_RESERVE_GAPS, REVEAL_RESERVE_MIN_MS, REVEAL_RESERVE_MAX_MS);
    const rate = this.streaming
      ? clamp(this.speed + (backlog - this.speed * reserve) / REVEAL_CORRECTION_MS, backlog / REVEAL_LAG_MS, backlog / REVEAL_EASE_MS)
      : Math.max(this.speed, this.settleRate);
    this.shown = Math.min(this.target.length, this.shown + rate * Math.max(0, now - last));
    // Less than one unit left: show it rather than approach it forever.
    if (this.target.length - this.shown < 1) this.shown = this.target.length;
  }

  /** Text revealed so far; the complete text once done. */
  visible(): string {
    if (this.done) return this.target;
    return this.target.slice(0, streamingRevealBoundary(this.target, this.shown));
  }
}

type FrameHandle = { cancel: () => void };

let reducedMotionQuery: MediaQueryList | null | undefined;

/** The paced reveal is non-essential motion; honour the system setting. */
function prefersReducedMotion(): boolean {
  if (reducedMotionQuery === undefined) {
    reducedMotionQuery = typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-reduced-motion: reduce)")
      : null;
  }
  return reducedMotionQuery?.matches === true;
}

function requestRevealFrame(callback: () => void): FrameHandle {
  if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
    const id = window.requestAnimationFrame(callback);
    return { cancel: () => window.cancelAnimationFrame(id) };
  }
  const id = setTimeout(callback, 16);
  return { cancel: () => clearTimeout(id) };
}

function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/** Reveal growing stream text at an even pace. `revealing` stays true after
 * the stream ends until the remaining text has been shown, so the caller can
 * keep its streaming presentation for that short tail instead of popping the
 * rest at once. Text present at mount, and all text when the system asks for
 * reduced motion, is shown immediately. */
export function useStreamingReveal(text: string, streaming: boolean): { text: string; revealing: boolean } {
  const pacerRef = React.useRef<StreamingRevealPacer | null>(null);
  if (pacerRef.current === null) pacerRef.current = new StreamingRevealPacer(text, streaming);
  const pacer = pacerRef.current;
  pacer.setTarget(text, nowMs(), streaming);
  if (prefersReducedMotion()) pacer.finish();
  const [, render] = React.useReducer((value: number) => value + 1, 0);
  const frameRef = React.useRef<FrameHandle | null>(null);
  const renderedAtRef = React.useRef(Number.NEGATIVE_INFINITY);
  const done = pacer.done;

  React.useEffect(() => {
    if (done || frameRef.current !== null) return;
    const tick = () => {
      frameRef.current = null;
      const now = nowMs();
      if (now - renderedAtRef.current >= STREAM_REVEAL_FRAME_MS - 4) {
        renderedAtRef.current = now;
        pacer.advance(now);
        render();
      }
      if (!pacer.done) frameRef.current = requestRevealFrame(tick);
    };
    frameRef.current = requestRevealFrame(tick);
  });

  React.useEffect(() => () => {
    frameRef.current?.cancel();
    frameRef.current = null;
  }, []);

  return { text: pacer.visible(), revealing: !done };
}

/** Quantize growing stream text. The latest held text is committed once the
 * interval expires; ending a stream returns its exact final value in that
 * render, and both stream end and unmount clear pending timers. */
export function useQuantizedStreamingText(text: string, streaming: boolean): string {
  const [committed, setCommitted] = React.useState(text);
  const latestRef = React.useRef(text);
  latestRef.current = text;
  const gateRef = React.useRef<StreamingCommitGate | null>(null);
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    const clearTimer = () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
    if (!streaming) {
      clearTimer();
      gateRef.current?.reset();
      setCommitted(text);
      return clearTimer;
    }

    const gate = gateRef.current ?? (gateRef.current = new StreamingCommitGate());
    const now = Date.now();
    const decision = gate.push(text, now);
    if (decision !== null) {
      clearTimer();
      setCommitted(decision);
      return clearTimer;
    }
    if (timerRef.current === null) {
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        const latest = latestRef.current;
        setCommitted(gate.commit(latest, Date.now()));
      }, Math.max(0, gate.dueAt() - now));
    }
    return clearTimer;
  }, [text, streaming]);

  React.useEffect(() => () => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = null;
    gateRef.current?.reset();
  }, []);

  return streaming ? committed : text;
}
