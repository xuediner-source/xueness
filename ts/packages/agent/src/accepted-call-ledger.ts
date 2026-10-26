/**
 * Accepted stream tool-call settlement ledger (ZCode `turn-model-step.ts`,
 * `turn-execution-fallback.ts`): tool calls a model stream already accepted
 * (`stream.committed` / accepted `tool_calls`) are tracked so that a model
 * interruption, an execution-selection switch, a cancellation or a cold resume
 * settles each one exactly once — never silently dropped, never executed or
 * journaled twice — while unaccepted partial `tool_use` prelude fragments are
 * discarded and never reach `runTools`.
 */
import type { Row } from "./types.ts";

export type AcceptedCallStatus = "accepted" | "settled_executed" | "settled_interrupted" | "discarded_prelude";
/** What triggered the settlement boundary. */
export type SettlementCause = "model_interrupt" | "execution_fallback" | "cancelled" | "resumed" | "completed";

export interface AcceptedCallRecord {
  callId: string;
  name: string;
  streamId: string;
  turnId: string;
  status: AcceptedCallStatus;
  recordedAt: string;
  settledAt?: string;
  cause?: SettlementCause;
}

export interface AcceptedCallLike { id?: unknown; name?: unknown }
export interface DiscardedFragment { id?: string; name?: string }

export const ACCEPTED_CALL_PROJECTION_KEY = "accepted_tool_calls";
export const ACCEPTED_CALL_HISTORY_LIMIT = 100;

const stamp = (): string => new Date().toISOString().replace(/Z$/, "+00:00");
const asName = (call: AcceptedCallLike): string => typeof call.name === "string" ? call.name : "";

/**
 * Exactly-once settlement bookkeeping. `accept` is idempotent by callId, and a
 * settled record never settles again — the second settlement is rejected, which
 * is how interrupt/switch/cancel/resume paths stay non-duplicating.
 */
export class AcceptedCallLedger {
  readonly #records = new Map<string, AcceptedCallRecord>();
  accept(streamId: string, turnId: string, calls: readonly AcceptedCallLike[], now = stamp()): AcceptedCallRecord[] {
    const recorded: AcceptedCallRecord[] = [];
    for (const call of calls) {
      if (typeof call.id !== "string" || !call.id) continue;
      const existing = this.#records.get(call.id);
      if (existing) { recorded.push(existing); continue; }
      const record: AcceptedCallRecord = { callId: call.id, name: asName(call), streamId, turnId, status: "accepted", recordedAt: now };
      this.#records.set(call.id, record);
      recorded.push(record);
    }
    return recorded;
  }
  /**
   * Unaccepted prelude fragments: discarded, never executed, still accounted
   * for. Returns how many fragments this call newly discarded — a replay of the
   * same boundary discards nothing and reports 0, matching `settle`/
   * `settleAll`, so a replayed interrupt/switch/cancel never inflates the
   * settlement it reports.
   */
  discardPrelude(streamId: string, turnId: string, fragments: readonly DiscardedFragment[], cause: SettlementCause = "model_interrupt", now = stamp()): number {
    let discarded = 0;
    for (const [index, fragment] of fragments.entries()) {
      const callId = typeof fragment.id === "string" && fragment.id ? fragment.id : `prelude:${streamId}:${index}`;
      if (this.#records.has(callId)) continue;
      this.#records.set(callId, { callId, name: fragment.name ?? "", streamId, turnId, status: "discarded_prelude", recordedAt: now, settledAt: now, cause });
      discarded += 1;
    }
    return discarded;
  }
  /** Returns true only the first time an accepted call settles; re-settlement never rewrites history. */
  settle(callId: string, status: "settled_executed" | "settled_interrupted", cause: SettlementCause, now = stamp()): boolean {
    const record = this.#records.get(callId);
    if (!record || record.status !== "accepted") return false;
    record.status = status;
    record.settledAt = now;
    record.cause = cause;
    return true;
  }
  settleAll(streamId: string, status: "settled_executed" | "settled_interrupted", cause: SettlementCause, now = stamp()): number {
    let settled = 0;
    for (const record of this.#records.values()) if (record.streamId === streamId && record.status === "accepted" && this.settle(record.callId, status, cause, now)) settled += 1;
    return settled;
  }
  recordOf(callId: string): AcceptedCallRecord | undefined { return this.#records.get(callId); }
  byStream(streamId: string): AcceptedCallRecord[] { return [...this.#records.values()].filter((record) => record.streamId === streamId); }
  acceptedPending(): AcceptedCallRecord[] { return [...this.#records.values()].filter((record) => record.status === "accepted"); }
  records(): AcceptedCallRecord[] { return [...this.#records.values()]; }

  /** Durable, bounded, idempotent projection on the session (merged by callId, never duplicated). */
  project(session: Row): AcceptedCallRecord[] {
    const history = Array.isArray(session[ACCEPTED_CALL_PROJECTION_KEY]) ? session[ACCEPTED_CALL_PROJECTION_KEY] as Row[] : [];
    const byId = new Map(history.map((row) => [String(row.callId), row]));
    for (const record of this.#records.values()) {
      const existing = byId.get(record.callId);
      if (existing) {
        // Settlement may advance; an existing terminal status is immutable.
        if (existing.status === "accepted" && record.status !== "accepted") byId.set(record.callId, { ...existing, ...record });
        continue;
      }
      byId.set(record.callId, { ...record } as unknown as Row);
    }
    const merged = [...byId.values()];
    session[ACCEPTED_CALL_PROJECTION_KEY] = merged.slice(-ACCEPTED_CALL_HISTORY_LIMIT) as unknown as Row[];
    return merged.slice(-ACCEPTED_CALL_HISTORY_LIMIT).map((row) => row as unknown as AcceptedCallRecord);
  }
}

/** Cold-resume view of the durable projection. */
export function loadAcceptedCallProjection(session: Row): AcceptedCallRecord[] {
  const history = Array.isArray(session[ACCEPTED_CALL_PROJECTION_KEY]) ? session[ACCEPTED_CALL_PROJECTION_KEY] as Row[] : [];
  return history.filter((row) => typeof row.callId === "string").map((row) => row as unknown as AcceptedCallRecord);
}

export interface StreamSettlementInput {
  streamId: string | null;
  turnId: string;
  /** `stream.committed`: prelude fragments were already accepted into the response. */
  committed: boolean;
  acceptedCalls: readonly AcceptedCallLike[];
  preludeFragments: readonly DiscardedFragment[];
  cause: SettlementCause;
  ledger: AcceptedCallLedger;
  /** Present when the settlement should land durably (merged into `accepted_tool_calls`). */
  session?: Row;
}
export interface StreamCallSettlement { accepted: number; executed: number; interrupted: number; discarded: number }

/**
 * Classifies one dying stream's calls at an interrupt/switch/cancel boundary:
 * accepted calls settle exactly once (interrupted unless the caller already
 * settled them executed), unaccepted prelude fragments are discarded and never
 * executed. Idempotent — replaying the same boundary changes nothing.
 */
export function settleStreamToolCalls(input: StreamSettlementInput, now = stamp()): StreamCallSettlement {
  const settlement: StreamCallSettlement = { accepted: 0, executed: 0, interrupted: 0, discarded: 0 };
  if (!input.streamId) return settlement;
  const accepted = input.committed
    ? input.ledger.accept(input.streamId, input.turnId, input.acceptedCalls, now)
    : [];
  settlement.accepted = accepted.length;
  settlement.interrupted = input.ledger.settleAll(input.streamId, "settled_interrupted", input.cause, now);
  settlement.executed = accepted.filter((record) => record.status === "settled_executed").length;
  settlement.discarded = input.ledger.discardPrelude(input.streamId, input.turnId, input.committed ? [] : input.preludeFragments, input.cause, now);
  if (input.session) input.ledger.project(input.session);
  return settlement;
}
