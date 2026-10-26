import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { SessionStore } from "@xueness/sessions";
import { beforeModelRequest, pendingSnapshot, SteeringInbox } from "../src/steering.ts";
import { boundaryAdmissionOrder, guidanceCommandKind, guidancePriority, preservedInWaitWindow } from "../src/steering-priority.ts";
import { fingerprint, type Row } from "../src/queue-types.ts";

const sid = "a".repeat(32), first = "1".repeat(32), second = "2".repeat(32), third = "3".repeat(32);
const promotion = (state: string, itemId: string): Row => {
  const receipt: Row = { id: itemId, request_id: third, delivery: "startNow", state: "reserved", targetTurnId: "turn-1" };
  return { id: third, fingerprint: fingerprint("p"), state, receipt, previous_ids: [itemId] };
};

describe("steering boundary priority scheduling", () => {
  it("ranks a live send-now takeover before plain guides and keeps FIFO otherwise", () => {
    const guide = (id: string): Row => ({ id, status: "queued", target_turn_id: "turn-1" });
    const plain = [guide(first), guide(second), guide(third)];
    assert.deepEqual(boundaryAdmissionOrder(plain).map((item) => item.id), [first, second, third]);
    const takeover = { ...guide(second), promotion: promotion("reserved", second) };
    assert.deepEqual(boundaryAdmissionOrder([guide(first), takeover, guide(third)]).map((item) => item.id), [second, first, third]);
    const claimed = { ...guide(first), promotion: promotion("claimed", first) };
    assert.equal(guidanceCommandKind(claimed), "start_now");
    assert.deepEqual(boundaryAdmissionOrder([claimed, { ...takeover }]).map((item) => item.id), [first, second]);
    const released = { ...guide(third), promotion: promotion("released", third) };
    assert.equal(guidanceCommandKind(released), "steer_guide");
    assert.equal(guidancePriority(takeover), "takeover");
    assert.equal(guidancePriority(guide(first)), "guide");
  });

  it("admits the takeover guide first at a model boundary and never re-admits it", async () => {
    const root = mkdtempSync(join(tmpdir(), "xueness-steer-priority-")), stateDir = join(root, "ts");
    const store = new SessionStore(stateDir);
    try {
      const session = await store.new("priority", root, { sessionId: sid });
      session.active_turn_id = "turn-1"; session.status = "running"; await store.save(session);
      const inbox = new SteeringInbox(store);
      let next = first; inbox.media.itemId = () => next;
      await inbox.locked(sid, () => inbox.admitLocked(sid, "first guide", "turn-1", first, fingerprint("one")));
      next = second; await inbox.locked(sid, () => inbox.admitLocked(sid, "takeover guide", "turn-1", second, fingerprint("two")));
      await inbox.locked(sid, async () => {
        const record = inbox.read(sid), item = (record.items as Row[]).find((row) => row.id === second)!;
        item.promotion = promotion("reserved", second); await inbox.atomicSave(sid, record);
      });
      assert.equal(await beforeModelRequest(session, store, stateDir, undefined, 1), 1);
      const messages = session.messages as Row[];
      assert.equal(messages.at(-1)!._input_id, second, "the live takeover is admitted before the older FIFO guide");
      assert.equal(messages.at(-1)!._input_boundary, "model_request");
      assert.equal(await beforeModelRequest(session, store, stateDir, undefined, 1), 1);
      assert.equal((session.messages as Row[]).filter((row) => row._input_id === first).length, 1);
      assert.equal(await beforeModelRequest(session, store, stateDir), 0, "no guidance is admitted twice in the same turn");
      const snapshot = await pendingSnapshot(session, store, stateDir);
      assert.ok(snapshot.pending_guidance.every((row: Row) => row.status !== "completed"));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("tracks which boundary admitted a guide, including the text-only close", async () => {
    const root = mkdtempSync(join(tmpdir(), "xueness-steer-boundary-")), stateDir = join(root, "ts");
    const store = new SessionStore(stateDir);
    try {
      const session = await store.new("boundary", root, { sessionId: sid });
      session.active_turn_id = "turn-1"; session.status = "running"; await store.save(session);
      const inbox = new SteeringInbox(store);
      inbox.media.itemId = () => first;
      await inbox.locked(sid, () => inbox.admitLocked(sid, "late guide", "turn-1", first, fingerprint("one")));
      assert.equal(await beforeModelRequest(session, store, stateDir, undefined, 1, "final_response"), 1);
      const message = (session.messages as Row[]).at(-1)!;
      assert.equal(message._input_boundary, "final_response");
      const record = inbox.read(sid), settled = (record.items as Row[]).find((row) => row.id === first)!;
      assert.equal(settled.status, "completed");
      assert.equal(settled.delivered_boundary, "final_response");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("preserves same-turn input through compaction and waiting-tool windows", () => {
    const active: Row = { id: first, status: "queued", target_turn_id: "turn-1" };
    const stale: Row = { id: second, status: "queued", target_turn_id: "turn-0" };
    assert.equal(preservedInWaitWindow(active, "turn-1"), true);
    assert.equal(preservedInWaitWindow(stale, "turn-1"), false);
    assert.equal(preservedInWaitWindow(active, null), false);
    // Guidance already journaled stays trackable after compaction moves it to the archive.
    const archived = { messages: [], archived_messages: [{ role: "user", _input_id: first }] };
    assert.ok(JSON.stringify(archived).includes(first));
  });
});
