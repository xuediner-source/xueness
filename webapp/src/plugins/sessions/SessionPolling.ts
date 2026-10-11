import { useEffect } from "react";

type SessionPollSchedule = {
  setTimeout(callback: () => void, delay: number): unknown;
  clearTimeout(handle: unknown): void;
};

export type SessionPollingOptions = {
  refresh: () => Promise<unknown>;
  isVisible?: () => boolean;
  subscribeVisibility?: (listener: () => void) => () => void;
  isOnline?: () => boolean;
  schedule?: SessionPollSchedule;
  visibleDelayMs?: number;
  hiddenDelayMs?: number;
};

function browserVisibility(): boolean {
  return typeof document === "undefined" || document.visibilityState === "visible";
}

/** Internet connectivity does not determine reachability of the desktop API. */
export function sessionPollingNetworkAvailable(online: boolean, hostname: string): boolean {
  return online || ['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname);
}

function subscribeBrowserVisibility(listener: () => void): () => void {
  if (typeof document === "undefined") return () => undefined;
  document.addEventListener("visibilitychange", listener);
  window.addEventListener("focus", listener);
  window.addEventListener("online", listener);
  window.addEventListener("offline", listener);
  return () => {
    document.removeEventListener("visibilitychange", listener);
    window.removeEventListener("focus", listener);
    window.removeEventListener("online", listener);
    window.removeEventListener("offline", listener);
  };
}

/** Polls sequentially, slows background tabs, and runs promptly when they return. */
export function startSessionPolling({
  refresh,
  isVisible = browserVisibility,
  subscribeVisibility = subscribeBrowserVisibility,
  isOnline = () => sessionPollingNetworkAvailable(typeof navigator === 'undefined' || navigator.onLine !== false,
    typeof window === 'undefined' ? '' : window.location.hostname),
  schedule = { setTimeout: (callback, delay) => window.setTimeout(callback, delay), clearTimeout: handle => window.clearTimeout(handle as number) },
  visibleDelayMs = 1000,
  hiddenDelayMs = 5000,
}: SessionPollingOptions): () => void {
  let stopped = false;
  let timer: unknown;
  let inFlight = false;
  let refreshWhenFinished = false;

  const clearTimer = () => {
    if (timer === undefined) return;
    schedule.clearTimeout(timer);
    timer = undefined;
  };
  const scheduleNext = (delay: number) => {
    if (stopped || timer !== undefined || !isOnline()) return;
    timer = schedule.setTimeout(() => {
      timer = undefined;
      void poll();
    }, delay);
  };
  const poll = async () => {
    if (stopped || inFlight || !isOnline()) return;
    inFlight = true;
    try {
      await refresh();
    } catch {
      // A transient refresh failure should not end lifecycle polling.
    } finally {
      inFlight = false;
      if (stopped) return;
      if (refreshWhenFinished && isVisible()) {
        refreshWhenFinished = false;
        scheduleNext(0);
      } else {
        refreshWhenFinished = false;
        scheduleNext(isVisible() ? visibleDelayMs : Math.max(hiddenDelayMs, visibleDelayMs));
      }
    }
  };
  const onVisibility = () => {
    if (stopped) return;
    if (!isOnline()) { clearTimer(); refreshWhenFinished = false; return; }
    if (isVisible()) {
      if (inFlight) refreshWhenFinished = true;
      else {
        clearTimer();
        scheduleNext(0);
      }
    } else if (!inFlight) {
      clearTimer();
      scheduleNext(Math.max(hiddenDelayMs, visibleDelayMs));
    }
  };

  const unsubscribe = subscribeVisibility(onVisibility);
  scheduleNext(isVisible() ? visibleDelayMs : Math.max(hiddenDelayMs, visibleDelayMs));
  return () => {
    stopped = true;
    clearTimer();
    unsubscribe();
  };
}

/** Coalesce active-session refreshes so actions and the poller never overlap requests. */
export function createSingleFlightRefresh<Args extends unknown[]>(refresh: (...args: Args) => Promise<unknown>): (...args: Args) => Promise<void> {
  let inFlight: Promise<void> | null = null;
  let refreshAgain = false;
  let latestArgs: Args;
  return (...args: Args) => {
    latestArgs = args;
    if (inFlight) {
      refreshAgain = true;
      return inFlight;
    }
    const operation = (async () => {
      let failure: unknown;
      let failed = false;
      do {
        refreshAgain = false;
        try { await refresh(...latestArgs); failed = false; }
        catch (error) { failure = error; failed = true; }
      } while (refreshAgain);
      if (failed) throw failure;
    })();
    inFlight = operation.finally(() => { inFlight = null; });
    return inFlight;
  };
}

export function useSessionPolling(enabled: boolean, refresh: () => Promise<unknown>, visibleDelayMs = 1000): void {
  useEffect(() => {
    if (!enabled) return;
    return startSessionPolling({ refresh, visibleDelayMs });
  }, [enabled, refresh, visibleDelayMs]);
}
