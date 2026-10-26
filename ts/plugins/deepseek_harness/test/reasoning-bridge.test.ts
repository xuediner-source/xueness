/** H01.04: reasoning_content / reasoning_effort bridging across OpenAI and Anthropic wires. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  anthropicThinkingFields,
  createReasoningDeltaTracker,
  EFFORT_BUDGET_TOKENS,
  effortForBudgetTokens,
  normalizeReasoningEffort,
  openAIReasoningFields,
  REASONING_EFFORTS,
  roundTripOpenAI,
  toAnthropicMessages,
  toOpenAIMessages,
  type AnthropicChatMessage,
  type OpenAIChatMessage,
} from "../src/reasoning-bridge.ts";

describe("effort ladder", () => {
  it("accepts exactly low|medium|high|max, case-insensitively", () => {
    assert.deepEqual([...REASONING_EFFORTS], ["low", "medium", "high", "max"]);
    assert.equal(normalizeReasoningEffort("HIGH"), "high");
    assert.equal(normalizeReasoningEffort(" max "), "max");
    assert.equal(normalizeReasoningEffort("ultra"), null);
    assert.equal(normalizeReasoningEffort(""), null);
    assert.equal(normalizeReasoningEffort(3), null);
  });

  it("emits the request field for each wire", () => {
    for (const effort of REASONING_EFFORTS) {
      assert.deepEqual(openAIReasoningFields(effort), { reasoning_effort: effort });
      const anthropic = anthropicThinkingFields(effort);
      assert.equal(anthropic.thinking.type, "enabled");
      assert.equal(anthropic.thinking.budget_tokens, EFFORT_BUDGET_TOKENS[effort]);
    }
  });

  it("keeps budgets monotonic and maps budgets back to efforts", () => {
    assert.ok(EFFORT_BUDGET_TOKENS.low < EFFORT_BUDGET_TOKENS.medium);
    assert.ok(EFFORT_BUDGET_TOKENS.medium < EFFORT_BUDGET_TOKENS.high);
    assert.ok(EFFORT_BUDGET_TOKENS.high < EFFORT_BUDGET_TOKENS.max);
    assert.equal(effortForBudgetTokens(EFFORT_BUDGET_TOKENS.max), "max");
    assert.equal(effortForBudgetTokens(EFFORT_BUDGET_TOKENS.low), "low");
    assert.equal(effortForBudgetTokens(EFFORT_BUDGET_TOKENS.low + 1), "low", "between rungs rounds down to the cheaper effort");
    assert.equal(effortForBudgetTokens(EFFORT_BUDGET_TOKENS.low - 1), null);
    assert.equal(effortForBudgetTokens(0), null);
    assert.equal(effortForBudgetTokens("4096"), null);
  });
});

describe("message conversion", () => {
  it("moves assistant reasoning_content into a leading thinking block", () => {
    const converted = toAnthropicMessages([
      { role: "assistant", content: "answer", reasoning_content: "because" },
    ] as readonly OpenAIChatMessage[]);
    assert.deepEqual(converted, [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "because" },
          { type: "text", text: "answer" },
        ],
      },
    ] satisfies AnthropicChatMessage[]);
  });

  it("keeps reasoning-only assistant messages and empty content shapes representable", () => {
    assert.deepEqual(
      toAnthropicMessages([{ role: "assistant", content: null, reasoning_content: "only reasoning" }]),
      [{ role: "assistant", content: [{ type: "thinking", thinking: "only reasoning" }] }],
    );
    assert.deepEqual(toAnthropicMessages([{ role: "assistant", content: null }]), [{ role: "assistant", content: [{ type: "text", text: "" }] }]);
    assert.deepEqual(
      toAnthropicMessages([{ role: "assistant", content: "plain", reasoning_content: "" }]),
      [{ role: "assistant", content: [{ type: "text", text: "plain" }] }],
      "empty reasoning_content produces no thinking block",
    );
  });

  it("passes user turns through and maps system/tool turns onto the user role", () => {
    const converted = toAnthropicMessages([
      { role: "user", content: "question" },
      { role: "system", content: "policy" },
      { role: "tool", content: "42" },
    ]);
    assert.deepEqual(
      converted,
      [
        { role: "user", content: "question" },
        { role: "user", content: "policy" },
        { role: "user", content: "42" },
      ] satisfies AnthropicChatMessage[],
    );
  });

  it("extracts reasoning_content back out of thinking blocks", () => {
    const converted = toOpenAIMessages([
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "step one", signature: "sig" },
          { type: "text", text: "answer one" },
        ],
      },
      { role: "user", content: "thanks" },
    ]);
    assert.deepEqual(converted, [
      { role: "assistant", content: "answer one", reasoning_content: "step one" },
      { role: "user", content: "thanks" },
    ] satisfies OpenAIChatMessage[]);
  });

  it("joins multiple thinking or text blocks with a blank line, in order", () => {
    const converted = toOpenAIMessages([
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "part 1" },
          { type: "text", text: "interlude" },
          { type: "thinking", thinking: "part 2" },
          { type: "text", text: "final" },
        ],
      },
    ]);
    assert.deepEqual(converted, [{ role: "assistant", content: "interlude\n\nfinal", reasoning_content: "part 1\n\npart 2" }]);
  });

  it("keeps a string-content assistant message without inventing reasoning", () => {
    assert.deepEqual(toOpenAIMessages([{ role: "assistant", content: "hi" }]), [{ role: "assistant", content: "hi" }]);
  });

  it("keeps an empty assistant content string distinct from a missing one", () => {
    assert.deepEqual(roundTripOpenAI([{ role: "assistant", content: "" }]), [{ role: "assistant", content: "" }]);
    assert.deepEqual(
      roundTripOpenAI([{ role: "assistant", content: "", reasoning_content: "thought" }]),
      [{ role: "assistant", content: "", reasoning_content: "thought" }],
      "an empty answer next to reasoning must not degrade into content: null",
    );
    assert.deepEqual(
      roundTripOpenAI([{ role: "assistant", content: null, reasoning_content: "thought" }]),
      [{ role: "assistant", content: null, reasoning_content: "thought" }],
      "a reasoning-only turn stays content: null",
    );
  });
});

describe("multi-turn round trip", () => {
  const conversation: readonly OpenAIChatMessage[] = [
    { role: "user", content: "first question" },
    { role: "assistant", content: "first answer", reasoning_content: "first reasoning\nwith a newline and 中文 reasoning" },
    { role: "user", content: "second question" },
    { role: "assistant", content: null, reasoning_content: "second turn thinks at length … and stays intact" },
    { role: "user", content: "third question" },
    { role: "assistant", content: "third answer", reasoning_content: "third reasoning" },
  ];

  it("is lossless for reasoning_content, content, roles and order across turns", () => {
    assert.deepEqual(roundTripOpenAI(conversation), conversation);
  });

  it("is lossless for long adversarial reasoning text", () => {
    const tricky = "line\n\nwith blank lines\n\n\ttabs <tag> \"quotes\" \\backslash\\ é你好 𝄞";
    const round = roundTripOpenAI([{ role: "assistant", content: "c", reasoning_content: tricky }]);
    assert.equal(round[0]?.reasoning_content, tricky);
  });

  it("is deterministic: converting twice yields the same intermediate wire form", () => {
    assert.deepEqual(toAnthropicMessages(conversation), toAnthropicMessages(roundTripOpenAI(conversation)));
  });
});

describe("streaming deltas", () => {
  it("assembles reasoning and content from OpenAI-shaped deltas", () => {
    const tracker = createReasoningDeltaTracker();
    tracker.push({ wire: "openai", reasoning_content: "think " });
    tracker.push({ wire: "openai", reasoning_content: "hard" });
    tracker.push({ wire: "openai", content: "ans" });
    tracker.push({ wire: "openai", content: "wer" });
    assert.equal(tracker.reasoning(), "think hard");
    assert.equal(tracker.content(), "answer");
  });

  it("assembles reasoning and content from Anthropic-shaped deltas", () => {
    const tracker = createReasoningDeltaTracker();
    tracker.push({ wire: "anthropic", type: "thinking_delta", text: "deci" });
    tracker.push({ wire: "anthropic", type: "text_delta", text: "out" });
    tracker.push({ wire: "anthropic", type: "thinking_delta", text: "de" });
    tracker.push({ wire: "anthropic", type: "text_delta", text: "put" });
    tracker.push({ wire: "anthropic", type: "thinking_delta", text: "" });
    assert.equal(tracker.reasoning(), "decide");
    assert.equal(tracker.content(), "output");
  });
});
