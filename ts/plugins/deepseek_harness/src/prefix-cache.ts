/**
 * Deterministic KV-cache prefix stabilizer (H01.03).
 *
 * Provider-side prompt caches (DeepSeek context caching on V4.1 / R1) match the
 * longest byte-identical prefix of a request against previously seen requests.
 * Anything request-volatile in that prefix — unordered tool declarations,
 * key-order-dependent JSON, per-turn regenerated system prompts — silently
 * resets the match point and the cache stops hitting.
 *
 * This module keeps one session's stable prefix byte-identical across turns and
 * measures the hit rate against the previous request of the same session:
 *
 *  - `canonicalJson` serializes with sorted object keys and stable scalars, so
 *    equal values always produce equal bytes;
 *  - `stablePrefix` projects a request onto its cache-relevant parts (system
 *    prompt, tool declarations sorted by name, message history) and serializes
 *    them canonically, excluding every volatile field by construction;
 *  - `createPrefixCache` records the serialized prefix per session, reports the
 *    longest-common-prefix hit length and a reproducible hit-rate metric keyed
 *    by model. Metrics are a pure function of the recorded request sequence:
 *    replaying the same sequence yields the same numbers.
 *
 * Pure computation only: no I/O, no clock, no randomness.
 */
import { createHash } from "node:crypto";

/** A chat message as seen by the cache: role plus already-flattened text. */
export interface StableMessage {
  role: string;
  content: string;
}

/** A tool declaration; `parameters` is an opaque JSON schema value. */
export interface StableTool {
  name: string;
  description?: string;
  parameters?: unknown;
}

/** The cache-relevant projection of one model request. */
export interface StableRequest {
  system?: string;
  tools?: readonly StableTool[];
  messages: readonly StableMessage[];
}

/** Deterministic JSON: object keys sorted, arrays ordered, stable scalars. */
export function canonicalJson(value: unknown): string {
  return serialize(value);
}

function serialize(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? (Object.is(value, -0) ? "0" : String(value)) : "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return `[${value.map((item) => serialize(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${serialize(item)}`);
  return `{${entries.join(",")}}`;
}

/**
 * The serialized stable prefix of a request. Tool declarations are sorted by
 * name (then by canonical form, so renamed duplicates stay deterministic), so
 * the same tool set always yields the same bytes regardless of declaration
 * order. Volatile fields (temperature, request ids, timestamps, metadata)
 * never enter the projection.
 */
export function stablePrefix(request: StableRequest): string {
  // Append-friendly framing: a fixed header (system + sorted tools) followed by
  // one newline-delimited message frame per turn. Extending the history only
  // appends frames, so earlier turns remain a literal byte prefix.
  const tools = [...(request.tools ?? [])].sort((left, right) => {
    if (left.name !== right.name) return left.name < right.name ? -1 : 1;
    const a = serialize(left);
    const b = serialize(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const header = serialize({
    v: 1,
    system: request.system ?? null,
    tools: tools.map((tool) => ({ name: tool.name, description: tool.description ?? null, parameters: tool.parameters ?? null })),
  });
  const frames = request.messages.map((message) => serialize({ role: message.role, content: message.content }));
  return frames.length === 0 ? `${header}\n` : `${header}\n${frames.join("\n")}\n`;
}

/** SHA-256 of the serialized prefix; the identity the cache tracks. */
export function prefixHashOf(request: StableRequest): string {
  return createHash("sha256").update(stablePrefix(request), "utf8").digest("hex");
}

/** Longest common prefix length of two strings, in UTF-16 code units. */
export function commonPrefixLength(left: string, right: string): number {
  const bound = Math.min(left.length, right.length);
  let index = 0;
  while (index < bound && left.charCodeAt(index) === right.charCodeAt(index)) index += 1;
  return index;
}

/** What the cache remembers about one session's last request. */
export interface PrefixSnapshot {
  prefixHash: string;
  length: number;
  sequence: number;
}

/** One measurement, taken when a request is recorded. */
export interface PrefixMeasurement {
  session: string;
  model: string;
  sequence: number;
  prefixHash: string;
  /** Serialized prefix length of this request. */
  totalChars: number;
  /** Length shared byte-for-byte with the session's previous request. */
  hitChars: number;
  /** `hitChars / totalChars`; 0 for a session's first request. */
  hitRate: number;
  /** True when the previous prefix survived whole (pure append or first turn). */
  stable: boolean;
}

/** Aggregated, reproducible hit-rate numbers for one model. */
export interface PrefixModelMetrics {
  model: string;
  requests: number;
  stableRequests: number;
  hitChars: number;
  totalChars: number;
  /** `hitChars / totalChars` over all recorded requests of the model. */
  hitRate: number;
}

export interface PrefixMetrics {
  models: readonly PrefixModelMetrics[];
  sessions: number;
}

export interface PrefixCacheOptions {
  /** How many sessions to track (FIFO eviction); default 64. */
  capacity?: number;
}

export interface PrefixCache {
  /** Record one request and measure it against the session's previous one. */
  record(session: string, model: string, request: StableRequest): PrefixMeasurement;
  /** The session's last snapshot, or null when the session is unknown. */
  last(session: string): PrefixSnapshot | null;
  /** Aggregated metrics, models sorted by name. */
  metrics(): PrefixMetrics;
  reset(): void;
}

interface SessionState {
  prefix: string;
  prefixHash: string;
  sequence: number;
}

interface ModelAggregate {
  requests: number;
  stableRequests: number;
  hitChars: number;
  totalChars: number;
}

/**
 * The stabilizer's measurement state. `record` is deterministic: recording the
 * same (session, model, request) sequence twice produces identical metrics.
 */
export function createPrefixCache(options: PrefixCacheOptions = {}): PrefixCache {
  const capacity = Math.max(1, options.capacity ?? 64);
  const sessions = new Map<string, SessionState>();
  const models = new Map<string, ModelAggregate>();

  const track = (session: string): void => {
    if (sessions.has(session)) {
      const state = sessions.get(session) as SessionState;
      sessions.delete(session);
      sessions.set(session, state);
      return;
    }
    sessions.set(session, { prefix: "", prefixHash: "", sequence: 0 });
    while (sessions.size > capacity) {
      const oldest = sessions.keys().next().value;
      if (oldest === undefined) break;
      sessions.delete(oldest);
    }
  };

  return {
    record(session, model, request) {
      track(session);
      const state = sessions.get(session) as SessionState;
      const prefix = stablePrefix(request);
      const prefixHash = createHash("sha256").update(prefix, "utf8").digest("hex");
      const hitChars = state.sequence === 0 ? 0 : commonPrefixLength(state.prefix, prefix);
      const stable = state.sequence === 0 || hitChars === state.prefix.length;
      state.prefix = prefix;
      state.prefixHash = prefixHash;
      state.sequence += 1;
      const aggregate = models.get(model) ?? { requests: 0, stableRequests: 0, hitChars: 0, totalChars: 0 };
      aggregate.requests += 1;
      if (stable) aggregate.stableRequests += 1;
      aggregate.hitChars += hitChars;
      aggregate.totalChars += prefix.length;
      models.set(model, aggregate);
      return {
        session,
        model,
        sequence: state.sequence,
        prefixHash,
        totalChars: prefix.length,
        hitChars,
        hitRate: prefix.length === 0 ? 0 : hitChars / prefix.length,
        stable,
      };
    },
    last(session) {
      const state = sessions.get(session);
      return state && state.sequence > 0 ? { prefixHash: state.prefixHash, length: state.prefix.length, sequence: state.sequence } : null;
    },
    metrics() {
      return {
        sessions: sessions.size,
        models: [...models.entries()]
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
          .map(([model, aggregate]) => ({
            model,
            requests: aggregate.requests,
            stableRequests: aggregate.stableRequests,
            hitChars: aggregate.hitChars,
            totalChars: aggregate.totalChars,
            hitRate: aggregate.totalChars === 0 ? 0 : aggregate.hitChars / aggregate.totalChars,
          })),
      };
    },
    reset() {
      sessions.clear();
      models.clear();
    },
  };
}
