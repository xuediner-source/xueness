/**
 * Auto-compact policy and token estimate.
 * Ported from ZCode v3.15.1 (aac4755, Apache-2.0) `core/compact/policy.ts`,
 * `core/compact/manual.ts` (estimate, enough-messages, usage total) and
 * `core/runtime/methods/model-token-limits.ts`. Messages are Xueness journal or
 * request rows (OpenAI shape: `content`, `tool_calls[].function.{name,arguments}`).
 */
import { groupByAssistantStartedRounds } from "./rounds.ts";

type Row = Record<string, unknown>;
/** `@zcode/shared` ESTIMATED_TOKEN_CHAR_DIVISOR. */
export const ESTIMATED_TOKEN_CHAR_DIVISOR = 3;
export const DEFAULT_COMPACT_CONTEXT_WINDOW = 200_000;
export const DEFAULT_AUTOCOMPACT_OUTPUT_RESERVE_TOKENS = 32_000;
export const PREFLIGHT_AUTOCOMPACT_OUTPUT_RESERVE_TOKENS = 21_000;
export const MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000;
export const AUTOCOMPACT_BUFFER_TOKENS = 13_000;
export const DEFAULT_AUTOCOMPACT_THRESHOLD_PERCENT = 100;
export const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3;
const DEFAULT_NORMAL_REQUEST_MAX_OUTPUT_TOKENS = 32_000;

export interface AutoCompactPolicyConfig {
  enabled?: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
  bufferTokens?: number;
  thresholdPercentOverride?: number;
  maxConsecutiveFailures?: number;
}
export interface AutoCompactTokenOverride { source: "provider_usage"; tokenCount: number; baseTokenCount?: number; incrementalTokenCount?: number }
export interface AutoCompactDecision {
  shouldCompact: boolean;
  tokenCount: number;
  tokenSource: "estimate" | "provider_usage";
  estimatedTokenCount: number;
  threshold: number;
  contextWindow: number;
  effectiveContextWindow: number;
  maxOutputTokens?: number;
  outputReserveTokens: number;
  thresholdPercent: number;
  reason: "disabled" | "not_enough_messages" | "circuit_breaker" | "below_threshold" | "above_threshold";
}

function positiveInt(value: number | undefined | null): number | undefined {
  if (value === undefined || value === null || !Number.isFinite(value) || value < 0) return undefined;
  return Math.floor(value);
}

export function getAutoCompactOutputReserveTokens(config: AutoCompactPolicyConfig = {}): number {
  const maxOutputTokens = positiveInt(config.maxOutputTokens);
  return Math.min(maxOutputTokens ?? DEFAULT_AUTOCOMPACT_OUTPUT_RESERVE_TOKENS, PREFLIGHT_AUTOCOMPACT_OUTPUT_RESERVE_TOKENS);
}

/** The provider window is shared by input and output; only the input side can be compacted. */
export function getEffectiveContextWindowSize(config: AutoCompactPolicyConfig = {}): number {
  const contextWindow = positiveInt(config.contextWindow) ?? DEFAULT_COMPACT_CONTEXT_WINDOW;
  const reserve = Math.min(getAutoCompactOutputReserveTokens(config), contextWindow);
  return Math.max(0, contextWindow - reserve);
}

export function getAutoCompactThreshold(config: AutoCompactPolicyConfig = {}): number {
  const buffer = positiveInt(config.bufferTokens) ?? AUTOCOMPACT_BUFFER_TOKENS;
  return Math.max(0, getEffectiveContextWindowSize(config) - buffer);
}

/** Visible text of a content value; block arrays contribute their text (and reasoning) parts. */
export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content === null || content === undefined ? "" : JSON.stringify(content);
  return content.map((block) => {
    if (typeof block === "string") return block;
    if (!block || typeof block !== "object") return "";
    const row = block as Row;
    if (typeof row.text === "string") return row.text;
    return row.type === "image_url" || row.type === "image" ? "" : JSON.stringify(row);
  }).filter(Boolean).join("\n\n");
}

/** ZCode estimateMessageTokens: ceil(chars / 3) per message, tool-call name + arguments included. */
export function estimateMessageTokens(messages: readonly Row[]): number {
  return messages.reduce((total, message) => {
    let characters = contentText(message.content).length;
    if (typeof message.reasoning_content === "string") characters += message.reasoning_content.length;
    for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
      const fn = call && typeof call === "object" ? (call as Row).function as Row | undefined : undefined;
      const name = typeof fn?.name === "string" ? fn.name : "";
      const args = typeof fn?.arguments === "string" ? fn.arguments : JSON.stringify(fn?.arguments ?? {}) ?? "{}";
      characters += (name + args).length;
    }
    return total + Math.ceil(characters / ESTIMATED_TOKEN_CHAR_DIVISOR);
  }, 0);
}

/** System messages and `<system-reminder>` user messages are context prefix, not conversation. */
export function isContextPrefixMessage(message: Row): boolean {
  return message.role === "system" && message._compact_summary !== true
    || message.role === "user" && contentText(message.content).trimStart().startsWith("<system-reminder>");
}

export function getMessagesToSummarize(messages: readonly Row[]): Row[] {
  return messages.filter((message) => !isContextPrefixMessage(message));
}

export function hasEnoughMessagesToCompact(messages: readonly Row[]): boolean {
  const body = getMessagesToSummarize(messages);
  return groupByAssistantStartedRounds(body, (message) => String(message.role)).length >= 2 && body.some((message) => message.role === "assistant");
}

export function shouldAutoCompact(input: { messages: readonly Row[]; config?: AutoCompactPolicyConfig; consecutiveFailures?: number; tokenOverride?: AutoCompactTokenOverride }): AutoCompactDecision {
  const config = input.config ?? {};
  const contextWindow = positiveInt(config.contextWindow) ?? DEFAULT_COMPACT_CONTEXT_WINDOW;
  const estimatedTokenCount = estimateMessageTokens(input.messages);
  const common = {
    contextWindow, effectiveContextWindow: getEffectiveContextWindowSize(config), estimatedTokenCount,
    maxOutputTokens: positiveInt(config.maxOutputTokens), outputReserveTokens: Math.min(getAutoCompactOutputReserveTokens(config), contextWindow),
    threshold: getAutoCompactThreshold(config), thresholdPercent: DEFAULT_AUTOCOMPACT_THRESHOLD_PERCENT,
    tokenCount: input.tokenOverride?.tokenCount ?? estimatedTokenCount, tokenSource: input.tokenOverride?.source ?? "estimate" as const,
  };
  if (config.enabled === false) return { ...common, shouldCompact: false, reason: "disabled" };
  if (!hasEnoughMessagesToCompact(input.messages)) return { ...common, shouldCompact: false, reason: "not_enough_messages" };
  if ((input.consecutiveFailures ?? 0) >= (positiveInt(config.maxConsecutiveFailures) ?? MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES)) return { ...common, shouldCompact: false, reason: "circuit_breaker" };
  if (common.tokenCount < common.threshold) return { ...common, shouldCompact: false, reason: "below_threshold" };
  return { ...common, shouldCompact: true, reason: "above_threshold" };
}

/** ZCode getUsageTotalTokens over an OpenAI-shaped usage row (Anthropic fields included). */
export function getUsageTotalTokens(usage: Row | undefined | null): number {
  const n = (key: string): number | undefined => typeof usage?.[key] === "number" ? usage[key] as number : undefined;
  const input = n("prompt_tokens") ?? n("input_tokens") ?? (n("cache_read_input_tokens") ?? 0) + (n("cache_creation_input_tokens") ?? 0);
  return n("total_tokens") ?? input + (n("completion_tokens") ?? n("output_tokens") ?? 0);
}

/** The model's declared output budget when known, else 32K (ZCode resolveNormalRequestMaxOutputTokens). */
export function resolveNormalRequestMaxOutputTokens(input: { modelMaxOutputTokens: number | undefined | null }): number {
  const value = input.modelMaxOutputTokens;
  return value !== undefined && value !== null && Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_NORMAL_REQUEST_MAX_OUTPUT_TOKENS;
}

/** Summary output cap: min(normal output target, 20K, model maximum). */
export function capCompactSummaryMaxOutputTokens(modelMaxOutputTokens: number | undefined | null): number {
  const desired = Math.min(resolveNormalRequestMaxOutputTokens({ modelMaxOutputTokens }), MAX_OUTPUT_TOKENS_FOR_SUMMARY);
  return positiveInt(modelMaxOutputTokens) ? Math.min(desired, positiveInt(modelMaxOutputTokens)!) : desired;
}
