import { get } from '../../xuenessApi';
import type { RuntimeMetrics } from './LocalRuntimeMonitor';

export function startRuntimeSampling({
  repeat = true,
  read = (signal: AbortSignal) => get<RuntimeMetrics>('/api/diagnostics/runtime', signal),
  onMetrics,
  onError,
  onLoading,
  schedule = (callback: () => void) => setTimeout(callback, 2000),
  clear = (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
}: {
  repeat?: boolean;
  read?: (signal: AbortSignal) => Promise<RuntimeMetrics>;
  onMetrics: (metrics: RuntimeMetrics) => void;
  onError: (failed: boolean) => void;
  onLoading: (loading: boolean) => void;
  schedule?: (callback: () => void) => ReturnType<typeof setTimeout>;
  clear?: (timer: ReturnType<typeof setTimeout>) => void;
}) {
  let active = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  const sample = async () => {
    if (!active) return;
    onLoading(true);
    try {
      const result = await read(controller.signal);
      if (active && result?.schema === 'xueness.runtime-metrics.v1') {
        onMetrics(result);
        onError(false);
      } else if (active) onError(true);
    } catch {
      if (active) onError(true);
    } finally {
      if (active) {
        onLoading(false);
        if (repeat) timer = schedule(() => { void sample(); });
      }
    }
  };
  void sample();
  return () => {
    active = false;
    controller.abort();
    if (timer !== undefined) clear(timer);
  };
}
