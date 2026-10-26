/** Cases ported from ZCode v3.15.1 (aac4755, Apache-2.0) core/tests/compact-policy.test.ts, microcompact.test.ts and compact selection/prompt tests. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildCompactPrompt, buildCompactSummaryMessage, capCompactSummaryMaxOutputTokens, COMPACT_PROMPT_TOO_LONG_RETRY_MARKER, countPrefixMessages, DEFAULT_AUTOCOMPACT_OUTPUT_RESERVE_TOKENS,
  estimateMessageTokens, formatCompactSummary, getAutoCompactOutputReserveTokens, getAutoCompactThreshold, getEffectiveContextWindowSize, getPromptTooLongTokenGap,
  hasEnoughMessagesToCompact, isModelContextExceededError, lookupModelLimits, MAX_OUTPUT_TOKENS_FOR_SUMMARY, maybeLocalMicrocompactMessages, parsePromptTooLongTokenGap,
  resolveModelLimits, selectCompactEntries, selectCompactEntriesAfterPromptTooLong, shouldAutoCompact, truncateForCompactRetry, buildDefaultMicrocompactThreshold, type Row,
} from "../src/index.ts";

const ENOUGH: Row[] = [{ role: "user", content: "old context" }, { role: "assistant", content: "old answer" }];
const read = (id: string): Row => ({ role: "assistant", content: "", tool_calls: [{ id, type: "function", function: { name: "Read", arguments: "{}" } }] });
const tool = (id: string, content: unknown): Row => ({ role: "tool", tool_call_id: id, content });

describe("ZCode auto compact policy", () => {
  it("counts reasoning blocks in the local fallback estimate", () => {
    assert.equal(estimateMessageTokens([{ role: "assistant", content: [{ type: "reasoning", text: "r".repeat(40) }] }]), 14);
    assert.equal(estimateMessageTokens([{ role: "assistant", content: [{ type: "text", text: "text" }, { type: "reasoning", text: "think" }] }]), 4);
    assert.equal(estimateMessageTokens([{ role: "assistant", content: "", reasoning_content: "r".repeat(40) }]), 14);
    assert.equal(estimateMessageTokens([{ role: "assistant", content: "", tool_calls: [{ function: { name: "Read", arguments: "{\"a\":1}" } }] }]), 4);
  });
  it("uses reasoning-inclusive fallback only when provider usage is unavailable", () => {
    const messages: Row[] = [{ role: "user", content: "u" }, { role: "assistant", content: [{ type: "reasoning", text: "r".repeat(4_000) }] }];
    const config = { bufferTokens: 1_000, contextWindow: 3_000, maxOutputTokens: 1_000 };
    const estimate = shouldAutoCompact({ config, messages });
    assert.deepEqual([estimate.estimatedTokenCount, estimate.reason, estimate.shouldCompact, estimate.tokenCount, estimate.tokenSource], [1_335, "above_threshold", true, 1_335, "estimate"]);
    const usage = shouldAutoCompact({ config, messages, tokenOverride: { source: "provider_usage", tokenCount: 999 } });
    assert.deepEqual([usage.estimatedTokenCount, usage.reason, usage.shouldCompact, usage.tokenCount, usage.tokenSource], [1_335, "below_threshold", false, 999, "provider_usage"]);
  });
  it("derives the input-side budget from the output target (21K reserve cap, 13K buffer)", () => {
    const cases: [number, number | undefined, number, number, number][] = [
      [128_000, 32_000, 21_000, 107_000, 94_000], [200_000, 16_000, 16_000, 184_000, 171_000], [200_000, 8_000, 8_000, 192_000, 179_000],
      [128_000, 64_000, 21_000, 107_000, 94_000], [128_000, 16_000, 16_000, 112_000, 99_000], [200_000, undefined, 21_000, 179_000, 166_000],
    ];
    for (const [contextWindow, maxOutputTokens, reserve, effective, threshold] of cases) {
      const config = { contextWindow, ...maxOutputTokens === undefined ? {} : { maxOutputTokens } };
      assert.equal(getAutoCompactOutputReserveTokens(config), reserve); assert.equal(getEffectiveContextWindowSize(config), effective); assert.equal(getAutoCompactThreshold(config), threshold);
    }
    assert.equal(DEFAULT_AUTOCOMPACT_OUTPUT_RESERVE_TOKENS, 32_000); assert.equal(MAX_OUTPUT_TOKENS_FOR_SUMMARY, 20_000);
    assert.equal(getAutoCompactThreshold({}), 166_000);
  });
  it("compacts at exactly the threshold with a fixed 100 percent, and honours the breaker and history minimum", () => {
    const config = { contextWindow: 128_000, maxOutputTokens: 64_000 };
    const at = shouldAutoCompact({ config, messages: ENOUGH, tokenOverride: { source: "provider_usage", tokenCount: 94_000 } });
    assert.deepEqual([at.shouldCompact, at.threshold, at.thresholdPercent, at.effectiveContextWindow, at.outputReserveTokens], [true, 94_000, 100, 107_000, 21_000]);
    assert.equal(shouldAutoCompact({ config, messages: ENOUGH, tokenOverride: { source: "provider_usage", tokenCount: 93_999 } }).shouldCompact, false);
    assert.equal(shouldAutoCompact({ config, messages: ENOUGH, consecutiveFailures: 3, tokenOverride: { source: "provider_usage", tokenCount: 99_000 } }).reason, "circuit_breaker");
    assert.equal(shouldAutoCompact({ config, messages: [{ role: "user", content: "only" }], tokenOverride: { source: "provider_usage", tokenCount: 99_000 } }).reason, "not_enough_messages");
    assert.equal(shouldAutoCompact({ config: { ...config, enabled: false }, messages: ENOUGH }).reason, "disabled");
  });
  it("ignores system prompt and system-reminder rows when judging whether there is history", () => {
    assert.equal(hasEnoughMessagesToCompact([{ role: "system", content: "s" }, { role: "user", content: "<system-reminder>\nx\n</system-reminder>" }, { role: "assistant", content: "a" }]), false);
    assert.equal(hasEnoughMessagesToCompact([{ role: "system", content: "s" }, { role: "system", _compact_summary: true, content: "summary" }, { role: "assistant", content: "a" }]), true);
  });
  it("caps the summary output at 20K or the model maximum", () => {
    assert.equal(capCompactSummaryMaxOutputTokens(undefined), 20_000); assert.equal(capCompactSummaryMaxOutputTokens(64_000), 20_000); assert.equal(capCompactSummaryMaxOutputTokens(8_192), 8_192);
  });
  it("resolves limits from the profile, then the model table, then the 200K default", () => {
    assert.deepEqual(resolveModelLimits({ model: "gpt-5.1", contextWindow: 50_000 }), { contextWindow: 50_000, maxOutputTokens: 128_000, source: "profile" });
    assert.deepEqual(resolveModelLimits({ model: "anthropic/claude-sonnet-4-5" }), { contextWindow: 200_000, maxOutputTokens: 32_000, source: "table" });
    assert.deepEqual(resolveModelLimits({ model: "local-scripted" }), { contextWindow: 200_000, source: "default" });
    assert.equal(lookupModelLimits("deepseek-chat")?.contextWindow, 128_000);
  });
});

describe("ZCode compact prompt", () => {
  it("adds custom instructions between the base prompt and the no-tools trailer", () => {
    const plain = buildCompactPrompt(undefined), custom = buildCompactPrompt("focus on tests");
    assert.ok(plain.startsWith("CRITICAL: Respond with TEXT ONLY. Do NOT call any tools."));
    assert.ok(!plain.includes("Additional Instructions:")); assert.ok(custom.includes("\n\nAdditional Instructions:\nfocus on tests\n\nREMINDER: Do NOT call any tools."));
    assert.equal(buildCompactPrompt("   "), plain);
  });
  it("strips the analysis block and labels the summary", () => {
    assert.equal(formatCompactSummary("<analysis>drafting</analysis>\n\n<summary>\nkept facts\n</summary>"), "Summary:\nkept facts");
    assert.equal(formatCompactSummary("  "), "");
    const message = buildCompactSummaryMessage("<summary>s</summary>", { suppressFollowup: true });
    assert.ok(message.startsWith("This session is being continued from a previous conversation that ran out of context."));
    assert.ok(message.includes("Summary:\ns")); assert.ok(message.includes("\nContinue the conversation from where it left off without asking the user any further questions."));
  });
});

describe("ZCode compact selection", () => {
  const journal: Row[] = [{ role: "system", content: "s" }, { role: "user", content: "task" }, { role: "assistant", content: "a1" }, { role: "user", content: "next" }, { role: "assistant", content: "a2" }, { role: "user", content: "latest" }];
  it("keeps the latest assistant-started round for auto and reactive, none for manual", () => {
    const auto = selectCompactEntries({ messages: journal, trigger: "auto" });
    assert.deepEqual(auto.preserved.map((row) => row.content), ["a2", "latest"]); assert.deepEqual(auto.forSummary.map((row) => row.content), ["s", "task", "a1", "next"]);
    assert.equal(auto.groupsPreserved, 1); assert.equal(auto.totalGroups, 3);
    const manual = selectCompactEntries({ messages: journal, trigger: "manual" });
    assert.equal(manual.preserved.length, 0); assert.equal(manual.forSummary.length, journal.length);
    assert.equal(countPrefixMessages([{ role: "system", _compact_summary: true, content: "x" }]), 0);
  });
  it("moves more rounds into the kept tail when the summary request is too long", () => {
    const long: Row[] = [{ role: "system", content: "s" }, { role: "user", content: "u" }];
    for (let index = 0; index < 6; index += 1) long.push({ role: "assistant", content: `a${index} ` + "x".repeat(300) }, { role: "user", content: `u${index}` });
    const next = selectCompactEntriesAfterPromptTooLong({ messages: long, promptTooLongCause: new Error("prompt is too long: 1200 tokens > 1000 maximum"), trigger: "auto", currentGroupsPreserved: 1 });
    assert.ok(next && next.groupsPreserved === 3, "a 200-token gap moves two ~100-token rounds");
    assert.equal(selectCompactEntriesAfterPromptTooLong({ messages: long, promptTooLongCause: new Error("x"), trigger: "manual", currentGroupsPreserved: 0 }), null);
  });
  it("truncates the oldest rounds for manual retries and marks the cut", () => {
    const long: Row[] = [{ role: "system", content: "s" }];
    for (let index = 0; index < 10; index += 1) long.push({ role: "assistant", content: `a${index}` }, { role: "user", content: `u${index}` });
    const once = truncateForCompactRetry(long, new Error("context too long"), 0)!;
    assert.equal(once[0]!.content, "s"); assert.equal(once[1]!.content, COMPACT_PROMPT_TOO_LONG_RETRY_MARKER); assert.equal(once[2]!.content, "a2");
    const twice = truncateForCompactRetry(once, new Error("context too long"), 1)!;
    assert.equal(twice.filter((row) => row.content === COMPACT_PROMPT_TOO_LONG_RETRY_MARKER).length, 1);
    assert.equal(truncateForCompactRetry(long, new Error("x"), 3), null);
  });
  it("recognizes context overflow errors and the token gap", () => {
    assert.equal(isModelContextExceededError({ contextOverflow: true }), true);
    assert.equal(isModelContextExceededError({ providerCode: "1261" }), true);
    assert.equal(isModelContextExceededError({ cause: { code: "context_length_exceeded" } }), true);
    assert.equal(isModelContextExceededError(new Error("This model's maximum context length is exceeded")), true);
    assert.equal(isModelContextExceededError(new Error("rate limited")), false);
    assert.equal(parsePromptTooLongTokenGap("prompt is too long: 210,000 tokens > 200,000 maximum"), 10_000);
    assert.equal(getPromptTooLongTokenGap({ error: { message: "1 tokens > 2" } }), undefined);
  });
});

describe("ZCode microcompact", () => {
  it("clears old tool results by token pressure and keeps the latest group", () => {
    const result = maybeLocalMicrocompactMessages({ config: { keepRecentToolResults: 1, minTokenSavings: 1, thresholdTokens: 1 },
      messages: [read("read-old"), tool("read-old", "old-read-token ".repeat(120)), { role: "assistant", content: "", tool_calls: [{ id: "a", function: { name: "Read", arguments: "{}" } }, { id: "b", function: { name: "Read", arguments: "{}" } }] },
        tool("a", "latest-a-token ".repeat(40)), tool("b", "latest-b-token ".repeat(40))] });
    assert.deepEqual(result.payload?.clearedToolCallIds, ["read-old"]); assert.deepEqual(result.payload?.keptToolCallIds, ["a", "b"]); assert.equal(result.payload?.trigger, "token_pressure");
    assert.equal(result.messages[1]!.content, "[Old tool result content cleared]"); assert.match(String(result.messages[3]!.content), /latest-a-token/);
  });
  it("clears after the idle threshold, and not below the token threshold", () => {
    const messages = [read("old"), tool("old", "old ".repeat(400)), read("new"), tool("new", "new ".repeat(10))];
    const idle = maybeLocalMicrocompactMessages({ config: { keepRecentToolResults: 1, minTokenSavings: 1 }, messages, lastAssistantCompletedAtMs: 0, nowMs: 61 * 60_000 });
    assert.equal(idle.payload?.trigger, "time_based");
    assert.equal(maybeLocalMicrocompactMessages({ config: { keepRecentToolResults: 1, thresholdTokens: 1_000_000 }, messages }).decision.reason, "not_triggered");
    assert.equal(maybeLocalMicrocompactMessages({ config: { enabled: false, thresholdTokens: 1 }, messages }).decision.reason, "disabled");
  });
  it("keeps media, error and non-compactable results, and skips small savings", () => {
    const media = [{ type: "text", text: "old media" }, { type: "image_url", image_url: { url: "data:image/png;base64,aW1hZ2U=" } }];
    const config = { keepRecentToolResults: 1, minTokenSavings: 1, thresholdTokens: 1 };
    const kept = maybeLocalMicrocompactMessages({ config, messages: [read("m"), tool("m", media), read("l"), tool("l", "latest ".repeat(120))] });
    assert.equal(kept.decision.reason, "nothing_to_clear"); assert.deepEqual(kept.messages[1]!.content, media);
    const errors = maybeLocalMicrocompactMessages({ config, isError: (id) => id === "e", messages: [read("e"), tool("e", "error ".repeat(120)), read("s"), tool("s", "ok ".repeat(120))] });
    assert.equal(errors.decision.reason, "nothing_to_clear");
    const todo = maybeLocalMicrocompactMessages({ config, messages: [{ role: "assistant", content: "", tool_calls: [{ id: "t", function: { name: "TodoWrite", arguments: "{}" } }] }, tool("t", "x ".repeat(300)), read("r"), tool("r", "y")] });
    assert.equal(todo.decision.reason, "nothing_to_clear");
    const small = maybeLocalMicrocompactMessages({ config: { keepRecentToolResults: 1, thresholdTokens: 1 }, messages: [read("o"), tool("o", "tiny"), read("n"), tool("n", "tiny")] });
    assert.equal(small.decision.reason, "below_min_savings"); assert.equal(small.messages[1]!.content, "tiny");
    assert.equal(buildDefaultMicrocompactThreshold(166_000), 149_400); assert.equal(buildDefaultMicrocompactThreshold(10_000), 8_000);
  });
});
