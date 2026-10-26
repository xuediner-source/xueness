/** C-WFL-05: the residency lease acquires once and releases on every settle path. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { LocalFileLocks, PyBlockingIOError, withSessionLease } from "../src/index.ts";

describe("session residency lease", () => {
  it("releases the lease when the settle window ends normally", async () => {
    const locks = new LocalFileLocks();
    const base = mkdtempSync(join(tmpdir(), "xue-lease-ok-"));
    try {
      const value = await withSessionLease(locks, base, "turn.lock", async (lease) => {
        assert.equal(typeof lease.release, "function");
        return "settled";
      });
      assert.equal(value, "settled");
      // The lease is back: a fresh settle window can take it at once.
      const next = await locks.tryAcquire(base, "turn.lock");
      await next.release();
    } finally {
      await locks.close();
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("releases the lease when finalization throws, so nothing is wedged", async () => {
    const locks = new LocalFileLocks();
    const base = mkdtempSync(join(tmpdir(), "xue-lease-throw-"));
    try {
      await assert.rejects(
        withSessionLease(locks, base, "turn.lock", async () => { throw new Error("settlement failed"); }),
        /settlement failed/,
      );
      const retry = await locks.tryAcquire(base, "turn.lock");
      await retry.release();
    } finally {
      await locks.close();
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("never lets a second writer wait: the busy lease surfaces BlockingIOError immediately", async () => {
    const locks = new LocalFileLocks();
    const base = mkdtempSync(join(tmpdir(), "xue-lease-busy-"));
    try {
      let observed = "";
      await withSessionLease(locks, base, "turn.lock", async () => {
        await assert.rejects(locks.tryAcquire(base, "turn.lock"), (error: unknown) => {
          observed = error instanceof PyBlockingIOError ? error.code ?? "no code" : String(error);
          return error instanceof PyBlockingIOError;
        });
      });
      assert.equal(observed, "EAGAIN");
    } finally {
      await locks.close();
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("keeps every settle window exclusive across sequential abnormal settles", async () => {
    const locks = new LocalFileLocks();
    const base = mkdtempSync(join(tmpdir(), "xue-lease-repeat-"));
    try {
      for (let round = 0; round < 3; round += 1) {
        await assert.rejects(
          withSessionLease(locks, base, `turn-${round}.lock`, async () => { throw new Error(`boom ${round}`); }),
          new RegExp(`boom ${round}`),
        );
      }
      for (let round = 0; round < 3; round += 1) {
        const handle = await locks.tryAcquire(base, `turn-${round}.lock`);
        await handle.release();
      }
    } finally {
      await locks.close();
      rmSync(base, { recursive: true, force: true });
    }
  });
});
