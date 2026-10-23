import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { AgentRunner, type AgentExtension } from "@xueness/agent";
import { SessionStore, type Session } from "@xueness/sessions";
import { MessageQueue } from "../src/queue.ts";
import { queueRunExtension } from "../src/queue-run.ts";
import { MediaArtifactStore } from "../src/media-store.ts";
import { Owner } from "../src/media-owner.ts";
import { ownerRow } from "../src/queue-media.ts";
import { fingerprint, type Row } from "../src/queue-types.ts";
const sid = "a".repeat(32);
function runner(store: SessionStore, root: string, extensions: AgentExtension[], complete: (messages: Row[]) => Promise<Row>, enabled: (id: string) => boolean = () => true) {
  return new AgentRunner({ store, root, provider: { complete }, toolBridge: { call: async () => { throw new Error("no tools"); }, callAll: async () => [] },
    hooks: { enabled, tools: () => [], toolOwner: () => null, extensions } });
}
describe("queued turn execution", () => {
  it("drains complete queued turns under one continuous cross-process lease", async () => {
    const root = mkdtempSync(join(tmpdir(), "xueness-queue-run-")), store = new SessionStore(join(root, "state"));
    try {
      const s = await store.new("already answered", root, { sessionId: sid }); s.status = "completed"; await store.save(s);
      const queue = new MessageQueue(store); await queue.setAccepting(sid, true); await queue.enqueue(sid, "first queued"); await queue.enqueue(sid, "second queued"); await queue.pausePending(sid);
      const prompts: string[] = [], competitor = new SessionStore(store.directory);
      const agent = runner(store, root, [queueRunExtension({ request: { continue_queue: true }, stateDir: store.directory })], async (messages) => {
        await assert.rejects(competitor.lease(sid), { name: "BlockingIOError" });
        prompts.push(String(messages.filter((m) => m.role === "user").at(-1)!.content)); return { content: "done" };
      });
      await agent.run(s);
      assert.deepEqual(prompts, ["first queued", "second queued"]);
      assert.equal(s.status, "completed"); assert.equal(s.current_queue_item_id, undefined);
      const snapshot = await queue.snapshot(sid); assert.equal(snapshot.queued_messages.length, 0); assert.equal(snapshot.queue_history.length, 2);
      assert(snapshot.queue_history.every((r: Row) => r.status === "completed"));
      const lease = await competitor.lease(sid); await lease.release();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("persists prepared media ownership with its queued message before provider access", async () => {
    const root = mkdtempSync(join(tmpdir(), "xueness-queue-media-run-")), stateDir = join(root, "state"), store = new SessionStore(stateDir);
    try {
      const session = await store.new("answered", root, { sessionId: sid }); session.status = "completed"; await store.save(session);
      const media = new MediaArtifactStore(stateDir), source = new Owner("draft", "draft", root, sid);
      const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ref = await media.importBytes(source, bytes, { name: "picture.png", mimeType: "image/png", size: bytes.length });
      const queue = new MessageQueue(store, { stateDir }); await queue.setAccepting(sid, true);
      const item = await queue.enqueue(sid, "image question", { text: "image question\nprepared context", metadata: { media_refs: [ref] }, media_sources: [{ owner: ownerRow(source), ids: [ref.id] }] }, { requestId: "1".repeat(32), fingerprint: fingerprint("image") });
      await queue.pausePending(sid); let calls = 0;
      const agent = runner(store, root, [queueRunExtension({ request: { continue_queue: true }, stateDir })], async () => {
        calls++; const saved = await store.load(sid), message = (saved.messages as Row[]).filter((m) => m.role === "user").at(-1)!;
        assert.equal(saved.current_queue_item_id, item.id); assert.equal(message.content, "image question\nprepared context");
        assert.deepEqual(message._media_refs, [ref]);
        assert.deepEqual(await media.resolve(new Owner("message", message._message_id, root, sid), ref.id), bytes);
        return { content: "image answered" };
      });
      await agent.run(session); assert.equal(calls, 1);
      const message = (session.messages as Row[]).filter((m) => m.role === "user").at(-1)!;
      assert.deepEqual(await media.describe(new Owner("message", message._message_id, root, sid), ref.id), ref);
      await assert.rejects(media.describe(new Owner("queue", item.id, root, sid), ref.id));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("rolls back an undurable queued append and leaves its source input resumable", async () => {
    const root = mkdtempSync(join(tmpdir(), "xueness-queue-save-failure-")), store = new SessionStore(join(root, "state"));
    try {
      const session = await store.new("old", root, { sessionId: sid }); session.status = "completed"; await store.save(session);
      const queue = new MessageQueue(store); await queue.setAccepting(sid, true); await queue.enqueue(sid, "queued failure"); await queue.pausePending(sid);
      const save = store.save.bind(store); let calls = 0;
      store.save = async (s: Session) => { if (s.current_queue_item_id) throw new Error("injected publication failure"); return save(s); };
      const agent = runner(store, root, [queueRunExtension({ request: { continue_queue: true }, stateDir: store.directory })], async () => { calls++; return { content: "must not run" }; });
      await assert.rejects(agent.run(session), /injected publication failure/);
      assert.equal(calls, 0); assert.equal((session.messages as Row[]).length, 2); assert.equal(session.current_queue_item_id, undefined);
      store.save = save; const pending = (await queue.snapshot(sid)).queued_messages; assert.equal(pending.length, 1); assert.equal(pending[0].status, "paused");
      const lease = await store.lease(sid); await lease.release();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("pauses an already-selected continuation when disabled and resumes it once after restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "xueness-queue-disable-")), store = new SessionStore(join(root, "state"));
    try {
      const session = await store.new("answered", root, { sessionId: sid }); session.status = "completed"; await store.save(session);
      const queue = new MessageQueue(store); await queue.setAccepting(sid, true); await queue.enqueue(sid, "first"); await queue.enqueue(sid, "second"); await queue.pausePending(sid);
      let sessionsEnabled = true; const prompts: string[] = [];
      const complete = async (messages: Row[]) => { prompts.push(String(messages.filter((m) => m.role === "user").at(-1)!.content)); return { content: "done" }; };
      const enabled = (id: string) => id !== "sessions" || sessionsEnabled;
      const firstRun = runner(store, root, [queueRunExtension({ request: { continue_queue: true }, stateDir: store.directory }),
        { id: "providers", afterRun() { sessionsEnabled = false; } }], complete, enabled);
      await firstRun.run(session);
      assert.deepEqual(prompts, ["first"]); assert.equal(session.current_queue_item_id, undefined);
      assert.deepEqual((await queue.snapshot(sid)).queued_messages.map((r: Row) => [r.text, r.status]), [["second", "paused"]]);
      sessionsEnabled = true;
      const restartedStore = new SessionStore(store.directory), restored = await restartedStore.load(sid);
      await runner(restartedStore, root, [queueRunExtension({ request: { continue_queue: true }, stateDir: store.directory })], complete, enabled).run(restored);
      assert.deepEqual(prompts, ["first", "second"]);
      const final = await queue.snapshot(sid); assert.equal(final.queued_messages.length, 0); assert.equal(final.queue_history.length, 2);
      assert.equal((restored.messages as Row[]).filter((m) => m.role === "user" && m.content === "second").length, 1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
