import { boundPaneRatio } from './paneLayout';

/** CSS-only drag previews; layout persistence happens once on a valid finish. */
export function startPaneResize({ ratio, startClient, extent, preview, commit,
  isEnabled = () => true, scheduleFrame = callback => requestAnimationFrame(callback),
  cancelFrame = id => cancelAnimationFrame(id),
}: {
  ratio: number;
  startClient: number;
  extent: number;
  preview: (ratio: number) => void;
  commit: (ratio: number) => void;
  isEnabled?: () => boolean;
  scheduleFrame?: (callback: () => void) => number;
  cancelFrame?: (id: number) => void;
}) {
  const startRatio = boundPaneRatio(ratio);
  let active = Number.isFinite(startClient) && Number.isFinite(extent) && extent > 0;
  let latestClient = startClient;
  let frame: number | null = null;
  const value = () => boundPaneRatio(startRatio + (latestClient - startClient) / extent);
  const stop = () => {
    active = false;
    if (frame !== null) {
      const pending = frame;
      frame = null;
      cancelFrame(pending);
    }
  };
  const cancel = (restore = true) => {
    if (!active) return;
    stop();
    if (restore && isEnabled()) preview(startRatio);
  };
  return {
    move(client: number) {
      if (!active) return;
      if (!isEnabled()) { cancel(false); return; }
      if (!Number.isFinite(client)) return;
      latestClient = client;
      if (frame !== null) return;
      frame = scheduleFrame(() => {
        frame = null;
        if (!active) return;
        if (!isEnabled()) { cancel(false); return; }
        preview(value());
      });
    },
    finish(client: number) {
      if (!active) return;
      if (!isEnabled()) { cancel(false); return; }
      if (!Number.isFinite(client)) { cancel(); return; }
      latestClient = client;
      const finalRatio = value();
      stop();
      preview(finalRatio);
      if (isEnabled()) commit(finalRatio);
    },
    cancel,
  };
}
