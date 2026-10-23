import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { AgentRunner, kernelAgentHooks } from "@xueness/agent";
import { SessionStore, type Session } from "@xueness/sessions";
import { setup, testPlugin } from "./support.ts";
describe("post-authorization cancellation ownership", () => {
  for (const fail of [false, true]) it(`drains a started observer ${fail ? "through its failure" : "through its durable save"} before releasing the run lease`, async () => {
    let started!: () => void, finish!: () => void, laterObserver = 0, observerFinished = false, runSettled = false;
    const entered = new Promise<void>((resolve) => { started = resolve; }), blocker = new Promise<void>((resolve) => { finish = resolve; });
    let store!: SessionStore, session!: Session;
    const s = await setup({ settings: { mode: "yolo" }, eventTimeoutMs: 1, plugins: [
      testPlugin("checkpoint", { toolEvents: { events: ["after_tool_authorization"], priority: 100 } }, (ctx) => ctx.toolEvent("after_tool_authorization", async () => {
        started(); await blocker; session.checkpoint_saved = true; await store.save(session); observerFinished = true; if (fail) throw new Error("checkpoint settled with an error");
      })),
      testPlugin("later", { toolEvents: { events: ["after_tool_authorization"] } }, (ctx) => ctx.toolEvent("after_tool_authorization", () => { laterObserver++; })),
    ] });
    store = new SessionStore(join(s.artifacts, "state")); session = await store.new("cancel while checkpointing", s.workspace);
    const competitor = new SessionStore(store.directory), agent = new AgentRunner({ store, root: s.workspace, toolBridge: s.bridge,
      hooks: kernelAgentHooks(s.kernel, { enabled: () => true }), provider: { complete: async () => ({ tool_calls: [{ id: "write-one", type: "function", function: { name: "write", arguments: '{"path":"a.txt","content":"must not write"}' } }] }) } });
    const pending = agent.run(session); pending.then(() => { runSettled = true; }, () => { runSettled = true; });
    try {
      await entered; assert.equal(agent.cancel(String(session.id)), true);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(runSettled, false); assert.equal(observerFinished, false); await assert.rejects(competitor.lease(String(session.id)), { name: "BlockingIOError" });
      assert.equal(existsSync(join(s.workspace, "a.txt")), false);
      finish(); await pending;
      assert.equal(observerFinished, true); assert.equal(runSettled, true); assert.equal(laterObserver, 0);
      assert.equal((await store.load(String(session.id))).checkpoint_saved, true); assert.equal(session.status, "stopped");
      assert.equal(existsSync(join(s.workspace, "a.txt")), false);
      const lease = await competitor.lease(String(session.id)); await lease.release();
    } finally { finish(); await pending.catch(() => {}); await s.close(); }
  });
});
