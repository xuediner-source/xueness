/** Canonical command replay over durable receipts (F11.04).
 * A timeout never resubmits blindly: the same commandId is resent only after a
 * receipt probe, so the server's durable claim returns the one committed result.
 * "failed" is a settled receipt status; an unsettled claim stays "unknown". */
import { isDict } from "@xueness/contracts";

export type Row = Record<string, unknown>;
export const RECEIPT_STATUSES = Object.freeze(["accepted", "rejected", "stale", "noop", "failed", "duplicate"]);
const SETTLED = new Set<string>(RECEIPT_STATUSES);
export const DEFAULT_REPLAY_DEADLINE_SECONDS = 30;
const POLL_BUDGET_MS = 1000;

export interface ReplayCommand {
  commandId: string;
  execute(): Promise<unknown>;
  query(): Promise<unknown>;
  deadlineSeconds?: number;
  pollMs?: number;
  nowMs?(): number;
  sleep?(ms: number): Promise<void>;
}

export type CommittedReplay = { disposition: "committed"; commandId: string; ack: Row; sends: number; queries: number };
export type UnknownReplay = { disposition: "unknown"; commandId: string; sends: number; queries: number; reason: string };
export type ReplayOutcome = CommittedReplay | UnknownReplay;

/** A settled acknowledgement, wherever the receipt envelope keeps it. */
export function settledReceipt(value: unknown): Row | null {
  const row = isDict(value) ? value : null;
  if (row && typeof row.status === "string" && SETTLED.has(row.status)) return row;
  const inner = row && isDict(row.result) ? row.result : null;
  return inner && typeof inner.status === "string" && SETTLED.has(inner.status) ? inner : null;
}

/** Transport loss and unknown-outcome refusals are replayable; protocol refusals are final. */
export function outcomeUnknown(error: unknown): boolean {
  if (!(error instanceof Error)) return true;
  if (error.name === "TransportError") return true;
  const payload = (error as { error?: unknown }).error;
  const data = isDict(payload) && isDict(payload.data) ? payload.data : null;
  if (data != null && typeof data.reasonCode === "string") return data.reasonCode === "command_unknown";
  return /outcome (?:may be |is )?unknown|command_unknown|timed out/u.test(error.message);
}

const sleepDefault = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Send, probe the receipt, then resend the same commandId until the deadline. */
export async function replayCommand(command: ReplayCommand): Promise<ReplayOutcome> {
  const now = command.nowMs ?? Date.now;
  const sleep = command.sleep ?? sleepDefault;
  const pollMs = command.pollMs ?? 200;
  const deadlineAt = now() + (command.deadlineSeconds ?? DEFAULT_REPLAY_DEADLINE_SECONDS) * 1000;
  let sends = 0, queries = 0;
  for (;;) {
    sends += 1;
    let reply: unknown = null;
    try { reply = await command.execute(); } catch (error) { if (!outcomeUnknown(error)) throw error; }
    const settled = settledReceipt(reply);
    if (settled) return { disposition: "committed", commandId: command.commandId, ack: settled, sends, queries };
    // A receipt-shaped reply that is not settled is still in flight: reporting it
    // as committed would publish an uncommitted acknowledgement as durable state.
    if (isDict(reply) && !("result" in reply) && !("status" in reply) && !("commandId" in reply)) {
      return { disposition: "committed", commandId: command.commandId, ack: reply, sends, queries };
    }
    const budgetEnd = Math.min(now() + POLL_BUDGET_MS, deadlineAt);
    while (now() < budgetEnd) {
      queries += 1;
      let receipt: unknown = null;
      try { receipt = await command.query(); } catch (error) { if (!outcomeUnknown(error)) throw error; }
      const probed = settledReceipt(receipt);
      if (probed) return { disposition: "committed", commandId: command.commandId, ack: probed, sends, queries };
      await sleep(pollMs);
    }
    if (now() >= deadlineAt) return { disposition: "unknown", commandId: command.commandId, sends, queries, reason: "command outcome remained unsettled before the deadline" };
    // The durable claim makes the resend safe: an unsettled claim never re-executes.
  }
}
