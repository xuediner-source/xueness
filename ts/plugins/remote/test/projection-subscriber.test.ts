import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ProjectionSubscriber } from "../src/projection-subscriber.ts";

const EPOCH = "0123456789abcdef0123456789abcdef";

function fakeRequest(handlers: Record<string, (params: Record<string, unknown>) => unknown>) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const request = async (method: string, params: Record<string, unknown>) => {
    calls.push({ method, params });
    const handler = handlers[method];
    if (!handler) throw new Error(`unexpected ${method}`);
    return handler(params);
  };
  return { request, calls };
}

describe("ProjectionSubscriber (F11.03)", () => {
  it("readies a conversation subscription and advances contiguous frames without gaps", async () => {
    const frames: unknown[] = [];
    const { request, calls } = fakeRequest({
      "conversation/subscribe": () => ({ accepted: true, subscriptionId: "sub-1", topic: "conversation:s1", generation: 1 }),
    });
    const sub = new ProjectionSubscriber({ request, onFrame: (f) => frames.push(f) });
    const state = await sub.subscribe("conversation", "s1", { logEpoch: EPOCH, seq: 0 });
    assert.equal(state.ready, true);
    assert.equal(state.subscriptionId, "sub-1");
    assert.equal(calls[0]!.method, "conversation/subscribe");
    sub.ingest("conversation/frame", {
      subscriptionId: "sub-1", generation: 1, fromSeq: 0, toSeq: 2, delivery: "online",
      envelope: { logEpoch: EPOCH },
    });
    assert.equal(sub.cursor("sub-1")!.seq, 2);
    assert.equal(sub.states()[0]!.gaps, 0);
    assert.equal(frames.length, 1);
  });

  it("detects a sequence hole and resyncs from the last committed cursor", async () => {
    let generation = 1;
    const { request } = fakeRequest({
      "conversation/subscribe": () => ({ accepted: true, subscriptionId: "sub-2", topic: "conversation:s2", generation: 1 }),
      "conversation/resync": (params) => {
        generation += 1;
        assert.equal(params.seq, 2);
        assert.equal(params.logEpoch, EPOCH);
        return { accepted: true, subscriptionId: "sub-2", topic: "conversation:s2", generation };
      },
    });
    const sub = new ProjectionSubscriber({ request });
    await sub.subscribe("conversation", "s2", { logEpoch: EPOCH, seq: 0 });
    sub.ingest("conversation/frame", {
      subscriptionId: "sub-2", generation: 1, fromSeq: 0, toSeq: 2, envelope: { logEpoch: EPOCH },
    });
    sub.ingest("conversation/frame", {
      subscriptionId: "sub-2", generation: 1, fromSeq: 5, toSeq: 6, envelope: { logEpoch: EPOCH },
    });
    await new Promise((r) => setTimeout(r, 20));
    const state = sub.states()[0]!;
    assert.equal(state.gaps, 1);
    assert.ok(state.resyncs >= 1);
    assert.equal(state.ready, true);
    assert.equal(state.generation, 2);
  });

  it("requires runId for workflow subscriptions and preserves afterSeq cursor", async () => {
    const { request } = fakeRequest({
      "workflow/subscribe": (params) => {
        assert.equal(params.runId, "run-9");
        assert.equal(params.afterSeq, 3);
        return { accepted: true, subscriptionId: "wf-1", topic: "workflow:run-9", generation: 1 };
      },
    });
    const sub = new ProjectionSubscriber({ request });
    await assert.rejects(() => sub.subscribe("workflow", null, {}), /runId/);
    const state = await sub.subscribe("workflow", null, { afterSeq: 3 }, "run-9");
    assert.equal(state.seq, 3);
    assert.deepEqual(sub.cursor("wf-1"), { afterSeq: 3 });
  });

  it("reattach clears READY until the next subscribe/resync on the new transport", async () => {
    const { request } = fakeRequest({
      "controller/subscribe": () => ({ accepted: true, subscriptionId: "c1", topic: "controller", generation: 1 }),
    });
    const sub = new ProjectionSubscriber({ request });
    await sub.subscribe("controller", null);
    assert.equal(sub.states()[0]!.ready, true);
    sub.reattach(request);
    assert.equal(sub.states()[0]!.ready, false);
  });
});
