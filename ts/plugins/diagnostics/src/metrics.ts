/** Best-effort host sample. Windows uses `os` totals instead of a ctypes probe. */
import { statfsSync } from "node:fs";
import { cpus, freemem, loadavg, platform, totalmem } from "node:os";
import { resolve } from "node:path";

const SCHEMA = "xueness.runtime-metrics.v1";
const SAMPLE_SECONDS = 2;
const GPU_UNAVAILABLE_REASON = "GPU 内存遥测不可用于本地运行时采样。";

interface Snapshot {
  schema: string;
  sampledAtISO: string;
  samplingSeconds: number;
  cpu: { logicalCores: number | null; loadAverage: Array<number | null>; processPercent: number | null };
  memory: { totalBytes: number | null; availableBytes: number | null; availableKind: string | null; processRssBytes: number | null };
  disk: { totalBytes: number | null; availableBytes: number | null };
  gpu: { available: false; reason: string };
}

const caches = new Map<string, { at: number; value: Snapshot; cpu: { at: number; used: number } | null }>();

function bounded(value: number): number | null {
  return Number.isFinite(value) && value >= 0 && value <= 2 ** 60 ? value : null;
}

function sample(stateDir: string, previous: { at: number; used: number } | null): { value: Snapshot; cpu: { at: number; used: number } } {
  const cores = cpus().length;
  const cpuNow = process.cpuUsage();
  const used = (cpuNow.user + cpuNow.system) / 1000;
  const at = performance.now();
  let processPercent: number | null = null;
  if (previous && at > previous.at && used >= previous.used) {
    const percent = (used - previous.used) / (at - previous.at) * 100;
    processPercent = Number.isFinite(percent) ? Math.round(Math.min(percent, cores * 100) * 100) / 100 : null;
  }
  let diskTotal: number | null = null;
  let diskFree: number | null = null;
  try {
    const disk = statfsSync(stateDir);
    diskTotal = bounded(Number(disk.blocks) * Number(disk.bsize));
    diskFree = bounded(Number(disk.bavail) * Number(disk.bsize));
  } catch { /* disk probe is optional */ }
  const load = loadavg();
  return {
    cpu: { at, used },
    value: {
      schema: SCHEMA,
      sampledAtISO: new Date().toISOString(),
      samplingSeconds: SAMPLE_SECONDS,
      cpu: { logicalCores: cores > 0 && cores <= 65536 ? cores : null, loadAverage: [load[0] ?? null, load[1] ?? null, load[2] ?? null], processPercent },
      memory: {
        totalBytes: bounded(totalmem()),
        availableBytes: bounded(Math.min(freemem(), totalmem())),
        availableKind: platform() === "win32" ? "available" : "os_freemem",
        processRssBytes: bounded(process.memoryUsage().rss),
      },
      disk: { totalBytes: diskTotal, availableBytes: diskFree },
      gpu: { available: false, reason: GPU_UNAVAILABLE_REASON },
    },
  };
}

export function runtimeSnapshot(stateDir: string): Snapshot {
  const key = resolve(stateDir);
  const cache = caches.get(key);
  const now = performance.now();
  if (cache && now - cache.at < SAMPLE_SECONDS * 1000) return structuredClone(cache.value);
  const next = sample(key, cache?.cpu ?? null);
  const row = { at: now, value: next.value, cpu: next.cpu };
  caches.set(key, row);
  if (caches.size > 64) caches.delete(caches.keys().next().value!);
  return structuredClone(next.value);
}
