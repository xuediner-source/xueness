import React from "react";

/** Shared presentation scheduler only: this module carries no session policy,
 * plugin lifecycle, requests, or permissions. The sessions plugin owns the
 * exported symbols; the lightweight provider view reuses the same cadence. */
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
