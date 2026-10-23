import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PyValueError } from "@xueness/contracts";
import { ProviderTransportError } from "../src/errors.ts";
import type { HttpResponse } from "../src/http.ts";
import { ModelStreamIdleTimeoutError } from "../src/stream-idle-timeout.ts";
import { readAnthropicStream } from "../src/anthropic-stream.ts";

type Event = Record<string, unknown>;

function response(events: Event[]): HttpResponse {
  const lines = events.flatMap((event) => [`data: ${JSON.stringify(event)}\n`, "\n"]);
  let offset = 0;
  return {
    async readline(limit: number) {
      const line = lines[offset++];
      return line === undefined ? Buffer.alloc(0) : Buffer.from(line).subarray(0, limit);
    },
    close() {},
  } as unknown as HttpResponse;
}

function stalledResponse(): { response: HttpResponse; closed: () => boolean } {
  let isClosed = false;
  return {
    response: {
      readline: () => new Promise<Buffer>(() => undefined),
      close: () => { isClosed = true; },
    } as unknown as HttpResponse,
    closed: () => isClosed,
  };
}

const start = (index: number, content_block: Event): Event => ({ type: "content_block_start", index, content_block });
const delta = (index: number, value: Event): Event => ({ type: "content_block_delta", index, delta: value });
const stop = (index: number): Event => ({ type: "content_block_stop", index });
const messageStop: Event = { type: "message_stop" };

describe("Anthropic stream compatibility", () => {
  it("does not return unclosed tool blocks and keeps EOF and idle failures", async () => {
    const metadata: Record<string, unknown> = {};
    const unclosed = await readAnthropicStream(
      response([
        { type: "message_start", message: { usage: { input_tokens: 4 } } },
        start(0, { type: "tool_use", id: "call_open", name: "read", input: {} }),
        { type: "message_delta", usage: { output_tokens: 2 }, delta: { stop_reason: "tool_use" } },
        messageStop,
      ]),
      { finishMetadata: metadata, markDelivered() {} },
    );
    assert.deepEqual(unclosed.calls, []);
    assert.deepEqual(unclosed.usage, { input_tokens: 4, prompt_tokens: 4, output_tokens: 2, completion_tokens: 2, total_tokens: 6 });
    assert.equal(metadata["_finish_reason"], "tool_calls");

    await assert.rejects(
      readAnthropicStream(response([{ type: "message_start" }, start(0, { type: "tool_use", id: "call_eof", name: "read", input: {} })]), {
        markDelivered() {},
      }),
      (error: unknown) => error instanceof ProviderTransportError && error.message === "incomplete provider stream",
    );

    const stalled = stalledResponse();
    await assert.rejects(
      readAnthropicStream(stalled.response, { idleTimeoutMs: 5, markDelivered() {} }),
      ModelStreamIdleTimeoutError,
    );
    assert.equal(stalled.closed(), true);
  });

  it("closes calls only on block stop, ignores repeated stops, and preserves malformed or cut-off arguments", async () => {
    const metadata: Record<string, unknown> = {};
    const result = await readAnthropicStream(response([
      { type: "message_start" },
      start(0, { type: "tool_use", id: "call_closed", name: "read", input: {} }),
      delta(0, { type: "input_json_delta", partial_json: "{\"path\":\"a\"}" }),
      stop(0), stop(0),
      start(1, { type: "tool_use", id: "call_bad_json", name: "read", input: {} }),
      delta(1, { type: "input_json_delta", partial_json: "{bad" }),
      stop(1),
      start(2, { type: "tool_use", id: "call_cut_off", name: "read", input: {} }),
      delta(2, { type: "input_json_delta", partial_json: "{bad" }),
      stop(2),
      start(3, { type: "tool_use", id: "call_duplicate_keys", name: "read", input: {} }),
      delta(3, { type: "input_json_delta", partial_json: "{\"path\":1,\"path\":2}" }),
      stop(3),
      start(4, { type: "tool_use", id: "call_false", name: "read", input: false }),
      stop(4),
      { type: "message_delta", delta: { stop_reason: "tool_use" } },
      messageStop,
    ]), { finishMetadata: metadata, markDelivered() {} });

    assert.deepEqual(result.calls, [{
      id: "call_closed", type: "function", function: { name: "read", arguments: "{\"path\": \"a\"}" },
    }, {
      id: "call_bad_json", type: "function", function: { name: "read", arguments: "{bad" },
    }, {
      id: "call_cut_off", type: "function", function: { name: "read", arguments: "{bad" },
    }, {
      id: "call_duplicate_keys", type: "function", function: { name: "read", arguments: "{\"path\":1,\"path\":2}" },
    }, {
      id: "call_false", type: "function", function: { name: "read", arguments: "false" },
    }]);

    const cutOff = await readAnthropicStream(response([
      { type: "message_start" },
      start(0, { type: "tool_use", id: "call_truncated", name: "read", input: {} }),
      delta(0, { type: "input_json_delta", partial_json: "{bad" }),
      stop(0),
      { type: "message_delta", delta: { stop_reason: "max_tokens" } },
      messageStop,
    ]), { finishMetadata: {}, markDelivered() {} });
    assert.deepEqual(cutOff.calls, []);
  });

  it("rejects repeated and conflicting tool call identities", async () => {
    const cases: Event[][] = [
      [start(0, { type: "tool_use", id: "same", name: "read", input: {} }), start(0, { type: "tool_use", id: "other", name: "write", input: {} })],
      [start(0, { type: "tool_use", id: "same", name: "read", input: {} }), start(1, { type: "tool_use", id: "same", name: "read", input: {} })],
    ];
    for (const calls of cases) {
      await assert.rejects(
        readAnthropicStream(response([{ type: "message_start" }, ...calls, messageStop]), { markDelivered() {} }),
        PyValueError,
      );
    }
  });

  it("keeps the final native signature source and only persists signed or redacted reasoning", async () => {
    const reasoning: unknown[] = [];
    const metadata: Record<string, unknown> = {};
    await readAnthropicStream(response([
      { type: "message_start" },
      start(0, { type: "thinking", thinking: "start ", signature: "start-signature" }),
      delta(0, { type: "thinking_delta", thinking: "body" }),
      delta(0, { type: "signature_delta", signature: "native-" }),
      delta(0, { type: "signature_delta", signature: "signature" }),
      stop(0),
      start(1, { type: "reasoning", text: "unsigned" }),
      delta(1, { type: "reasoning_delta", reasoning: " only display" }),
      stop(1),
      start(2, { type: "redacted_thinking", data: "opaque" }),
      stop(2), messageStop,
    ]), { finishMetadata: metadata, markDelivered() {}, onReasoningDelta: (value) => reasoning.push(value) });

    assert.deepEqual(reasoning, ["start ", "body", "unsigned", " only display"]);
    assert.deepEqual(metadata["_reasoning_blocks"], [
      { type: "thinking", thinking: "start body", signature: "native-signature" },
      { type: "redacted_thinking", data: "opaque" },
    ]);
  });

  it("suppresses tool-result indexes through stop and clears suppression at a new message start", async () => {
    const toolSnapshots: unknown[] = [];
    const result = await readAnthropicStream(response([
      { type: "message_start" },
      start(0, { type: "tool_result", tool_use_id: "internal" }),
      delta(0, { type: "input_json_delta", partial_json: "{}" }),
      delta(0, { type: "text_delta", text: "hidden" }),
      stop(0),
      { type: "message_start" },
      start(0, { type: "tool_use", id: "call_visible", name: "read", input: {} }),
      delta(0, { type: "input_json_delta", partial_json: "{}" }),
      stop(0), messageStop,
    ]), { markDelivered() {}, onToolDelta: (snapshot) => toolSnapshots.push(snapshot) });

    assert.equal(result.text, "");
    assert.deepEqual(result.calls, [{
      id: "call_visible", type: "function", function: { name: "read", arguments: "{}" },
    }]);
    assert.deepEqual(toolSnapshots, [
      { index: 0, call_id: "call_visible", name: "read", partial_input: "", input_chars: 0, truncated: false },
      { index: 0, call_id: "call_visible", name: "read", partial_input: "{}", input_chars: 2, truncated: false },
    ]);
  });
});
