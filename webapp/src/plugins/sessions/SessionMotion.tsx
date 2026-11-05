/**
 * Session motion helpers (sessions plugin). Presentation only: nothing here
 * starts requests, changes permissions or touches session data.
 *
 * - `runViewTransition` morphs a synchronous layout change (sidebar collapse,
 *   pane swaps) with the View Transitions API. `<html data-xn-vt>` scopes which
 *   elements receive transition names, so unrelated transitions (the theme
 *   reveal) keep animating the root as one surface.
 * - `LiveElapsed` is the ticking "12 s" counter next to a running turn. It is
 *   aria-hidden: the surrounding live region already announces the state, and a
 *   per-second announcement would flood screen readers.
 */
import React from "react";
import { flushSync } from "react-dom";
import { getLocale } from "../../i18n";
import { formatConversationWorkDuration } from "./conversationWorkDuration";

type TransitionDocument = Document & { startViewTransition?: (update: () => void) => { finished: Promise<unknown> } };

/** System reduced-motion and the in-app motion preference both opt out. */
export function sessionMotionAllowed(): boolean {
  if (typeof window === "undefined" || typeof document === "undefined") return false;
  if (document.documentElement.dataset.xnMotion === "reduced") return false;
  return !(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
}

/** Apply `update` inside a view transition when the platform allows it. */
export function runViewTransition(kind: string, update: () => void): void {
  const doc = document as TransitionDocument;
  if (!sessionMotionAllowed() || typeof doc.startViewTransition !== "function" || doc.visibilityState !== "visible") {
    update();
    return;
  }
  const root = doc.documentElement;
  root.dataset.xnVt = kind;
  const clear = () => { if (root.dataset.xnVt === kind) delete root.dataset.xnVt; };
  try {
    const transition = doc.startViewTransition(() => flushSync(update));
    transition.finished.then(clear, clear);
  } catch {
    clear();
    update();
  }
}

/** Seconds since `since` (epoch ms), or since mount when the start is unknown. */
export function LiveElapsed({ since, className = "xn-live-elapsed" }: { since?: number; className?: string }): React.JSX.Element | null {
  const [mountedAt] = React.useState(() => Date.now());
  const start = since !== undefined && Number.isFinite(since) && since <= Date.now() ? since : mountedAt;
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const elapsed = now - start;
  if (elapsed < 1000) return null;
  return <span className={className} aria-hidden="true">{formatConversationWorkDuration(elapsed, getLocale() === "en" ? "en" : "zh")}</span>;
}
