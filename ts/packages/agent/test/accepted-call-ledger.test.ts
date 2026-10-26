import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ToolSnapshot } from "@xueness/providers";
import { AcceptedCallLedger, loadAcceptedCallProjection, settleStreamToolCalls } from "../src/accepted-call-ledger.ts";
import { settleAcceptedStreamCalls } from "../src/execution-selection.ts";
import { RequestStream } from "../src/stream.ts";
import type { AgentContext, AgentProvider, Row } from "../src/index.ts";
import { call, fixture } from "./fixtures.ts";
import { hydrateSessionToolHistory } from "../../../plugins/sessions/src/history-hydration.ts";

const snapshot = (index: number, callId: string): ToolSnapshot => ({ index, call_id: callId, name: "read", partial_input: "{", input_chars: 1, truncated: false });

function makeStream() {
  const session: Row = {};
  const context = { session, signal: new AbortController().signal, options: {}, async save() {}, emit() {} } as unknown as AgentContext;
  return new RequestStream(context, false);
}

describe("AcceptedCallLedger exactly-once settlement", () => {
  it("accept is idempotent by callId and settlement happens at most once", () => {
    const ledger = new AcceptedCallLedger();
    const first = ledger.accept("s1", "t1", [{ id: "c1", name: "read" }]);
    const second = ledger.accept("s1", "t1", [{ id: "c1", name: "read" }]);
    assert.equal(first.length, 1);
    assert.equal(second[0]!.status, "accepted");
    assert.equal(ledger.settle("c1", "settled_executed", "completed"), true);
    assert.equal(ledger.settle("c1", "settled_interrupted", "cancelled"), false, "a settled record never settles again");
    assert.equal(ledger.settle("c1", "settled_executed", "completed"), false);
    assert.equal(ledger.recordOf("c1")!.status, "settled_executed");
  });
  it("the durable projection merges by callId and keeps terminal statuses immutable", () => {
    const ledger = new AcceptedCallLedger();
    const session: Row = {};
    ledger.accept("s1", "t1", [{ id: "c1", name: "read" }]);
    ledger.project(session);
    ledger.settle("c1", "settled_interrupted", "cancelled");
    ledger.project(session);
    const projection = session.accepted_tool_calls as Row[];
    assert.equal(projection.length, 1);
    assert.equal(projection[0]!.status, "settled_interrupted");
    // A second ledger replaying the same call cannot rewrite the terminal status.
    const replay = new AcceptedCallLedger();
    replay.accept("s9", "t9", [{ id: "c1", name: "read" }]);
    replay.settle("c1", "settled_executed", "completed");
    replay.project(session);
    assert.equal((session.accepted_tool_calls as Row[])[0]!.status, "settled_interrupted");
    assert.equal((session.accepted_tool_calls as Row[]).length, 1);
    assert.deepEqual(loadAcceptedCallProjection(session).map((record) => record.callId), ["c1"]);
  });
  it("settleAll settles only that stream's accepted calls", () => {
    const ledger = new AcceptedCallLedger();
    ledger.accept("s1", "t1", [{ id: "c1", name: "read" }, { id: "c2", name: "write" }]);
    ledger.accept("s2", "t1", [{ id: "c3", name: "read" }]);
    assert.equal(ledger.settleAll("s1", "settled_interrupted", "execution_fallback"), 2);
    assert.equal(ledger.recordOf("c3")!.status, "accepted");
    assert.equal(ledger.settleAll("s1", "settled_interrupted", "execution_fallback"), 0, "replay settles nothing");
    assert.deepEqual(ledger.acceptedPending().map((record) => record.callId), ["c3"]);
  });
});

describe("settleStreamToolCalls recovery boundaries", () => {
  it("a committed stream settles its accepted calls interrupted; prelude fragments of an uncommitted stream are discarded and never executed", () => {
    const ledger = new AcceptedCallLedger();
    const committed = settleStreamToolCalls({
      streamId: "s1", turnId: "t1", committed: true,
      acceptedCalls: [{ id: "c1", name: "read" }], preludeFragments: [],
      cause: "execution_fallback", ledger,
    });
    assert.deepEqual(committed, { accepted: 1, executed: 0, interrupted: 1, discarded: 0 });
    assert.equal(ledger.recordOf("c1")!.status, "settled_interrupted");
    const uncommitted = settleStreamToolCalls({
      streamId: "s2", turnId: "t1", committed: false,
      acceptedCalls: [], preludeFragments: [{ id: "p1", name: "read" }, { name: "read" }],
      cause: "model_interrupt", ledger,
    });
    assert.deepEqual(uncommitted, { accepted: 0, executed: 0, interrupted: 0, discarded: 2 });
    assert.ok(ledger.records().every((record) => record.callId !== "p1" || record.status === "discarded_prelude"));
    assert.equal(ledger.acceptedPending().length, 0, "nothing discarded ever reaches execution");
    assert.deepEqual(settleStreamToolCalls({ streamId: null, turnId: "t1", committed: false, acceptedCalls: [], preludeFragments: [], cause: "cancelled", ledger }),
      { accepted: 0, executed: 0, interrupted: 0, discarded: 0 }, "no stream settles nothing");
  });
  it("replaying the same boundary changes nothing (idempotent across interrupt/switch/cancel)", () => {
    const ledger = new AcceptedCallLedger();
    const session: Row = {};
    const input = { streamId: "s1", turnId: "t1", committed: true, acceptedCalls: [{ id: "c1", name: "read" }], preludeFragments: [], ledger, session } as const;
    settleStreamToolCalls({ ...input, cause: "model_interrupt" });
    const again = settleStreamToolCalls({ ...input, cause: "cancelled" });
    assert.equal(again.interrupted, 0);
    assert.equal((session.accepted_tool_calls as Row[]).length, 1);
  });
  it("replaying a discarded prelude reports nothing new, like settlement does", () => {
    const ledger = new AcceptedCallLedger();
    const input = { streamId: "s1", turnId: "t1", committed: false, acceptedCalls: [], preludeFragments: [{ id: "p1" }, { name: "read" }], ledger } as const;
    assert.equal(settleStreamToolCalls({ ...input, cause: "model_interrupt" }).discarded, 2);
    assert.equal(settleStreamToolCalls({ ...input, cause: "cancelled" }).discarded, 0, "a replayed boundary discards nothing new");
    assert.equal(ledger.records().length, 2, "the fragments are still recorded exactly once");
  });
});

describe("RequestStream accepted vs discarded prelude tracking", () => {
  it("a committed stream exposes accepted calls from both prelude and response", () => {
    const stream = makeStream();
    const observers = stream.observers();
    observers.onToolDelta?.(snapshot(0, "prelude-call"));
    observers.onDelta?.("body text");
    stream.accept({ tool_calls: [call("response-call")] });
    assert.deepEqual(stream.acceptedToolCalls().map((entry) => entry.id), ["prelude-call", "response-call"]);
    assert.deepEqual(stream.discardedPreludeFragments(), []);
  });
  it("an unaccepted prelude is discarded and tracked, including at interrupt time", async () => {
    const discarded = makeStream();
    discarded.observers().onToolDelta?.(snapshot(0, "gone-call"));
    discarded.accept({ content: "text only" });
    assert.deepEqual(discarded.discardedPreludeFragments().map((fragment) => fragment.id), ["gone-call"]);
    assert.deepEqual(discarded.acceptedToolCalls(), []);

    const interrupted = makeStream();
    interrupted.observers().onToolDelta?.(snapshot(0, "cut-call"));
    await interrupted.interrupt();
    assert.equal(interrupted.committed, false);
    assert.deepEqual(interrupted.discardedPreludeFragments().map((fragment) => fragment.id), ["cut-call"]);
  });
});

describe("execution fallback settlement uses the ledger", () => {
  it("settleAcceptedStreamCalls settles accepted calls exactly once at the fallback boundary", async () => {
    const stream = makeStream();
    const observers = stream.observers();
    observers.onToolDelta?.(snapshot(0, "accepted-call"));
    observers.onDelta?.("partial");
    const ledger = new AcceptedCallLedger();
    const session: Row = {};
    await settleAcceptedStreamCalls(stream, new Error("provider 500"), { ledger, session, turnId: "t1" });
    assert.equal(ledger.recordOf("accepted-call")!.status, "settled_interrupted");
    assert.equal(ledger.recordOf("accepted-call")!.cause, "execution_fallback");
    assert.equal((session.accepted_tool_calls as Row[]).length, 1);
    assert.equal(stream.record.status, "interrupted");
  });
});

describe("driver and cold-resume durability", () => {
  it("executed accepted calls settle executed and project durably", async () => {
    const local = fixture([{ tool_calls: [call("exec-1")] }, { content: "done" }], [{ ok: true, output: "ok" }]);
    try {
      await local.runner.run(local.session);
      const projection = loadAcceptedCallProjection(local.session as Row);
      const record = projection.find((entry) => entry.callId === "exec-1");
      assert.ok(record, "accepted call recorded");
      assert.equal(record!.status, "settled_executed");
    } finally { local.close(); }
  });
  it("a cancelled run settles its accepted calls interrupted", async () => {
    const controller = new AbortController();
    const provider: AgentProvider = {
      async complete() { throw new Error("stream expected"); },
      async stream() { controller.abort(); throw new Error("cancelled during stream"); },
    };
    const local = fixture([], [], { provider, signal: controller.signal } as never);
    try {
      await assert.rejects(() => local.runner.run(local.session));
      const projection = loadAcceptedCallProjection(local.session as Row);
      assert.ok(projection.every((record) => record.status !== "settled_executed"));
    } finally { local.close(); }
  });
  it("cold resume hydrates interrupted settlements without duplicating journal rows", () => {
    const session: Row = {
      id: "a".repeat(32),
      messages: [{ role: "assistant", content: "", tool_calls: [call("resume-1"), call("resume-2")] }],
      results: { "resume-2": { ok: true, output: "already ran" } },
    };
    const first = hydrateSessionToolHistory(session);
    assert.equal(first.restored, 1);
    assert.equal(first.interrupted, 1);
    const rows = (session.messages as Row[]).filter((message) => message.role === "tool");
    assert.equal(rows.length, 2, "one tool row per call");
    const projection = loadAcceptedCallProjection(session);
    assert.equal(projection.find((record) => record.callId === "resume-1")!.status, "settled_interrupted");
    assert.equal(projection.find((record) => record.callId === "resume-2")!.status, "settled_executed");
    // Re-hydrating the same session never duplicates rows or rewrites settlement.
    const second = hydrateSessionToolHistory(session);
    assert.equal(second.restored, 0, "both rows already exist, nothing re-adds");
    assert.equal(second.interrupted, 0);
    assert.equal((session.messages as Row[]).filter((message) => message.role === "tool").length, 2);
    assert.equal(loadAcceptedCallProjection(session).find((record) => record.callId === "resume-1")!.status, "settled_interrupted");
    assert.equal(loadAcceptedCallProjection(session).length, 2);
  });
});
