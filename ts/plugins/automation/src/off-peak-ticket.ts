/**
 * The live off-peak ticket lifecycle (F13.02): a claimed task runs under one
 * active ticket at a time, and every model request the sub-execution makes
 * presents that ticket at the request boundary.
 *
 * Upstream semantics (`docs/off-peak-task/spec.md`, D26): unattended runs
 * segment by a 3h active ticket; a ticket that expires while the run has
 * delivered NO output can be re-signed with the same task and the run
 * retried before any output; a run that already delivered output is never
 * replayed — its outcome settles; and a user takeover at the request
 * boundary invalidates the ticket, releasing the sub-execution's ownership
 * so interactive turns go back to the ordinary session model.
 *
 * Ticket facts live on the task row under `ticket`, so the queue's own file
 * and lock are the single source of truth. Everything here is a pure state
 * machine over rows; only `ticketRequestAuthPort` closes over a row accessor.
 */
import { isDict, pyTruthy, PyValueError, uuid4Hex } from "@xueness/contracts";
import { pick, type Row } from "./off-peak.ts";

/** The header every off-peak model request carries; absent or invalid tickets refuse the request. */
export const TICKET_HEADER = "X-Off-Peak-Ticket-ID";
/** Upstream D26: unattended execution segments by a 3h active ticket. */
export const ACTIVE_TICKET_SECONDS = 3 * 60 * 60;

export type TicketState = "active" | "expired" | "settled" | "taken_over";
export const TICKET_STATES: ReadonlySet<string> = new Set(["active", "expired", "settled", "taken_over"]);

/** One ticket's facts as stored on the task row (`row.ticket`). */
export interface TicketFacts {
  id: string;
  state: TicketState;
  /** This ticket's issuance; `startedAt` anchors the overall deadline across re-signs. */
  takenAt: number;
  expiresAt: number;
  startedAt: number;
  renewals: number;
  /** Re-signs after an expiry in the same episode (same task, new ticket). */
  resumes: number;
  /** First delivered output; once set the run is never replayed. */
  outputAt: number | null;
}

const numberOr = (value: unknown, fallback: number): number => (typeof value === "number" && Number.isFinite(value) ? value : fallback);

/** The row's ticket, or `null` when absent or not a valid ticket record. */
export function ticketOf(row: Row): TicketFacts | null {
  const stored = pick(row, "ticket");
  if (!isDict(stored)) return null;
  const id = pick(stored, "id");
  const state = pick(stored, "state");
  if (typeof id !== "string" || !id || typeof state !== "string" || !TICKET_STATES.has(state)) return null;
  return {
    id, state: state as TicketState,
    takenAt: numberOr(pick(stored, "takenAt"), 0),
    expiresAt: numberOr(pick(stored, "expiresAt"), 0),
    startedAt: numberOr(pick(stored, "startedAt"), numberOr(pick(stored, "takenAt"), 0)),
    renewals: numberOr(pick(stored, "renewals"), 0),
    resumes: numberOr(pick(stored, "resumes"), 0),
    outputAt: typeof pick(stored, "outputAt") === "number" ? (pick(stored, "outputAt") as number) : null,
  };
}

function writeTicket(row: Row, facts: TicketFacts): TicketFacts {
  row.ticket = { ...facts };
  return facts;
}

/**
 * `POST /ticket` semantics, localized: issue (or keep) the task's ticket.
 * An unexpired active ticket is idempotent — re-taking the same task does
 * not mint a second one. A ticket may never be taken for a run that already
 * delivered output: its outcome stands and is never replayed.
 */
export function takeTicket(row: Row, now: number, activeSeconds: number): TicketFacts {
  if (!(activeSeconds > 0)) throw new PyValueError("ticket segment length must be positive");
  const prior = ticketOf(row);
  if (prior !== null && prior.outputAt !== null) {
    throw new PyValueError("已输出的闲时任务不能重新取号");
  }
  if (prior !== null && prior.state === "active") {
    if (now < prior.expiresAt) return prior;
    // The newest ticket expired: taking a number again mints a new ticket and
    // counts as one more resume of the same episode.
    return writeTicket(row, {
      id: uuid4Hex(), state: "active", takenAt: now, expiresAt: now + activeSeconds,
      startedAt: prior.startedAt, renewals: 0, resumes: prior.resumes + 1, outputAt: null,
    });
  }
  // `settled` and `taken_over` end their episode; the next take starts fresh.
  return writeTicket(row, {
    id: uuid4Hex(), state: "active", takenAt: now, expiresAt: now + activeSeconds,
    startedAt: now, renewals: 0, resumes: 0, outputAt: null,
  });
}

/** 票据续期: extend the active ticket by one segment; only an active ticket renews. */
export function renewTicketState(row: Row, now: number, activeSeconds: number): TicketFacts {
  if (!(activeSeconds > 0)) throw new PyValueError("ticket segment length must be positive");
  const prior = ticketOf(row);
  if (prior === null || prior.state !== "active") throw new PyValueError("只有活跃票据可以续期");
  // Renewal extends a live segment only. A lapsed ticket must follow the expiry
  // path instead — re-sign when no output was delivered, settle otherwise — so a
  // stale ticket can never be revived into a request the boundary would refuse.
  if (now >= prior.expiresAt) throw new PyValueError("票据已过期，不能续期，需要重新取号");
  return writeTicket(row, { ...prior, expiresAt: now + activeSeconds, renewals: prior.renewals + 1 });
}

/** Records the first delivered output; the no-replay guard from then on. */
export function markTicketOutput(row: Row, now: number): TicketFacts | null {
  const prior = ticketOf(row);
  if (prior === null) return null;
  if (prior.outputAt !== null) return prior;
  return writeTicket(row, { ...prior, outputAt: now });
}

/** Natural completion: the ticket settles with the run. */
export function settleTicketState(row: Row): TicketFacts | null {
  const prior = ticketOf(row);
  if (prior === null || prior.state !== "active") return prior ?? null;
  return writeTicket(row, { ...prior, state: "settled" });
}

/** The expiry classification the reconciler branches on. */
export type TicketExpiry = "absent" | "active" | "resignable" | "settled";

/**
 * Whether the task's ticket has expired, and what that allows:
 * `resignable` only when no output was ever delivered — 无输出过期可续签;
 * with output the run settles instead — 已输出不重播.
 */
export function ticketExpiry(row: Row, now: number): TicketExpiry {
  const ticket = ticketOf(row);
  if (ticket === null) return "absent";
  if (ticket.state !== "active" || now < ticket.expiresAt) return "active";
  return ticket.outputAt === null ? "resignable" : "settled";
}

/**
 * Re-sign an expired ticket for the same task: a new active ticket whose
 * `startedAt` keeps the episode's overall deadline anchor. Only an expired,
 * never-output ticket may re-sign.
 */
export function resignTicketState(row: Row, now: number, activeSeconds: number): TicketFacts {
  if (ticketExpiry(row, now) !== "resignable") throw new PyValueError("只有无输出过期的票据可以重新取号");
  const prior = ticketOf(row)!;
  return writeTicket(row, {
    id: uuid4Hex(), state: "active", takenAt: now, expiresAt: now + activeSeconds,
    startedAt: prior.startedAt, renewals: 0, resumes: prior.resumes + 1, outputAt: null,
  });
}

/** 用户接管: the active ticket is invalidated; the sub-execution may not request again. */
export function takeoverTicketState(row: Row): TicketFacts | null {
  const prior = ticketOf(row);
  if (prior === null || prior.state !== "active") return prior ?? null;
  return writeTicket(row, { ...prior, state: "taken_over" });
}

/**
 * The request boundary: the header binding an off-peak model request must
 * present. An absent, expired, settled or taken-over ticket refuses the
 * request before any network I/O (upstream `400/3102`).
 */
export function ticketRequestAuth(row: Row, now: number): { headers: Record<string, string> } {
  const ticket = ticketOf(row);
  if (ticket === null) throw new PyValueError("闲时任务没有有效票据");
  if (ticket.state === "taken_over") throw new PyValueError("闲时执行已被用户接管");
  if (ticket.state === "settled") throw new PyValueError("闲时票据已结算");
  if (ticket.state === "expired" || now >= ticket.expiresAt) throw new PyValueError("闲时票据已过期，需要重新取号");
  return { headers: { [TICKET_HEADER]: ticket.id } };
}

/**
 * The ticket as a request-auth port (structural): `resolve` re-reads the task
 * row at request time, so a takeover or expiry between two requests takes
 * effect at the very next request boundary. Composable with a credentials
 * port by the host — the ticket never carries credentials itself.
 */
export function ticketRequestAuthPort(read: () => Row, clock: () => number): {
  id: string;
  resolve(): { headers: Record<string, string> };
} {
  return {
    id: "off-peak-ticket",
    resolve: () => ticketRequestAuth(read(), clock()),
  };
}

/** Whether a task row ever delivered output — used by queue-facing observers. */
export function ticketDeliveredOutput(row: Row): boolean {
  const ticket = ticketOf(row);
  return ticket !== null && ticket.outputAt !== null && pyTruthy(ticket.outputAt);
}
