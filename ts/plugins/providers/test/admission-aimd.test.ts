/**
 * Adaptive admission behavior through the public port: AIMD feedback from
 * attempt status events, Retry-After cooldowns with wake, cross-run
 * round-robin, and foreground (main-task) priority. The pure controller math
 * is pinned separately in `admission-controller.test.ts`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { admissionWithScope, ProviderAdmissionController } from "../src/admission-policy.ts";
import type { ModelConcurrencySnapshot } from "../src/admission-controller.ts";
import type { ModelRequestAdmissionTicket } from "@xueness/providers";

const alpha = { providerId: "anthropic", modelId: "claude-sonnet" };

type Ticket = ModelRequestAdmissionTicket & { publish?(info: Record<string, unknown>): void | Promise<void> };

function clocked(limit: number): {
  admission: ProviderAdmissionController;
  advance(ms: number): void;
  clock(): number;
} {
  let now = 100_000;
  const wakes: { at: number; fire: () => void }[] = [];
  const admission = new ProviderAdmissionController(limit, {
    now: () => now,
    schedule: (fire, delayMs) => {
      const wake = { at: now + delayMs, fire };
      wakes.push(wake);
      return () => {
        const index = wakes.indexOf(wake);
        if (index >= 0) wakes.splice(index, 1);
      };
    },
  });
  return {
    admission,
    clock: () => now,
    advance(ms: number): void {
      now += ms;
      for (const wake of [...wakes]) if (wake.at <= now) wake.fire();
    },
  };
}

/** The bucket state at `index`, asserted present so tests read it unchecked. */
function modelState(admission: ProviderAdmissionController, index = 0): ModelConcurrencySnapshot {
  const state = admission.snapshot().models[index];
  assert.ok(state);
  return state;
}

const completed = { type: "model_request_completed" };
const rateLimited = (retryAfterMs?: number): Record<string, unknown> => ({
  type: "model_retry_scheduled", reason: "rate_limited", attempt: 1, nextAttempt: 2, delayMs: 1000,
  ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
});

describe("adaptive model admission", () => {
  it("cuts the cap on a 429, cools the bucket, and wakes the queued waiter after Retry-After", async () => {
    const { admission, advance, clock } = clocked(4);
    const held: Ticket[] = [];
    for (let i = 0; i < 4; i++) held.push(await admission.acquire({ model: alpha, scope: { run: "w1" } }));
    const heldTicket = (index: number): Ticket => {
      const ticket = held[index];
      assert.ok(ticket);
      return ticket;
    };
    let granted = false;
    const waiter = admission.acquire({ model: alpha, scope: { run: "w1" } }).then((ticket) => { granted = true; return ticket; });
    assert.equal(admission.tryAcquire({ model: alpha, scope: { run: "w2" } }), undefined);

    await heldTicket(0).publish?.(rateLimited(5_000));
    let state = modelState(admission);
    assert.equal(state.cap, 3);
    assert.equal(state.cooldownUntil, clock() + 5_000);
    // One attempt ended with the verdict; another releases: the gate has room
    // again but the cooldown still holds the queued waiter.
    heldTicket(1).release();
    assert.equal(granted, false);
    assert.equal(admission.tryAcquire({ model: alpha, scope: { run: "w2" } }), undefined);

    advance(5_000);
    const waiterTicket = await waiter;
    state = modelState(admission);
    assert.ok(state.cooldownUntil === undefined || state.cooldownUntil <= clock());
    waiterTicket.release();
    heldTicket(2).release();
    heldTicket(3).release();
  });

  it("counts a terminal rate-limit failure as a throttle verdict and a transient retry as cap-neutral", async () => {
    const { admission } = clocked(4);
    const throttled = await admission.acquire({ model: alpha, scope: { run: "w1" } });
    await throttled.publish?.({ type: "model_request_failed", reason: "rate_limited", retryable: false, terminal: true, statusCode: 429 });
    assert.equal(modelState(admission).cap, 3);

    const transient = await admission.acquire({ model: alpha, scope: { run: "w1" } });
    await transient.publish?.({ type: "model_retry_scheduled", reason: "server_error", attempt: 1, nextAttempt: 2, delayMs: 2000 });
    const state = modelState(admission);
    assert.equal(state.cap, 3);
    assert.equal(state.inFlight, 0);
    assert.equal(state.successStreak, 0);

    // A terminal SingleAttempt transient failure also resets the streak; a terminal 529 cuts the cap.
    const ok = await admission.acquire({ model: alpha, scope: { run: "w1" } });
    await ok.publish?.(completed);
    assert.equal(modelState(admission).successStreak, 1);
    const terminalTransient = await admission.acquire({ model: alpha, scope: { run: "w1" } });
    await terminalTransient.publish?.({ type: "model_request_failed", reason: "server_error", retryable: true, terminal: true, statusCode: 503 });
    assert.equal(modelState(admission).successStreak, 0);
    assert.equal(modelState(admission).cap, 3);

    // A retryable failure defers its verdict to the retry event; a later
    // release never settles twice.
    const deferred = await admission.acquire({ model: alpha, scope: { run: "w1" } });
    await deferred.publish?.({ type: "model_request_failed", reason: "rate_limited", retryable: true, terminal: false, statusCode: 429, retryAfterMs: 1_000 });
    assert.equal(modelState(admission).cap, 3);
    await deferred.publish?.(rateLimited(1_000));
    assert.equal(modelState(admission).cap, 2);
    deferred.release();
    assert.equal(modelState(admission).inFlight, 0);
  });

  it("recovers the cap one step per four successful attempts while waiters demand slots", async () => {
    const { admission, advance } = clocked(4);
    const held: Ticket[] = [];
    for (let i = 0; i < 4; i++) held.push(await admission.acquire({ model: alpha, scope: { run: "cut" } }));
    const heldTicket = (index: number): Ticket => {
      const ticket = held[index];
      assert.ok(ticket);
      return ticket;
    };
    await heldTicket(0).publish?.(rateLimited(100));
    heldTicket(1).release();
    advance(200);
    const probe = await admission.acquire({ model: alpha, scope: { run: "cut" } });
    await probe.publish?.(rateLimited(100));
    assert.equal(modelState(admission).cap, 2);
    heldTicket(2).release();
    heldTicket(3).release();

    advance(200);
    const waiters: Promise<Ticket>[] = [];
    for (let i = 0; i < 6; i++) waiters.push(admission.acquire({ model: alpha, scope: { run: "recover" } }).then((ticket) => ticket as Ticket));
    const waiter = async (index: number): Promise<Ticket> => {
      const promise = waiters[index];
      assert.ok(promise);
      const ticket = await promise;
      assert.ok(ticket);
      return ticket;
    };
    const first = await waiter(0);
    const second = await waiter(1);
    // Each success frees a slot that admits the next waiter; after four
    // current-epoch successes with waiters still present the cap climbs.
    await first.publish?.(completed);
    const third = await waiter(2);
    await second.publish?.(completed);
    const fourth = await waiter(3);
    await third.publish?.(completed);
    assert.equal(modelState(admission).cap, 2);
    await fourth.publish?.(completed);
    assert.equal(modelState(admission).cap, 3);
    for (let index = 4; index < 6; index++) {
      const ticket = await waiter(index);
      await ticket.publish?.(completed);
    }
    assert.equal(modelState(admission).inFlight, 0);
  });

  it("rotates grants across runs so a dense run cannot starve a later one", async () => {
    const { admission } = clocked(1);
    const held = await admission.acquire({ model: alpha, scope: { run: "dense" } });
    const order: string[] = [];
    const track = (run: string, promise: Promise<Ticket>): Promise<Ticket> =>
      promise.then((ticket) => { order.push(run); return ticket; });
    const dense2 = track("dense", admission.acquire({ model: alpha, scope: { run: "dense" } }).then((t) => t as Ticket));
    const single = track("single", admission.acquire({ model: alpha, scope: { run: "single" } }).then((t) => t as Ticket));
    const dense3 = track("dense", admission.acquire({ model: alpha, scope: { run: "dense" } }).then((t) => t as Ticket));

    held.release();
    const firstGranted = await Promise.race([dense2, single, dense3]);
    assert.deepEqual(order, ["single"]);
    firstGranted.release();
    const secondGranted = await Promise.race([dense2, dense3]);
    assert.deepEqual(order, ["single", "dense"]);
    secondGranted.release();
    await dense3;
    assert.deepEqual(order, ["single", "dense", "dense"]);
  });

  it("admits foreground requests without queueing while the bucket is saturated, cooling and queued", async () => {
    const { admission, clock } = clocked(4);
    const held: Ticket[] = [];
    for (let i = 0; i < 4; i++) held.push(await admission.acquire({ model: alpha, scope: { run: "w1" } }));
    const heldTicket = (index: number): Ticket => {
      const ticket = held[index];
      assert.ok(ticket);
      return ticket;
    };
    await heldTicket(0).publish?.(rateLimited(60_000));
    let queued = false;
    void admission.acquire({ model: alpha, scope: { run: "w1" } }).then(() => { queued = true; });
    assert.equal(queued, false);

    const fastForeground = admission.tryAcquire({ model: alpha, scope: { foreground: true } });
    assert.ok(fastForeground);
    const foreground = await admission.acquire({ model: alpha, scope: { foreground: true } });
    assert.ok(foreground);
    const state = modelState(admission);
    // Observer semantics: counted in flight (above the cap is a legal
    // transient) and subject to the cooldown for the governed runs only.
    assert.equal(state.inFlight, 5);
    assert.ok(state.cooldownUntil === clock() + 60_000);
    assert.equal(queued, false);

    // Foreground feedback still shapes the shared cap: its terminal 429 cuts it.
    await foreground.publish?.({ type: "model_request_failed", reason: "rate_limited", retryable: false, terminal: true });
    assert.equal(modelState(admission).cap, 2);
    fastForeground.release();
    heldTicket(1).release();
    heldTicket(2).release();
    heldTicket(3).release();
  });

  it("binds a scope into every call of a wrapped admission", async () => {
    const { admission } = clocked(1);
    const held = await admission.acquire({ model: alpha, scope: { run: "w1" } });
    const wrapped = admissionWithScope(admission, { foreground: true });
    // Foreground-bound calls pass the saturated bucket without queueing.
    const ticket = await wrapped.acquire({ model: alpha });
    assert.ok(ticket);
    assert.equal(modelState(admission).inFlight, 2);
    const fast = wrapped.tryAcquire?.({ model: alpha });
    assert.ok(fast);
    assert.equal(modelState(admission).inFlight, 3);
    ticket.release();
    fast.release();
    held.release();
    const { models, changes, ...rest } = admission.snapshot();
    void models; void changes;
    assert.deepEqual(rest, { limit: 1, active: 0, queued: 0, buckets: 0 });
  });

  it("projects cap changes into the snapshot ring (upstream concurrency-changed facts)", async () => {
    const key = '["anthropic","claude-sonnet"]';
    const { admission, advance, clock } = clocked(4);
    // A 429 with Retry-After cuts the cap and is projected with its reason.
    const throttled = await admission.acquire({ model: alpha, scope: { run: "trace" } });
    await throttled.publish?.(rateLimited(2_000));
    assert.deepEqual(admission.snapshot().changes, [
      { key, previous: 4, next: 3, reason: "rate_limited", lastBad: 4, cooldownMs: 2_000, at: clock() },
    ]);

    // Growth under waiter demand projects as a recovery step (the seventh
    // waiter keeps demand alive at the fourth current-epoch success).
    advance(2_000);
    const waiters: Promise<Ticket>[] = [];
    for (let i = 0; i < 7; i++) waiters.push(admission.acquire({ model: alpha, scope: { run: "trace" } }).then((ticket) => ticket as Ticket));
    for (let i = 0; i < 4; i++) await (await waiters[i]!).publish?.(completed);
    assert.deepEqual(admission.snapshot().changes.at(-1), { key, previous: 3, next: 4, reason: "recovered", at: clock() });
    for (let i = 4; i < 7; i++) (await waiters[i]!).release();

    // An idle bucket forgets a learned cut on the next admission signal.
    const beta = { providerId: "openai", modelId: "gpt-4o" };
    const cut = await admission.acquire({ model: beta, scope: { run: "trace" } });
    await cut.publish?.(rateLimited());
    advance(300_001);
    const fresh = await admission.acquire({ model: beta, scope: { run: "trace" } });
    assert.deepEqual(admission.snapshot().changes.at(-1), { key: '["openai","gpt-4o"]', previous: 3, next: 4, reason: "idle_reset", at: clock() });
    fresh.release();
  });

  it("bounds the change ring to the most recent cap changes", async () => {
    const { admission } = clocked(4);
    for (let i = 0; i < 70; i++) {
      const ticket = await admission.acquire({ model: alpha, scope: { run: "ring" } });
      await ticket.publish?.(rateLimited());
    }
    const changes = admission.snapshot().changes;
    assert.equal(changes.length, 64);
    assert.ok(changes.every((change) => change.reason === "rate_limited" && change.next <= change.previous));
  });
});
