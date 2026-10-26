import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ADMISSION_DECREASE_FACTOR,
  ADMISSION_FLOOR,
  ADMISSION_IDLE_RESET_MS,
  ADMISSION_INCREASE_AFTER_SUCCESSES,
  ModelConcurrencyController,
} from "../src/admission-controller.ts";

const key = "anthropic/claude-sonnet";

describe("model concurrency controller (AIMD)", () => {
  it("starts at the initial cap and admits while below it", () => {
    const controller = new ModelConcurrencyController(key, 4, 8);
    assert.deepEqual(controller.snapshot(), { key, initial: 4, growthLimit: 8, cap: 4, epoch: 0, inFlight: 0, waiters: 0, successStreak: 0 });
    const epoch = controller.admitted(1000);
    assert.equal(epoch, 0);
    assert.equal(controller.canAdmit(1000), true);
    for (let i = 0; i < 3; i++) controller.admitted(1000);
    assert.equal(controller.canAdmit(1000), false);
  });

  it("cuts the cap by the factor on a current-epoch throttle and turns the epoch", () => {
    const controller = new ModelConcurrencyController(key, 13, 26);
    const epoch = controller.admitted(1000);
    controller.throttled(2000, epoch);
    const state = controller.snapshot();
    assert.equal(state.cap, Math.floor(13 * ADMISSION_DECREASE_FACTOR));
    assert.equal(state.epoch, 1);
    assert.equal(state.inFlight, 0);
    assert.equal(state.lastBad, 13);
    assert.equal(state.lastGood, undefined);
  });

  it("never cuts below the floor", () => {
    const controller = new ModelConcurrencyController(key, 2, 4);
    const first = controller.admitted(1000);
    controller.throttled(1100, first);
    assert.equal(controller.snapshot().cap, 1);
    const second = controller.admitted(1200);
    controller.throttled(1300, second);
    const state = controller.snapshot();
    assert.equal(state.cap, ADMISSION_FLOOR);
    assert.equal(state.epoch, 2);
  });

  it("counts one burst once: old-epoch refusals reset the streak but move nothing", () => {
    const controller = new ModelConcurrencyController(key, 13, 26);
    const epochs = Array.from({ length: 13 }, () => controller.admitted(1000));
    for (const epoch of epochs) controller.throttled(2000, epoch);
    const state = controller.snapshot();
    assert.equal(state.cap, 9);
    assert.equal(state.epoch, 1);
    // A stale refusal is not a verdict on the current cap; a stale success is not evidence for it.
    controller.throttled(2100, 0);
    controller.succeeded(2200, 0);
    assert.equal(controller.snapshot().cap, 9);
    assert.equal(controller.snapshot().successStreak, 0);
    const current = controller.admitted(2300);
    controller.succeeded(2400, current);
    assert.equal(controller.snapshot().successStreak, 1);
  });

  it("falls back to a proven lastGood instead of cutting when probing above it", () => {
    const controller = new ModelConcurrencyController(key, 4, 8);
    controller.waiters(2);
    for (let round = 0; round < 2; round++) {
      for (let i = 0; i < ADMISSION_INCREASE_AFTER_SUCCESSES; i++) {
        const epoch = controller.admitted(1000 + round * 1000 + i);
        controller.succeeded(1000 + round * 1000 + i + 10, epoch);
      }
    }
    const climbed = controller.snapshot();
    assert.equal(climbed.cap, 6);
    assert.equal(climbed.lastGood, 5);
    const probe = controller.admitted(3000);
    controller.throttled(3100, probe);
    const state = controller.snapshot();
    assert.equal(state.cap, 5);
    assert.equal(state.lastBad, 6);
  });

  it("raises only under demand and only to the growth limit", () => {
    const controller = new ModelConcurrencyController(key, 4, 5);
    // No waiters: the streak accumulates but the cap does not move.
    for (let i = 0; i < ADMISSION_INCREASE_AFTER_SUCCESSES * 2; i++) {
      const epoch = controller.admitted(1000 + i);
      controller.succeeded(1010 + i, epoch);
    }
    assert.equal(controller.snapshot().cap, 4);
    // With waiters the cap climbs one step per proven streak, then stops at the limit.
    controller.waiters(1);
    for (let step = 0; step < 3; step++) {
      for (let i = 0; i < ADMISSION_INCREASE_AFTER_SUCCESSES; i++) {
        const epoch = controller.admitted(5000 + step * 1000 + i);
        controller.succeeded(5010 + step * 1000 + i, epoch);
      }
    }
    assert.equal(controller.snapshot().cap, 5);
    assert.equal(controller.snapshot().lastGood, 5);
  });

  it("transient failures reset the streak without touching the cap; ended only drains", () => {
    const controller = new ModelConcurrencyController(key, 4, 8);
    const epoch = controller.admitted(1000);
    controller.succeeded(1010, epoch);
    assert.equal(controller.snapshot().successStreak, 1);
    assert.equal(controller.snapshot().inFlight, 0);
    controller.admitted(2000);
    controller.failedTransient(2100);
    assert.equal(controller.snapshot().inFlight, 0);
    assert.equal(controller.snapshot().successStreak, 0);
    assert.equal(controller.snapshot().cap, 4);
    controller.admitted(3000);
    controller.ended(3100);
    assert.equal(controller.snapshot().inFlight, 0);
    assert.equal(controller.snapshot().cap, 4);
  });

  it("arms a Retry-After cooldown that gates admissions until it expires", () => {
    const controller = new ModelConcurrencyController(key, 4, 8);
    const epoch = controller.admitted(1000);
    controller.throttled(1100, epoch, 5_000);
    const state = controller.snapshot();
    assert.equal(state.cooldownUntil, 6_100);
    assert.equal(controller.canAdmit(6_000), false);
    assert.equal(controller.canAdmit(6_100), true);
  });

  it("keeps the later of overlapping cooldowns, including from stale epochs", () => {
    const controller = new ModelConcurrencyController(key, 4, 8);
    const first = controller.admitted(1000);
    controller.throttled(1100, first, 5_000);
    const stale = 0;
    controller.throttled(2000, stale, 30_000);
    const state = controller.snapshot();
    assert.equal(state.cap, 3);
    assert.equal(state.epoch, 1);
    assert.equal(state.cooldownUntil, 32_000);
  });

  it("forgets the learned cap after the idle window and stays idempotent", () => {
    const controller = new ModelConcurrencyController(key, 4, 8);
    const epoch = controller.admitted(1000);
    controller.throttled(1100, epoch, 1_000);
    assert.equal(controller.snapshot().cap, 3);
    // Still busy: no reset while anything is in flight.
    controller.admitted(1200);
    controller.observe(1000 + ADMISSION_IDLE_RESET_MS + 1000);
    assert.equal(controller.snapshot().cap, 3);
    controller.ended(1000 + ADMISSION_IDLE_RESET_MS + 1000);
    // Drained and idle: the next signal resets to the initial cap.
    controller.observe(1000 + ADMISSION_IDLE_RESET_MS + 2000);
    const state = controller.snapshot();
    assert.equal(state.cap, 4);
    assert.equal(state.cooldownUntil, undefined);
    assert.equal(state.lastBad, undefined);
    assert.equal(state.epoch, 2);
    // Idempotent: an already-clean bucket does not turn the epoch again.
    controller.observe(1000 + ADMISSION_IDLE_RESET_MS + 3000);
    assert.equal(controller.snapshot().epoch, 2);
  });
});
