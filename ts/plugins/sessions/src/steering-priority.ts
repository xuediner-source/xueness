/**
 * Priority scheduling for current-turn guidance admission (C-WFL-02).
 * Reuses the agent command-priority table (C-WFL-01): a live send-now
 * takeover outranks plain guides; equal priorities keep durable FIFO order,
 * so the common single-guide path is byte-identical to plain queue order.
 */
import { commandPriority, type TurnCommandKind } from "@xueness/agent";
import { isDict } from "@xueness/contracts";
import type { Row } from "./queue-types.ts";

/** A reserved/claimed send-now promotion targeting this turn is a takeover. */
export function guidanceCommandKind(item: Row): TurnCommandKind {
  const promotion = isDict(item.promotion) ? item.promotion : null;
  return promotion && ["reserved", "claimed"].includes(String(promotion.state)) ? "start_now" : "steer_guide";
}
/**
 * Boundary admission order for eligible same-turn guidance: takeover first,
 * then submission order. Stable, so plain FIFO inputs are never reordered
 * and idempotent replays keep their receipt position.
 */
export function boundaryAdmissionOrder(items: readonly Row[]): Row[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => commandPriority(guidanceCommandKind(a.item)) - commandPriority(guidanceCommandKind(b.item)) || a.index - b.index)
    .map((entry) => entry.item);
}
/**
 * Inputs stay preserved (queued) while the run is inside a compaction or
 * waiting-tool window of the turn they target; anything aimed at another
 * turn is no longer admissible and settles as paused by the normal path.
 */
export function preservedInWaitWindow(item: Row, activeTurnId: string | null): boolean {
  return typeof activeTurnId === "string" && item.target_turn_id === activeTurnId;
}
/** Receipt-facing priority class for pending snapshots: takeover or plain guide. */
export const guidancePriority = (item: Row): string => (guidanceCommandKind(item) === "start_now" ? "takeover" : "guide");
/**
 * Live wait-window probe for the active turn: a compaction still in flight
 * (compact_timeline row started/retrying) or a run waiting on the user
 * (pending question / awaiting_user) keeps same-turn inputs preserved and
 * trackable instead of settled; model boundaries do not occur mid-window.
 */
export function guidanceWaitWindow(session: Row): { turnId: string; compacting: boolean; waiting: boolean } | null {
  if (session.status !== "running" || typeof session.active_turn_id !== "string" || !session.active_turn_id) return null;
  const timeline = Array.isArray(session.compact_timeline) ? session.compact_timeline.filter(isDict) : [];
  const last = timeline.at(-1) ?? null;
  return { turnId: session.active_turn_id, compacting: last !== null && ["started", "retrying"].includes(String(last.status)), waiting: !!session.pending_question || false };
}
