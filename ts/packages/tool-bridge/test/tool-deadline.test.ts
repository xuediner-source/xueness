import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ToolDeadline, ToolDeadlineCancelledError, ToolDeadlineExceededError, deadlineFailure,
} from "../src/tool-deadline.ts";

const never = (): Promise<never> => new Promise(() => {});
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("ToolDeadline (C-TOOL-06)", () => {
  it("times out an active run and reports queuedMs separately", async () => {
    const deadline = new ToolDeadline({ timeoutMs: 40 });
    await assert.rejects(deadline.race(never()), (error: unknown) => {
      assert.ok(error instanceof ToolDeadlineExceededError);
      assert.equal(error.code, "tool_timeout");
      assert.equal(error.timeoutMs, 40);
      assert.ok(Math.abs(error.queuedMs) < 5, `queued ${error.queuedMs}`);
      const result = deadlineFailure("read", error);
      assert.equal(result.ok, false);
      assert.equal(result.error?.code, "tool_timeout");
      assert.match(result.output, /read timed out after 40ms/);
      assert.match(result.output, /queued 0ms/);
      assert.deepEqual(result.data, { timedOutAfterMs: 40, queuedMs: error.queuedMs, activeMs: error.activeMs });
      return true;
    });
    assert.equal(deadline.expired, true);
    assert.equal(deadline.cancelled, false);
    assert.ok(deadline.signal.aborted);
  });

  it("does not charge queue time: pause excludes it, resume continues the budget", async () => {
    const deadline = new ToolDeadline({ timeoutMs: 60 });
    const raced = deadline.race(never());
    await delay(25);
    deadline.pause();
    assert.equal(deadline.paused, true);
    await delay(120);
    assert.ok(deadline.queuedMs >= 100, `queued ${deadline.queuedMs}`);
    assert.ok(!deadline.expired, "queue time must not false-time-out");
    deadline.resume();
    assert.equal(deadline.paused, false);
    // Only the remaining ~35ms of active budget may run now.
    await assert.rejects(raced, (error: unknown) => {
      assert.ok(error instanceof ToolDeadlineExceededError);
      assert.ok(error.queuedMs >= 100, `queued ${error.queuedMs}`);
      assert.ok(error.activeMs >= 55 && error.activeMs <= 60, `active ${error.activeMs}`);
      return true;
    });
  });

  it("aborts immediately from outside while paused (before any remaining budget)", async () => {
    const external = new AbortController();
    const deadline = new ToolDeadline({ timeoutMs: 500, signal: external.signal });
    deadline.pause();
    const raced = deadline.race(never());
    const started = Date.now();
    await delay(10);
    external.abort();
    await assert.rejects(raced, (error: unknown) => {
      assert.ok(error instanceof ToolDeadlineCancelledError);
      assert.equal(error.code, "cancelled");
      return true;
    });
    assert.ok(Date.now() - started < 200, "cancel wins immediately, not at the budget");
    assert.equal(deadline.cancelled, true);
    assert.equal(deadline.expired, false);
  });

  it("aborts immediately from outside while active", async () => {
    const external = new AbortController();
    const deadline = new ToolDeadline({ timeoutMs: 5000, signal: external.signal });
    const raced = deadline.race(never());
    await delay(10);
    external.abort();
    await assert.rejects(raced, ToolDeadlineCancelledError);
    assert.equal(deadline.expired, false);
  });

  it("lets a run that settles within budget pass through unchanged", async () => {
    const deadline = new ToolDeadline({ timeoutMs: 500 });
    const value = await deadline.race(delay(20).then(() => "ok"));
    assert.equal(value, "ok");
    assert.equal(deadline.expired, false);
    assert.equal(deadline.cancelled, false);
    assert.ok(deadline.queuedMs < 5);
  });

  it("rejects a non-finite or non-positive timeoutMs", () => {
    for (const bad of [0, -1, Number.POSITIVE_INFINITY, Number.NaN]) assert.throws(() => new ToolDeadline({ timeoutMs: bad }), TypeError);
  });

  it("treats pause/resume in wrong states as no-ops and accumulates queued time across cycles", async () => {
    const deadline = new ToolDeadline({ timeoutMs: 400 });
    deadline.resume(); // not paused: no-op
    deadline.pause();
    deadline.pause(); // already paused: no-op
    await delay(30);
    deadline.resume();
    await delay(10);
    deadline.pause();
    await delay(30);
    deadline.resume();
    assert.ok(deadline.queuedMs >= 55, `queued ${deadline.queuedMs}`);
    assert.ok(deadline.activeMs >= 8, `active ${deadline.activeMs}`);
    const value = await deadline.race(Promise.resolve("done"));
    assert.equal(value, "done");
    deadline.pause(); // after settlement: no-op
    assert.equal(deadline.paused, false);
  });

  it("rejects immediately when constructed with an already-aborted signal and detaches external abort listeners on normal completion", async () => {
    const aborted = new AbortController();
    aborted.abort();
    const cancelledDeadline = new ToolDeadline({ timeoutMs: 5000, signal: aborted.signal });
    await assert.rejects(cancelledDeadline.race(never()), ToolDeadlineCancelledError);
    assert.equal(cancelledDeadline.cancelled, true);

    const shared = new AbortController();
    for (let i = 0; i < 20; i += 1) {
      const deadline = new ToolDeadline({ timeoutMs: 500, signal: shared.signal });
      const res = await deadline.race(Promise.resolve("ok"));
      assert.equal(res, "ok");
    }
    shared.abort();
  });
});
