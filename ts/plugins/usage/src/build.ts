/** Session collection and provider-reported tokens (`usage_api.build_usage`). Read-only. */
import { statSync } from "node:fs";
import { join } from "node:path";
import { isPyIntValue, isPyNumeric, numericValue, pySlice, pyStrip } from "@xueness/contracts";
import { aggregate, coerceMtime, coerceNow, isoUtc, localDay, normalizeRange } from "./aggregate.ts";

const SID = /^[A-Za-z0-9._-]{1,128}$/;
const RANGE_SECONDS: Record<string, number> = { "7d": 7 * 86400, "30d": 30 * 86400 };

export interface UsageStore {
  directory?: unknown;
  list(): unknown;
  load(sid: string): unknown;
}

interface Bucket {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  requestCount: number;
  unknownRequests: number;
  costs: Record<string, number>;
  model?: string | null;
  protocol?: string | null;
  date?: string;
  models?: Map<string, Bucket>;
}

const blank = (): Bucket => ({ inputTokens: 0, outputTokens: 0, totalTokens: 0, requestCount: 0, unknownRequests: 0, costs: {} });

function entryId(entry: unknown): string | null {
  const sid = entry !== null && typeof entry === "object" ? (entry as { id?: unknown }).id : undefined;
  return typeof sid === "string" && sid ? sid : null;
}

function entryMtime(entry: unknown): number | null {
  if (entry === null || typeof entry !== "object") return null;
  const row = entry as Record<string, unknown>;
  for (const field of ["mtime", "updatedAt", "createdAt"]) {
    const mtime = coerceMtime(row[field]);
    if (mtime !== null) return mtime;
  }
  return null;
}

function fileMtime(directory: unknown, sid: string): number | null {
  if (typeof directory !== "string" || !SID.test(sid)) return null;
  try {
    return coerceMtime(statSync(join(directory, `${sid}.json`)).mtimeMs / 1000);
  } catch {
    return null;
  }
}

function sessionMtime(session: Record<string, unknown>): number | null {
  for (const field of ["mtime", "updatedAt"]) {
    const mtime = coerceMtime(session[field]);
    if (mtime !== null) return mtime;
  }
  return null;
}

export async function collectSessions(store: UsageStore | null | undefined): Promise<Record<string, unknown>[]> {
  if (store == null) return [];
  let entries: unknown;
  try { entries = await store.list(); } catch { return []; }
  if (!Array.isArray(entries)) return [];
  const sessions: Record<string, unknown>[] = [];
  for (const entry of entries) {
    const sid = entryId(entry);
    if (sid === null) continue;
    let session: unknown;
    try { session = await store.load(sid); } catch { continue; }
    if (session === null || typeof session !== "object" || Array.isArray(session)) continue;
    const row = session as Record<string, unknown>;
    const mtime = fileMtime(store.directory, sid) ?? sessionMtime(row) ?? entryMtime(entry) ?? Date.now() / 1000;
    sessions.push({ id: sid, status: row.status, steps: row.steps ?? 0, mtime, provider_usage: row.provider_usage ?? [] });
  }
  return sessions;
}

function counter(usage: Record<string, unknown>, primary: string, fallback: string): number | null {
  const value = Object.hasOwn(usage, primary) ? usage[primary] : usage[fallback];
  return isPyIntValue(value) && typeof value === "number" && value >= 0 ? value : null;
}

function addCost(costs: Record<string, number>, cost: unknown): void {
  if (cost === null || typeof cost !== "object" || Array.isArray(cost)) return;
  const row = cost as Record<string, unknown>;
  const amount = row.amount;
  if (typeof row.currency !== "string" || !isPyNumeric(amount)) return;
  const value = numericValue(amount);
  if (value === null || !Number.isFinite(value) || value < 0) return;
  const currency = row.currency.slice(0, 10);
  costs[currency] = (costs[currency] ?? 0) + value;
}

function bucketFor(collection: Map<string, Bucket>, key: string, model: string | null, protocol: string | null): Bucket {
  let bucket = collection.get(key);
  if (!bucket) {
    bucket = blank();
    if (model !== null || protocol !== null) { bucket.model = model; bucket.protocol = protocol; }
    collection.set(key, bucket);
  }
  return bucket;
}

function modelSort(rows: Bucket[]): Bucket[] {
  const name = (bucket: Bucket): string => bucket.model ?? "";
  return [...rows].sort((left, right) => right.totalTokens - left.totalTokens || right.requestCount - left.requestCount || (name(left) < name(right) ? -1 : name(left) > name(right) ? 1 : 0));
}

function shiftDay(date: string, days: number): string {
  const cursor = new Date(`${date}T12:00:00`);
  cursor.setDate(cursor.getDate() + days);
  return localDay(cursor.getTime() / 1000);
}

function applyTokens(bucket: Bucket, incoming: number | null, outgoing: number | null, total: number | null, usage: Record<string, unknown>, cost: unknown): void {
  bucket.requestCount += 1;
  if (incoming !== null) bucket.inputTokens += incoming;
  if (outgoing !== null) bucket.outputTokens += outgoing;
  if (total !== null) bucket.totalTokens += total;
  if ((incoming === null || outgoing === null) && Object.keys(usage).length) bucket.unknownRequests += 1;
  addCost(bucket.costs, cost);
}

/** Full payload. `now` is seconds. Provider rows are filtered on their own stamp, not the session window. */
export async function buildUsage(ctx: { store?: UsageStore | null }, rangeKey?: unknown, now?: unknown): Promise<Record<string, unknown>> {
  const sessions = await collectSessions(ctx.store);
  const result: Record<string, unknown> = { ...aggregate(sessions, rangeKey, now) };
  const reference = coerceNow(now);
  const key = normalizeRange(rangeKey);
  const cutoff = key === "all" ? null : reference - (RANGE_SECONDS[key] ?? 0);
  const tokens = { input: 0, output: 0, total: 0, reportedRequests: 0, unknownRequests: 0 };
  const costs: Record<string, number> = {};
  const daily = new Map<string, Bucket>();
  const models = new Map<string, Bucket>();
  let saw = false;
  for (const session of sessions) {
    for (const record of session.provider_usage as unknown[]) {
      if (record === null || typeof record !== "object" || Array.isArray(record)) continue;
      saw = true;
      const row = record as Record<string, unknown>;
      const stamp = coerceMtime(row.at);
      if (cutoff !== null && (stamp === null || stamp < cutoff)) continue;
      const usage = row.usage !== null && typeof row.usage === "object" && !Array.isArray(row.usage) ? row.usage as Record<string, unknown> : {};
      const incoming = counter(usage, "prompt_tokens", "input_tokens");
      const outgoing = counter(usage, "completion_tokens", "output_tokens");
      let total = isPyIntValue(usage.total_tokens) && typeof usage.total_tokens === "number" && usage.total_tokens >= 0 ? usage.total_tokens : null;
      if (total === null && incoming !== null && outgoing !== null) total = incoming + outgoing;
      if (incoming !== null) tokens.input += incoming;
      if (outgoing !== null) tokens.output += outgoing;
      if (total !== null) tokens.total += total;
      const complete = incoming !== null && outgoing !== null;
      if (complete) tokens.reportedRequests += 1;
      else if (Object.keys(usage).length) tokens.unknownRequests += 1;
      const modelText = typeof row.model === "string" ? pyStrip(row.model) : "";
      const model = modelText ? pySlice(modelText, 160) : null;
      const protocol = row.protocol === "openai" || row.protocol === "anthropic" ? row.protocol : null;
      const modelKey = `${protocol ?? ""}\0${model ?? ""}`;
      const modelBucket = bucketFor(models, modelKey, model, protocol);
      if (!Object.hasOwn(modelBucket, "model")) modelBucket.model = model;
      if (!Object.hasOwn(modelBucket, "protocol")) modelBucket.protocol = protocol;
      applyTokens(modelBucket, incoming, outgoing, total, usage, row.cost);
      if (stamp !== null) {
        const date = localDay(stamp);
        const dayBucket = bucketFor(daily, date, null, null);
        dayBucket.date = date;
        applyTokens(dayBucket, incoming, outgoing, total, usage, row.cost);
        const dayModels = dayBucket.models ?? new Map<string, Bucket>();
        dayBucket.models = dayModels;
        const dailyModel = bucketFor(dayModels, modelKey, model, protocol);
        if (!Object.hasOwn(dailyModel, "model")) dailyModel.model = model;
        if (!Object.hasOwn(dailyModel, "protocol")) dailyModel.protocol = protocol;
        applyTokens(dailyModel, incoming, outgoing, total, usage, row.cost);
      }
      addCost(costs, row.cost);
    }
  }
  if (saw) {
    const active = [...daily.keys()].filter((date) => (daily.get(date)?.totalTokens ?? 0) > 0).sort();
    const activeSet = new Set(active);
    let currentStreak = 0;
    for (let cursor = localDay(reference); activeSet.has(cursor); cursor = shiftDay(cursor, -1)) currentStreak += 1;
    let longest = 0;
    let streak = 0;
    let previous: string | null = null;
    for (const date of active) {
      streak = previous !== null && date === shiftDay(previous, 1) ? streak + 1 : 1;
      longest = Math.max(longest, streak);
      previous = date;
    }
    result.tokens = tokens;
    result.costs = costs;
    result.costSource = "provider-reported only; missing prices are not estimated";
    result.dailyUsage = [...daily.entries()].sort((left, right) => left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0).map(([, item]) => ({
      ...publicBucket(item), date: item.date, models: modelSort([...(item.models?.values() ?? [])]).map(publicBucket),
    }));
    result.models = modelSort([...models.values()]).map(publicBucket);
    result.tokenActivity = {
      activeDays: active.length,
      peakDayTokens: Math.max(0, ...[...daily.values()].map((item) => item.totalTokens)),
      currentStreakDays: currentStreak,
      longestStreakDays: longest,
    };
  }
  result.updatedAt = isoUtc(coerceNow(now));
  return result;
}

function publicBucket(bucket: Bucket): Record<string, unknown> {
  return {
    ...(Object.hasOwn(bucket, "model") ? { model: bucket.model ?? null } : {}),
    ...(Object.hasOwn(bucket, "protocol") ? { protocol: bucket.protocol ?? null } : {}),
    inputTokens: bucket.inputTokens, outputTokens: bucket.outputTokens, totalTokens: bucket.totalTokens,
    requestCount: bucket.requestCount, unknownRequests: bucket.unknownRequests, costs: bucket.costs,
  };
}
