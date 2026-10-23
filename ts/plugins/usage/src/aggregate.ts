/** Pure usage window (`usage_api.aggregate`). Local calendar days, UTC `updatedAt` stamps. */
import { isPyFloatValue, isPyIntValue } from "@xueness/contracts";

export const RANGES = ["7d", "30d", "all"] as const;
const RANGE_SECONDS: Record<string, number> = { "7d": 7 * 86400, "30d": 30 * 86400 };

export function normalizeRange(value: unknown): string {
  if (typeof value === "string") {
    const candidate = value.trim().toLowerCase();
    if ((RANGES as readonly string[]).includes(candidate)) return candidate;
  }
  return "7d";
}

export function coerceNow(now?: unknown): number {
  if (now == null) return Date.now() / 1000;
  if (now instanceof Date) {
    const value = now.getTime() / 1000;
    return Number.isFinite(value) ? value : Date.now() / 1000;
  }
  if (typeof now === "boolean") return Date.now() / 1000;
  if (typeof now === "number" && Number.isFinite(now)) return now;
  return Date.now() / 1000;
}

export function coerceMtime(value: unknown): number | null {
  if (typeof value === "boolean" || value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || !value.trim()) return null;
  const text = value.trim();
  const numeric = Number(text);
  if (text !== "" && Number.isFinite(numeric) && /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(text)) return numeric;
  const parsed = Date.parse(text.replace("Z", "+00:00").endsWith("+00:00") || text.endsWith("Z") ? text : text);
  if (!Number.isFinite(parsed)) return null;
  return parsed / 1000;
}

export function coerceSteps(value: unknown): number {
  if (typeof value === "boolean") return 0;
  if (isPyIntValue(value) && typeof value === "number") return value > 0 ? value : 0;
  if (isPyFloatValue(value) && typeof value === "number" && Number.isFinite(value) && value > 0) return Math.trunc(value);
  return 0;
}

/** Python `datetime.fromtimestamp` in the local zone. */
export function localDay(mtime: number): string {
  const stamp = new Date(mtime * 1000);
  if (Number.isNaN(stamp.getTime())) throw new Error("timestamp out of range");
  const month = String(stamp.getMonth() + 1).padStart(2, "0");
  const day = String(stamp.getDate()).padStart(2, "0");
  return `${stamp.getFullYear()}-${month}-${day}`;
}

/** UTC `isoformat(timespec="seconds")` with `Z`. */
export function isoUtc(ts: number): string {
  const stamp = new Date(ts * 1000);
  if (Number.isNaN(stamp.getTime())) throw new Error("timestamp out of range");
  return stamp.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export interface UsageRow { id?: unknown; status?: unknown; steps?: unknown; mtime?: unknown }

export function aggregate(sessions: unknown, rangeKey?: unknown, now?: unknown): { range: string; totals: { sessions: number; steps: number; completed: number }; series: { date: string; sessions: number; steps: number }[] } {
  const key = normalizeRange(rangeKey);
  const reference = coerceNow(now);
  const cutoff = key === "all" ? null : reference - (RANGE_SECONDS[key] ?? 0);
  const totals = { sessions: 0, steps: 0, completed: 0 };
  const buckets = new Map<string, { date: string; sessions: number; steps: number }>();
  const rows = Array.isArray(sessions) ? sessions : [];
  for (const session of rows) {
    if (session === null || typeof session !== "object" || Array.isArray(session)) continue;
    const row = session as UsageRow;
    const mtime = coerceMtime(row.mtime);
    if (mtime === null || (cutoff !== null && mtime < cutoff)) continue;
    let day: string;
    try { day = localDay(mtime); } catch { continue; }
    const steps = coerceSteps(row.steps);
    totals.sessions += 1;
    totals.steps += steps;
    if (row.status === "completed") totals.completed += 1;
    const bucket = buckets.get(day) ?? { date: day, sessions: 0, steps: 0 };
    bucket.sessions += 1;
    bucket.steps += steps;
    buckets.set(day, bucket);
  }
  return { range: key, totals, series: [...buckets.keys()].sort().map((day) => buckets.get(day)!) };
}
