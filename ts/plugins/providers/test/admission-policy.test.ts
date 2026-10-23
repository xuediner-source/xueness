import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ProviderCancelled } from "@xueness/providers";
import { ProviderAdmissionController, providerAdmissionForState } from "../src/admission-policy.ts";

const alpha = { providerId: "anthropic", modelId: "claude-sonnet" };
const beta = { providerId: "openai", modelId: "gpt-4o" };

describe("provider admission policy", () => {
  it("grants FIFO within a model bucket while independent keys progress separately", async () => {
    const admission = new ProviderAdmissionController(1);
    const held = await admission.acquire({ model: alpha });
    const order: number[] = [];
    const first = admission.acquire({ model: alpha }).then((ticket) => { order.push(1); return ticket; });
    const second = admission.acquire({ model: alpha }).then((ticket) => { order.push(2); return ticket; });
    const other = admission.tryAcquire({ model: beta });

    assert.ok(other);
    assert.equal(admission.tryAcquire({ model: alpha }), undefined);
    assert.deepEqual(admission.snapshot(), { limit: 1, active: 2, queued: 2, buckets: 2 });
    held.release();
    const firstTicket = await first;
    assert.deepEqual(order, [1]);
    assert.deepEqual(admission.snapshot(), { limit: 1, active: 2, queued: 1, buckets: 2 });
    firstTicket.release();
    const secondTicket = await second;
    assert.deepEqual(order, [1, 2]);
    secondTicket.release();
    other.release();
    assert.deepEqual(admission.snapshot(), { limit: 1, active: 0, queued: 0, buckets: 0 });
  });

  it("removes cancelled waiters and makes release-versus-abort races settle once", async () => {
    const admission = new ProviderAdmissionController(1);
    const held = await admission.acquire({ model: alpha });
    const cancelled = new AbortController();
    const cancelledWaiter = admission.acquire({ model: alpha, signal: cancelled.signal }).then(
      (ticket) => ({ ticket }),
      (error: unknown) => ({ error }),
    );
    const next = admission.acquire({ model: alpha });
    cancelled.abort();
    held.release();
    const result = await cancelledWaiter;
    assert.ok("error" in result && result.error instanceof ProviderCancelled);
    const nextTicket = await next;
    assert.deepEqual(admission.snapshot(), { limit: 1, active: 1, queued: 0, buckets: 1 });
    nextTicket.release();

    const secondHeld = await admission.acquire({ model: beta });
    const releaseWins = new AbortController();
    const racingAcquire = admission.acquire({ model: beta, signal: releaseWins.signal });
    secondHeld.release();
    releaseWins.abort();
    const racingTicket = await racingAcquire;
    racingTicket.release();
    assert.deepEqual(admission.snapshot(), { limit: 1, active: 0, queued: 0, buckets: 0 });
  });

  it("releases tickets idempotently and removes idle buckets", async () => {
    const admission = new ProviderAdmissionController(2);
    const ticket = admission.tryAcquire({ model: alpha });
    assert.ok(ticket);
    assert.deepEqual(admission.snapshot(), { limit: 2, active: 1, queued: 0, buckets: 1 });
    ticket.release();
    ticket.release();
    assert.deepEqual(admission.snapshot(), { limit: 2, active: 0, queued: 0, buckets: 0 });
  });

  it("shares the first per-state limit, isolates other states, honors zero, and restores the environment", () => {
    const previous = process.env.XUENESS_MODEL_MAX_CONCURRENT;
    try {
      const state = join(tmpdir(), `xueness-admission-${randomUUID()}`);
      process.env.XUENESS_MODEL_MAX_CONCURRENT = "2";
      const shared = providerAdmissionForState(state);
      assert.ok(shared);
      assert.equal(shared.limit, 2);
      process.env.XUENESS_MODEL_MAX_CONCURRENT = "7";
      assert.equal(providerAdmissionForState(state.toUpperCase()), shared);
      assert.equal(providerAdmissionForState(`${state}-other`)?.limit, 7);

      process.env.XUENESS_MODEL_MAX_CONCURRENT = "0";
      const disabledState = `${state}-disabled`;
      assert.equal(providerAdmissionForState(disabledState), undefined);
      process.env.XUENESS_MODEL_MAX_CONCURRENT = "8";
      assert.equal(providerAdmissionForState(disabledState), undefined);

      process.env.XUENESS_MODEL_MAX_CONCURRENT = "65";
      assert.equal(providerAdmissionForState(`${state}-invalid`)?.limit, 4);
    } finally {
      if (previous === undefined) delete process.env.XUENESS_MODEL_MAX_CONCURRENT;
      else process.env.XUENESS_MODEL_MAX_CONCURRENT = previous;
    }
  });
});
