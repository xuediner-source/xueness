/** Transient hot-memory retention for session runtime events; durable audit facts live in the ledger. */
import type { SessionRuntimeEvent, SessionRuntimeEventType } from "./runtime-events.ts";

export const RUNTIME_TRANSIENT_EVENT_TYPES = ["AssistantDelta", "ReasoningDelta"] as const;
export const RUNTIME_SEALED_TURN_GRACE_MS = 120_000;
export const RUNTIME_TURN_WINDOW = 4;
export const RUNTIME_HOT_EVENT_LIMIT = 512;
/** ModelRequest residency keeps only routing/diagnostic metadata; usage and response bulk stay ledger-only. */
const MODEL_REQUEST_RESIDENT_KEYS = ["phase", "requestId", "attemptId", "selectionId", "modelId", "providerKind", "reason", "errorCode", "failurePhase", "attempt", "maxAttempts", "statusCode"] as const;

export interface RuntimeRetentionPolicy { turnWindow: number; sealedTurnGraceMs: number; maxEvents: number }
export function defaultRuntimeRetentionPolicy(overrides: Partial<RuntimeRetentionPolicy> = {}): RuntimeRetentionPolicy {
  const policy = { turnWindow: RUNTIME_TURN_WINDOW, sealedTurnGraceMs: RUNTIME_SEALED_TURN_GRACE_MS, maxEvents: RUNTIME_HOT_EVENT_LIMIT, ...overrides };
  if (!Number.isSafeInteger(policy.turnWindow) || policy.turnWindow < 1 || !Number.isSafeInteger(policy.sealedTurnGraceMs) || policy.sealedTurnGraceMs < 0
    || !Number.isSafeInteger(policy.maxEvents) || policy.maxEvents < 1) throw new TypeError("invalid runtime retention policy");
  return policy;
}

export function isTransientRuntimeEventType(type: SessionRuntimeEventType): boolean {
  return (RUNTIME_TRANSIENT_EVENT_TYPES as readonly string[]).includes(type);
}

/** Slim an event for hot residence; non-ModelRequest events return unchanged. */
export function slimResidentRuntimeEvent(event: SessionRuntimeEvent): SessionRuntimeEvent {
  if (event.type !== "ModelRequest") return event;
  const payload: Record<string, unknown> = {};
  for (const key of MODEL_REQUEST_RESIDENT_KEYS) if (event.payload[key] !== undefined) payload[key] = event.payload[key];
  return Object.keys(payload).length === Object.keys(event.payload).length ? event : { ...event, payload };
}

interface HotTurn { turnId: string; lastSeen: number; events: SessionRuntimeEvent[] }

/**
 * In-memory turn-window over the live tail. Retention here never mutates the durable
 * ledger: sealed turns lose transient deltas after the grace period and whole turns are
 * evicted by successor turns or the hard event cap.
 */
export class RuntimeEventHotWindow {
  readonly policy: RuntimeRetentionPolicy;
  readonly now: () => number;
  #turns: HotTurn[] = [];
  #evicted = 0;
  #slimmed = 0;
  constructor(policy: Partial<RuntimeRetentionPolicy> = {}, now: () => number = Date.now) {
    this.policy = defaultRuntimeRetentionPolicy(policy);
    this.now = now;
  }
  admit(event: SessionRuntimeEvent): void {
    const resident = slimResidentRuntimeEvent(event);
    if (resident !== event) this.#slimmed++;
    const turnId = event.turnId ?? "";
    let bucket = this.#turns.find((turn) => turn.turnId === turnId);
    if (bucket) this.#turns.splice(this.#turns.indexOf(bucket), 1);
    else bucket = { turnId, lastSeen: 0, events: [] };
    bucket.lastSeen = this.now();
    bucket.events.push(resident);
    this.#turns.push(bucket);
    this.#evict();
  }
  #evict(): void {
    const now = this.now();
    while (this.#turns.length > this.policy.turnWindow) { const dropped = this.#turns.shift()!; this.#evicted += dropped.events.length; }
    for (let i = 0; i < this.#turns.length - 1; i++) {
      const turn = this.#turns[i]!;
      const durable = turn.events.filter((event) => !isTransientRuntimeEventType(event.type));
      if (durable.length !== turn.events.length && turn.lastSeen + this.policy.sealedTurnGraceMs <= now) { this.#evicted += turn.events.length - durable.length; turn.events = durable; }
    }
    let total = this.#turns.reduce((count, turn) => count + turn.events.length, 0);
    while (total > this.policy.maxEvents && this.#turns.length) {
      const oldest = this.#turns[0]!;
      const drop = Math.min(oldest.events.length, total - this.policy.maxEvents);
      oldest.events.splice(0, drop); total -= drop; this.#evicted += drop;
      if (!oldest.events.length) this.#turns.shift();
    }
  }
  /** Minimum still-resident sequence number; Infinity when the window is empty. */
  get floor(): number { return Math.min(...this.#turns.flatMap((turn) => turn.events.map((event) => event.sequenceNumber))); }
  covers(after: number): boolean { return this.#turns.length > 0 && after + 1 >= this.floor; }
  /** Resident tail after a cursor, or null when eviction has opened a gap at the cursor. */
  tail(after: number, limit: number): SessionRuntimeEvent[] | null {
    if (!this.covers(after)) return null;
    return this.#turns.flatMap((turn) => turn.events).filter((event) => event.sequenceNumber > after)
      .sort((a, b) => a.sequenceNumber - b.sequenceNumber).slice(0, limit);
  }
  stats(): { events: number; turns: number; evicted: number; slimmed: number } {
    return { events: this.#turns.reduce((count, turn) => count + turn.events.length, 0), turns: this.#turns.length, evicted: this.#evicted, slimmed: this.#slimmed };
  }
}
