import { get } from '../../xuenessApi';

type Schedule = { setTimeout(callback: () => void, delay: number): unknown; clearTimeout(handle: unknown): void };
export type ElicitationSubscription = (() => void) & { refresh: () => void };

/** The MCP plugin owns this read-only subscription. An idle request waits on
 * the server; older hosts that ignore wait retain the bounded polling pace. */
export function subscribeElicitation({ sessionId, accept,
  request = (path: string, signal: AbortSignal) => get<unknown>(path, signal),
  visible = () => document.visibilityState !== 'hidden',
  subscribeVisibility = (listener: () => void) => {
    document.addEventListener('visibilitychange', listener);
    return () => document.removeEventListener('visibilitychange', listener);
  },
  schedule = { setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
    clearTimeout: handle => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>) },
}: {
  sessionId: string;
  accept: (body: unknown) => void;
  request?: (path: string, signal: AbortSignal) => Promise<unknown>;
  visible?: () => boolean;
  subscribeVisibility?: (listener: () => void) => () => void;
  schedule?: Schedule;
}): ElicitationSubscription {
  let stopped = false;
  let timer: unknown;
  let controller: AbortController | null = null;
  let failures = 0;
  const clearTimer = () => {
    if (timer !== undefined) schedule.clearTimeout(timer);
    timer = undefined;
  };
  const poll = async () => {
    if (stopped || controller || !visible()) return;
    const current = new AbortController();
    controller = current;
    let deadline: unknown;
    let onAbort: () => void = () => undefined;
    try {
      const body = await new Promise<unknown>((resolve, reject) => {
        onAbort = () => reject(new Error('Elicitation read aborted'));
        current.signal.addEventListener('abort', onAbort, { once: true });
        deadline = schedule.setTimeout(() => current.abort(), 30000);
        Promise.resolve(request(`/api/sessions/${encodeURIComponent(sessionId)}/elicitation?wait=20000`, current.signal))
          .then(resolve, reject);
      });
      if (!stopped && controller === current && !current.signal.aborted) {
        failures = 0;
        accept(body);
      }
    } catch {
      // Keep an unanswered form and its draft through a transient outage.
      // Only a confirmed response may remove or replace the pending request.
      if (!stopped && controller === current) failures += 1;
    } finally {
      schedule.clearTimeout(deadline);
      current.signal.removeEventListener('abort', onAbort);
      if (controller === current) {
        controller = null;
        if (!stopped && visible()) {
          clearTimer();
          timer = schedule.setTimeout(() => { timer = undefined; void poll(); },
            Math.min(10000, 1200 * 2 ** Math.min(failures, 4)));
        }
      }
    }
  };
  const onVisibility = () => {
    clearTimer();
    if (!visible()) {
      const previous = controller;
      controller = null;
      previous?.abort();
    } else void poll();
  };
  const unsubscribe = subscribeVisibility(onVisibility);
  void poll();
  const refresh = () => {
    if (stopped) return;
    clearTimer();
    const previous = controller;
    controller = null;
    previous?.abort();
    if (visible()) void poll();
  };
  const stop = () => {
    stopped = true;
    clearTimer();
    unsubscribe();
    controller?.abort();
    controller = null;
  };
  return Object.assign(stop, { refresh });
}
