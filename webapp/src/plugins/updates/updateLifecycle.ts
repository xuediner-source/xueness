export type PollableUpdateState = { phase?: string } | null;

type PollOptions<T extends PollableUpdateState> = {
  readStatus: () => Promise<T>;
  onStatus: (state: T) => void;
  onError: (error: unknown) => void;
  compact: boolean;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancel?: (handle: unknown) => void;
};

/** Start one bounded status poller. The returned disposer prevents stale or
 * queued callbacks from starting more requests after the panel is disabled. */
export function startUpdateStatusPolling<T extends PollableUpdateState>(options: PollOptions<T>): () => void {
  const schedule = options.schedule ?? ((callback, delay) => setTimeout(callback, delay));
  const cancel = options.cancel ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let active = true;
  let timer: unknown;
  const poll = async () => {
    if (!active) return;
    let next: T | null = null;
    try {
      next = await options.readStatus();
      if (active) options.onStatus(next);
    } catch (error) {
      if (active) options.onError(error);
    }
    if (active && next?.phase !== "unsupported") {
      const delay = next && ["checking", "downloading", "installing", "opening-installer"].includes(next.phase ?? "")
        ? 1000
        : options.compact ? 30000 : 10000;
      timer = schedule(() => { timer = undefined; void poll(); }, delay);
    }
  };
  void poll();
  return () => {
    active = false;
    if (timer !== undefined) {
      cancel(timer);
      timer = undefined;
    }
  };
}

export type UpdateActionState = { phase?: string; canDownload?: boolean; canInstall?: boolean; installMode?: string } | null;

export function updateActionAvailability(state: UpdateActionState, busy: boolean) {
  const phase = state?.phase;
  const manualReady = phase === "ready" && state?.installMode === "open-dmg";
  return {
    checkDisabled: busy || !state || ["unsupported", "disabled", "downloading", "installing"].includes(phase ?? ""),
    downloadDisabled: busy || !state?.canDownload,
    installDisabled: busy || !(state?.canInstall || manualReady),
    cancelDisabled: busy,
  };
}
