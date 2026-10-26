/**
 * reasoning_content / reasoning_effort dual-protocol bridge (H01.04).
 *
 * DeepSeek-style providers expose reasoning on the OpenAI wire as the
 * `reasoning_content` field of assistant messages and the `reasoning_effort`
 * request parameter; Anthropic exposes it as `thinking` content blocks and a
 * `thinking: { budget_tokens }` request field. This bridge converts complete
 * message lists and streaming deltas between the two wires, and maps the
 * effort ladder low|medium|high|max in both directions.
 *
 * Round-trip guarantee: for a user/assistant message list from the OpenAI
 * wire, `toOpenAIMessages(toAnthropicMessages(list))` returns the same list
 * with byte-identical `reasoning_content` and `content` on every message, in
 * the same order, across any number of turns (system/tool turns have no
 * Anthropic slot and collapse onto `user`; empty `reasoning_content` produces
 * no thinking block). Anthropic `signature` fields are wire-local integrity
 * metadata with no OpenAI slot, so conversions into the OpenAI wire drop
 * them; conversions out of it never invent one.
 *
 * Pure computation only: no I/O, no clock, no randomness.
 */

/** The effort ladder, lowest to highest. */
export const REASONING_EFFORTS = ["low", "medium", "high", "max"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/** Case-insensitive normalization; unknown or empty values yield null. */
export function normalizeReasoningEffort(value: unknown): ReasoningEffort | null {
  if (typeof value !== "string") return null;
  const lowered = value.trim().toLowerCase();
  return (REASONING_EFFORTS as readonly string[]).includes(lowered) ? (lowered as ReasoningEffort) : null;
}

/** Deterministic Anthropic thinking budgets, monotonic in effort. */
export const EFFORT_BUDGET_TOKENS: Readonly<Record<ReasoningEffort, number>> = Object.freeze({
  low: 1024,
  medium: 4096,
  high: 16384,
  max: 32768,
});

/** OpenAI-wire request fields for one effort level (`reasoning_effort` passes through, `max` included). */
export function openAIReasoningFields(effort: ReasoningEffort): { reasoning_effort: ReasoningEffort } {
  return { reasoning_effort: effort };
}

/** Anthropic-wire request fields for one effort level. */
export function anthropicThinkingFields(effort: ReasoningEffort): { thinking: { type: "enabled"; budget_tokens: number } } {
  return { thinking: { type: "enabled", budget_tokens: EFFORT_BUDGET_TOKENS[effort] } };
}

/** The effort whose budget a `budget_tokens` value implies; ties round down to the cheaper effort. */
export function effortForBudgetTokens(budget: unknown): ReasoningEffort | null {
  if (typeof budget !== "number" || !Number.isFinite(budget) || budget <= 0) return null;
  let result: ReasoningEffort | null = null;
  for (const effort of REASONING_EFFORTS) {
    if (budget >= EFFORT_BUDGET_TOKENS[effort]) result = effort;
  }
  return result;
}

/** An assistant message on the OpenAI wire; `reasoning_content` is DeepSeek-style reasoning. */
export interface OpenAIChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  reasoning_content?: string;
}

/** Anthropic wire: a thinking block carries reasoning; `signature` is optional integrity metadata. */
export interface AnthropicThinkingBlock {
  type: "thinking";
  thinking: string;
  signature?: string;
}

export interface AnthropicTextBlock {
  type: "text";
  text: string;
}

export type AnthropicBlock = AnthropicThinkingBlock | AnthropicTextBlock;

/** Anthropic-wire message; content is a plain string or a block list. */
export interface AnthropicChatMessage {
  role: "user" | "assistant";
  content: string | readonly AnthropicBlock[];
}

const JOIN = "\n\n";

function openAIToAnthropic(message: OpenAIChatMessage): AnthropicChatMessage {
  if (message.role !== "assistant") {
    return { role: "user", content: message.content ?? "" };
  }
  const blocks: AnthropicBlock[] = [];
  if (typeof message.reasoning_content === "string" && message.reasoning_content.length > 0) {
    blocks.push({ type: "thinking", thinking: message.reasoning_content });
  }
  // Any string content gets a text block, the empty string included, so an
  // empty assistant turn stays distinguishable from a reasoning-only one.
  if (typeof message.content === "string") {
    blocks.push({ type: "text", text: message.content });
  }
  if (blocks.length === 0) blocks.push({ type: "text", text: "" });
  return { role: "assistant", content: blocks };
}

function anthropicToOpenAI(message: AnthropicChatMessage): OpenAIChatMessage {
  const role: OpenAIChatMessage["role"] = message.role === "assistant" ? "assistant" : "user";
  if (typeof message.content === "string") {
    return { role, content: message.content };
  }
  const reasoning: string[] = [];
  const text: string[] = [];
  let sawText = false;
  for (const block of message.content) {
    if (block.type === "thinking") {
      if (block.thinking.length > 0) reasoning.push(block.thinking);
    } else {
      sawText = true;
      if (block.text.length > 0) text.push(block.text);
    }
  }
  if (role !== "assistant") {
    // Reasoning blocks only exist on assistant turns; non-assistant text joins back to one string.
    return { role, content: text.join(JOIN) };
  }
  // A text block that happens to be empty still means "this turn had content";
  // only a thinking-only turn has no `content` at all.
  const converted: OpenAIChatMessage = { role, content: sawText ? text.join(JOIN) : null };
  if (reasoning.length > 0) converted.reasoning_content = reasoning.join(JOIN);
  return converted;
}

/**
 * OpenAI wire → Anthropic wire. Each assistant message becomes a block list:
 * one thinking block holding `reasoning_content` (when non-empty) followed by
 * one text block for every string `content` (the empty string included).
 * System/tool roles map to `user`, as the Anthropic wire has no slots for them.
 * Message count and order are preserved, and `content: null` on a non-assistant
 * or reasoning-only turn normalizes to `""` (that wire shape carries no null).
 */
export function toAnthropicMessages(messages: readonly OpenAIChatMessage[]): AnthropicChatMessage[] {
  return messages.map(openAIToAnthropic);
}

/**
 * Anthropic wire → OpenAI wire. A message's thinking blocks become one
 * `reasoning_content` string (blocks joined by a blank line, in order); its
 * text blocks become the `content` string the same way. An assistant message
 * with only thinking gets `content: null`; a turn whose only text block is
 * empty keeps `content: ""` instead.
 */
export function toOpenAIMessages(messages: readonly AnthropicChatMessage[]): OpenAIChatMessage[] {
  return messages.map(anthropicToOpenAI);
}

/** Round-trip helper for the OpenAI wire: `list → Anthropic → list`, lossless for every field it carries. */
export function roundTripOpenAI(messages: readonly OpenAIChatMessage[]): OpenAIChatMessage[] {
  return toOpenAIMessages(toAnthropicMessages(messages));
}

/** One streaming chunk, in either wire's delta shape. */
export type ReasoningDelta =
  | { wire: "openai"; reasoning_content?: string; content?: string | null }
  | { wire: "anthropic"; type: "thinking_delta" | "text_delta"; text?: string };

export interface ReasoningDeltaTracker {
  /** Feed one delta; unknown shapes are ignored. */
  push(delta: ReasoningDelta): void;
  /** The assembled reasoning text so far (both wires append into it). */
  reasoning(): string;
  /** The assembled answer text so far (both wires append into it). */
  content(): string;
}

/** Accumulates reasoning and answer text from OpenAI- or Anthropic-shaped stream deltas. */
export function createReasoningDeltaTracker(): ReasoningDeltaTracker {
  let reasoning = "";
  let content = "";
  return {
    push(delta) {
      if (delta.wire === "openai") {
        if (typeof delta.reasoning_content === "string") reasoning += delta.reasoning_content;
        if (typeof delta.content === "string") content += delta.content;
        return;
      }
      if (typeof delta.text === "string" && delta.text.length > 0) {
        if (delta.type === "thinking_delta") reasoning += delta.text;
        else content += delta.text;
      }
    },
    reasoning: () => reasoning,
    content: () => content,
  };
}
