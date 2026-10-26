import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { OffPeakQueue } from "../src/off-peak-queue.ts";
import { resolveOutputDelivered } from "../src/off-peak-output.ts";
import {
  ACTIVE_TICKET_SECONDS, TICKET_HEADER, renewTicketState, resignTicketState, takeTicket, ticketExpiry, ticketRequestAuth,
  takeoverTicketState, type TicketFacts,
} from "../src/off-peak-ticket.ts";
import type { Row } from "../src/off-peak.ts";

describe("off-peak ticket state machine (F13.02)", () => {
  it("issues an active ticket and presents it at the request boundary", () => {
    const row: Row = { id: "t1", status: "running" };
    const now = 1_700_000_000_000;
    const ticket = takeTicket(row, now, ACTIVE_TICKET_SECONDS);
    assert.equal(ticket.state, "active");
    assert.equal(ticketExpiry(row, now), "active");
    const auth = ticketRequestAuth(row, now);
    assert.ok(auth.headers[TICKET_HEADER]);
    assert.equal(auth.headers[TICKET_HEADER], ticket.id);
  });

  it("takeover invalidates the ticket so interactive turns leave the off-peak path", () => {
    const row: Row = { id: "t2", status: "running" };
    takeTicket(row, 1000, ACTIVE_TICKET_SECONDS);
    const taken = takeoverTicketState(row);
    assert.equal(taken!.state, "taken_over");
    // taken_over tickets are no longer resignable; request auth must refuse.
    assert.notEqual(ticketExpiry(row, 1001), "resignable");
    assert.throws(() => ticketRequestAuth(row, 1001));
  });
});

describe("resolveOutputDelivered", () => {
  it("prefers the host signal, then bridge nodes, else null", () => {
    assert.equal(resolveOutputDelivered("w", () => true, null), true);
    assert.equal(resolveOutputDelivered("w", () => { throw new Error("x"); }, null), null);
    assert.equal(resolveOutputDelivered("w", null, null), null);
    const bridge = { load: () => ({ nodes: { a: { status: "running", session_id: "s" } } }) };
    assert.equal(resolveOutputDelivered("w", null, bridge), true);
    assert.equal(resolveOutputDelivered("w", null, { load: () => ({ nodes: { a: { status: "pending" } } }) }), false);
  });
});

describe("OffPeakQueue persistence smoke (F13.01-02)", () => {
  it("constructs against an empty state dir without throwing", () => {
    const base = mkdtempSync(join(tmpdir(), "xue-offpeak-"));
    try {
      const queue = new OffPeakQueue(base, { clock: () => 0 });
      assert.ok(queue);
      assert.deepEqual(queue.list?.() ?? [], []);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
});

describe("ticket expiry edges (F13.02 review)", () => {
  it("a lapsed ticket renews only through the expiry path, never in place", () => {
    const row: Row = { id: "t3", status: "running" };
    const now = 5_000;
    takeTicket(row, now, ACTIVE_TICKET_SECONDS);
    const lapsed = now + ACTIVE_TICKET_SECONDS;
    // Reviving a lapsed ticket would leave the request boundary refusing it.
    assert.throws(() => renewTicketState(row, lapsed, ACTIVE_TICKET_SECONDS));
    assert.equal(ticketExpiry(row, lapsed), "resignable");
    assert.throws(() => ticketRequestAuth(row, lapsed));
  });
});
