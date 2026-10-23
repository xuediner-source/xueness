import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { NativeFileLocks, SessionStore } from "@xueness/sessions";
import { it } from "node:test";
import { fixture } from "./fixtures.ts";
it("rejects a stale run when another process publishes a revision before the native lease is acquired", async () => {
  const f = fixture([{ content: "must not run" }]), other = new NativeFileLocks(); let before = 0, closed = 0, published!: Buffer;
  try {
    await f.store.save(f.session); const writer = new SessionStore(f.store.directory, { locks: other });
    f.hooks.extensions = [{ id: "sessions", beforeRun() { before++; }, async close(c) { closed++; await c.save(); } }];
    const acquire = f.store.lease.bind(f.store);
    f.store.lease = async (sid) => {
      const held = await writer.lease(sid);
      try {
        const s = await writer.load(sid); s.concurrent_writer = "other process";
        (s.messages as unknown[]).push({ role: "assistant", content: "Published by the other process" }); await writer.save(s);
      } finally { await held.release(); }
      published = readFileSync(f.store.pathFor(sid)); return acquire(sid);
    };
    await assert.rejects(f.runner.run(f.session), { name: "BlockingIOError" });
    assert.equal(before, 0); assert.equal(closed, 0); assert.equal(f.requests(), 0); assert.equal(f.effects(), 0);
    assert.deepEqual(readFileSync(f.store.pathFor(String(f.session.id))), published);
    assert.equal((await f.store.load(String(f.session.id))).concurrent_writer, "other process");
    assert.equal(f.runner.isRunning(String(f.session.id)), false); const held = await acquire(String(f.session.id)); await held.release();
  } finally { await other.close(); f.close(); }
});
it("does not run extension cleanup without owning a lease held by another process", async () => {
  const f = fixture([{ content: "must not run" }]), other = new NativeFileLocks(); let closed = 0;
  try {
    await f.store.save(f.session); const snapshot = readFileSync(f.store.pathFor(String(f.session.id)));
    f.hooks.extensions = [{ id: "sessions", async close(c) { closed++; c.session.cleanup_wrote = true; await c.save(); } }];
    const held = await other.tryAcquire(f.store.lockDirectory, String(f.session.id) + ".lock");
    try { await assert.rejects(f.runner.run(f.session), { name: "BlockingIOError" }); }
    finally { await held.release(); }
    assert.equal(closed, 0); assert.equal(f.requests(), 0); assert.equal(f.effects(), 0); assert.deepEqual(readFileSync(f.store.pathFor(String(f.session.id))), snapshot);
    assert.equal(f.runner.isRunning(String(f.session.id)), false);
  } finally { await other.close(); f.close(); }
});
it("retains caller policy edits when the durable input revision has not changed", async () => {
  const f = fixture([{ content: "Accepted local policy" }]);
  try {
    await f.store.save(f.session); f.session.permission_mode = "yolo"; f.session.model_selection = { provider_id: "local", model: "scripted" };
    await f.runner.run(f.session); const saved = await f.store.load(String(f.session.id));
    assert.equal(saved.status, "completed"); assert.equal(saved.permission_mode, "yolo"); assert.deepEqual(saved.model_selection, { provider_id: "local", model: "scripted" });
    assert.equal(f.requests(), 1);
  } finally { f.close(); }
});
