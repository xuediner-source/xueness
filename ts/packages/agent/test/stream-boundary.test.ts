import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ToolSnapshot } from "@xueness/providers";
import { RequestStream } from "../src/stream.ts";
import type { AgentContext, Row } from "../src/types.ts";

const snapshot = (index: number, callId: string, partialInput: string): ToolSnapshot => ({
  index, call_id: callId, name: "read", partial_input: partialInput, input_chars: partialInput.length, truncated: false,
});

function makeStream(showReasoning: boolean) {
  const session: Row = {};
  const events: Row[] = [];
  const order: string[] = [];
  const observedTools: ToolSnapshot[] = [];
  const observedDeltas: Array<[string, boolean]> = [];
  const context = {
    session, signal: new AbortController().signal, options: {},
    async save() {}, emit: (event: Row) => { events.push(event); },
  } as unknown as AgentContext;
  const stream = new RequestStream(context, showReasoning, undefined,
    (text, reasoning) => { order.push(reasoning ? "reasoning" : "text"); observedDeltas.push([text, reasoning]); },
    (tool) => { order.push(`tool:${String(tool.call_id)}`); observedTools.push(tool); context.session.tool_activity = tool; });
  return { stream, session, events, order, observedTools, observedDeltas };
}

describe("RequestStream commit boundary", () => {
  it("keeps tool snapshots private on failed or interrupted attempts and drops them for an empty response", async () => {
    const failed = makeStream(true);
    const failedObservers = failed.stream.observers();
    failedObservers.onToolDelta?.(snapshot(0, "failed", "{"));
    failedObservers.onToolDelta?.(snapshot(0, "failed", "{\"path\":"));
    assert.equal(failed.stream.committed, false);
    assert.deepEqual(failed.observedTools, []);
    assert.equal(failed.session.tool_activity, undefined);
    await failed.stream.finish(null, true);
    assert.deepEqual(failed.observedTools, []);
    assert.equal(failed.session.tool_activity, undefined);

    const interrupted = makeStream(true);
    interrupted.stream.observers().onToolDelta?.(snapshot(1, "interrupted", "{"));
    await interrupted.stream.interrupt();
    assert.deepEqual(interrupted.observedTools, []);
    assert.equal(interrupted.session.tool_activity, undefined);

    const empty = makeStream(true);
    empty.stream.observers().onToolDelta?.(snapshot(2, "empty", "{"));
    empty.stream.accept({ content: "" });
    empty.stream.observers().onDelta?.("later text");
    assert.equal(empty.stream.committed, true);
    assert.deepEqual(empty.observedTools, []);
    assert.equal(empty.session.tool_activity, undefined);
  });

  it("flushes the ordered prelude before nonempty body or reasoning, while empty deltas do not commit", () => {
    const body = makeStream(true);
    const bodyObservers = body.stream.observers();
    bodyObservers.onDelta?.("");
    bodyObservers.onReasoningDelta?.("");
    bodyObservers.onToolDelta?.(snapshot(0, "body", "{"));
    assert.equal(body.stream.committed, false);
    bodyObservers.onDelta?.(" ");
    assert.equal(body.stream.committed, true);
    assert.deepEqual(body.order, ["tool:body", "text"]);

    const reasoning = makeStream(true);
    const reasoningObservers = reasoning.stream.observers();
    reasoningObservers.onToolDelta?.(snapshot(0, "reasoning", "{"));
    reasoningObservers.onReasoningDelta?.(" ");
    assert.equal(reasoning.stream.committed, true);
    assert.deepEqual(reasoning.order, ["tool:reasoning", "reasoning"]);
    assert.equal(reasoning.stream.record.reasoning, " ");
  });

  it("uses hidden reasoning as a boundary without retaining it and accepts complete tool calls", () => {
    const hidden = makeStream(false);
    const hiddenObservers = hidden.stream.observers();
    hiddenObservers.onToolDelta?.(snapshot(0, "hidden", "{"));
    hiddenObservers.onReasoningDelta?.("private thought");
    assert.equal(hidden.stream.committed, true);
    assert.equal(hidden.stream.record.reasoning, undefined);
    assert.deepEqual(hidden.observedDeltas, []);
    assert.equal(hidden.events.some((event) => event.type === "reasoning_delta"), false);
    assert.deepEqual(hidden.observedTools.map((tool) => tool.call_id), ["hidden"]);

    const accepted = makeStream(false);
    accepted.stream.observers().onToolDelta?.(snapshot(0, "accepted", "{"));
    accepted.stream.accept({ tool_calls: [{ id: "accepted" }] });
    assert.equal(accepted.stream.committed, true);
    assert.deepEqual(accepted.observedTools.map((tool) => tool.call_id), ["accepted"]);
  });
});
