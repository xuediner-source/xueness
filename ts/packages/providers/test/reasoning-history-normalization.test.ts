import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  matchesThinkingSignatureRejection,
  normalizeReasoningHistory,
  repairReasoningHistoryAfterSignatureRejection,
} from "../src/reasoning-history-normalization.ts";

const signed = (text = "private thought") => ({
  type: "reasoning",
  text,
  providerOptions: { anthropic: { signature: "signed-value" } },
});

describe("reasoning history normalization", () => {
  it("drops signed reasoning across provider or model changes but preserves exact identity", () => {
    const source = [
      { role: "assistant", providerId: "anthropic", modelId: "claude-sonnet", content: [signed(), { type: "text", text: "kept" }] },
      { role: "assistant", providerId: "other", modelId: "claude-sonnet", content: [signed(), { type: "text", text: "provider changed" }] },
      { role: "assistant", providerId: "anthropic", modelId: "claude-opus", content: [signed(), { type: "text", text: "model changed" }] },
    ];
    const original = structuredClone(source);
    const result = normalizeReasoningHistory(source, { providerId: "anthropic", modelId: "claude-sonnet" });

    assert.deepEqual(result.map((message) => message.content), [
      [signed(), { type: "text", text: "kept" }],
      [{ type: "text", text: "provider changed" }],
      [{ type: "text", text: "model changed" }],
    ]);
    assert.deepEqual(source, original);
  });

  it("removes orphan reasoning, preserves tool calls, trims the final reasoning tail, and fills internal empty assistants", () => {
    const messages = [
      { role: "assistant", content: [signed()] },
      { role: "assistant", content: [signed()], tool_calls: [{ id: "call-1" }] },
      { role: "assistant", content: [] },
      { role: "user", content: "continue" },
      { role: "assistant", content: [{ type: "text", text: "answer" }, signed()] },
    ];
    const result = normalizeReasoningHistory(messages);

    assert.deepEqual(result, [
      { role: "assistant", content: [signed()], tool_calls: [{ id: "call-1" }] },
      { role: "assistant", content: [{ type: "text", text: "(no content)" }] },
      { role: "user", content: "continue" },
      { role: "assistant", content: [{ type: "text", text: "answer" }] },
    ]);
    assert.deepEqual(messages[0]?.content, [signed()]);
  });

  it("merges only eligible users after empty assistant removal and honors media/tool-result boundaries", () => {
    const first = { role: "user", content: "one" };
    const mediaBound = { role: "user", content: "media-bound", mediaRefs: ["ref-1"] };
    const afterMedia = { role: "user", content: "after media" };
    const toolResult = { role: "user", content: "tool result", toolCallId: "call-2", toolName: "read" };
    const messages = [
      first,
      { role: "assistant", content: [{ type: "text", text: "  " }] },
      { role: "user", content: "middle" },
      { role: "assistant", content: [{ type: "text", text: "(no content)" }] },
      mediaBound,
      afterMedia,
      { role: "assistant", content: [{ type: "text", text: "\n" }] },
      toolResult,
      { role: "assistant", content: [{ type: "text", text: " " }] },
      { role: "user", content: "after tool result" },
    ];
    const result = normalizeReasoningHistory(messages, undefined, (message) => message.mediaRefs !== undefined);

    assert.deepEqual(result, [
      { role: "user", content: [{ type: "text", text: "one\n" }, { type: "text", text: "middle" }] },
      mediaBound,
      afterMedia,
      toolResult,
      { role: "user", content: "after tool result" },
    ]);
    assert.equal(result[1], mediaBound);
    assert.equal(result[3], toolResult);
  });

  it("matches narrow 400 wording and repairs signed history once without structural passes or message reads", () => {
    assert.equal(matchesThinkingSignatureRejection(400, "signature in thinking block is invalid"), true);
    assert.equal(matchesThinkingSignatureRejection(400, { message: "thinking block cannot be modified" }), true);
    assert.equal(matchesThinkingSignatureRejection(400, "redacted_thinking has invalid signature"), true);
    assert.equal(matchesThinkingSignatureRejection(400, "thinking block is unsupported"), false);
    assert.equal(matchesThinkingSignatureRejection(401, "signature in thinking block"), false);

    const messages = [
      { role: "user", content: "first" },
      { role: "assistant", content: [{ type: "text", text: "  " }] },
      { role: "user", content: "middle" },
      { role: "assistant", content: [{ type: "reasoning", text: "secret", providerOptions: { anthropic: { redactedData: "opaque" } } },
        { type: "text", text: "  " }] },
      { role: "user", content: "second" },
      { role: "assistant", content: [{ type: "reasoning", text: "keep", providerOptions: { anthropic: {} } }] },
    ];
    const original = structuredClone(messages);
    const error = {
      statusCode: 400,
      reasoningSignatureRejected: true,
      get message(): never { throw new Error("raw remote message must not be read"); },
    };
    const repaired = repairReasoningHistoryAfterSignatureRejection(messages, error);

    assert.deepEqual(repaired, [
      messages[0],
      messages[1],
      messages[2],
      { role: "assistant", content: [{ type: "text", text: "[Thinking removed]" }] },
      messages[4],
      messages[5],
    ]);
    assert.deepEqual(messages, original);
    assert.equal(repairReasoningHistoryAfterSignatureRejection(repaired!, error), undefined);
    assert.equal(repairReasoningHistoryAfterSignatureRejection(messages, { status: 400 }), undefined);
  });
});
