import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { SessionStore } from "@xueness/sessions";
import { beforeModelRequest, pendingSnapshot, settleTurn, SteeringInbox } from "../src/steering.ts";
import { guidanceWaitWindow } from "../src/steering-priority.ts";
import { fingerprint, type Row } from "../src/queue-types.ts";

const sid = "a".repeat(32), first = "1".repeat(32), second = "2".repeat(32);
const promotion = (state: string, itemId: string): Row => {
  const receipt: Row = { id: itemId, request_id: second, delivery: "startNow", state: "reserved", targetTurnId: "turn-1" };
  return { id: second, fingerprint: fingerprint("p"), state, receipt, previous_ids: [itemId] };
};

describe("steering wait-window preservation and receipt tracking (C-WFL-02)", () => {
  it("detects compaction and waiting-user windows of the active turn", () => {
    const running: Row = { status: "running", active_turn_id: "turn-1" };
    assert.deepEqual(guidanceWaitWindow(running), { turnId: "turn-1", compacting: false, waiting: false });
    assert.deepEqual(guidanceWaitWindow({ ...running, compact_timeline: [{ id: "c1", status: "started" }] }), { turnId: "turn-1", compacting: true, waiting: false });
    assert.deepEqual(guidanceWaitWindow({ ...running, compact_timeline: [{ id: "c1", status: "completed" }], pending_question: { q: "?" } }), { turnId: "turn-1", compacting: false, waiting: true });
    assert.equal(guidanceWaitWindow({ ...running, status: "completed" }), null);
    assert.equal(guidanceWaitWindow({ status: "running" }), null);
  });

  it("keeps same-turn inputs queued and trackable through a compaction window", async () => {
    const root = mkdtempSync(join(tmpdir(), "xueness-steer-wait-")), stateDir = join(root, "ts");
    const store = new SessionStore(stateDir);
    try {
      const session = await store.new("wait", root, { sessionId: sid });
      session.active_turn_id = "turn-1"; session.status = "running";
      session.compact_timeline = [{ id: "c1", status: "started" }];
      await store.save(session);
      const inbox = new SteeringInbox(store);
      inbox.media.itemId = () => first;
      await inbox.locked(sid, () => inbox.admitLocked(sid, "guide during compaction", "turn-1", first, fingerprint("one")));
      const during = await pendingSnapshot(session, store, stateDir);
      const row = during.pending_guidance.find((item: Row) => item.id === first)!;
      assert.equal(row.status, "queued", "the input is preserved, not paused or completed");
      assert.equal(row.preserved, true);
      assert.equal(row.targetTurnId, "turn-1");
      assert.equal(row.priority, "guide");
      const persisted = (inbox.read(sid).items as Row[]).find((item) => item.id === first)!;
      assert.equal(persisted.status, "queued", "preservation never rewrites the durable queue row");
      // The window closes; the next model boundary still admits exactly this guide.
      session.compact_timeline = [{ id: "c1", status: "completed" }]; await store.save(session);
      assert.equal(await beforeModelRequest(session, store, stateDir, undefined, 1), 1);
      assert.equal((session.messages as Row[]).at(-1)!._input_id, first);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("exposes the priority class on receipts and settles stale-turn inputs once the turn ends", async () => {
    const root = mkdtempSync(join(tmpdir(), "xueness-steer-priority-receipt-")), stateDir = join(root, "ts");
    const store = new SessionStore(stateDir);
    try {
      const session = await store.new("receipt", root, { sessionId: sid });
      session.active_turn_id = "turn-1"; session.status = "running"; await store.save(session);
      const inbox = new SteeringInbox(store);
      let next = first; inbox.media.itemId = () => next;
      const [plain] = await inbox.locked(sid, () => inbox.admitLocked(sid, "plain guide", "turn-1", first, fingerprint("one")));
      assert.equal(plain.priority, "guide");
      next = second;
      const [takeover] = await inbox.locked(sid, () => inbox.admitLocked(sid, "takeover guide", "turn-1", second, fingerprint("two")));
      assert.equal(takeover.priority, "guide", "a guide is plain until a send-now reservation promotes it");
      await inbox.locked(sid, async () => {
        const record = inbox.read(sid), item = (record.items as Row[]).find((row) => row.id === second)!;
        item.promotion = promotion("reserved", second); await inbox.atomicSave(sid, record);
      });
      const snapshot = await pendingSnapshot(session, store, stateDir);
      const promoted = snapshot.pending_guidance.find((item: Row) => item.id === second)!;
      assert.equal(promoted.priority, "takeover", "receipts stay trackable with their priority class");
      // Turn ends without delivery: both inputs settle paused with a withdraw hint.
      session.status = "completed"; delete session.active_turn_id; await store.save(session);
      await settleTurn(session, store, stateDir, "turn-1");
      const settled = await pendingSnapshot(session, store, stateDir);
      assert.ok(settled.pending_guidance.every((item: Row) => item.status === "paused"));
      assert.ok(settled.pending_guidance.every((item: Row) => typeof item.pause_reason === "string" && item.pause_reason.includes("withdraw")));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
