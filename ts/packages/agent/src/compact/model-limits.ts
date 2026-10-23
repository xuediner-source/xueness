/**
 * Context window and output limits used by compaction.
 * Order: the provider profile (`context_window`, `max_output_tokens`), then this table
 * of well-known model families (conservative: the smaller published window of a
 * family), then ZCode's 200K default (`core/compact/policy.ts` DEFAULT_COMPACT_CONTEXT_WINDOW).
 * ZCode receives these limits from its remote model catalogue; the open-source tree has
 * no table, so this one is Xueness's own.
 */
import { DEFAULT_COMPACT_CONTEXT_WINDOW } from "./policy.ts";

export interface ModelLimits { contextWindow: number; maxOutputTokens?: number; source: "profile" | "table" | "default" }
interface Entry { pattern: RegExp; contextWindow: number; maxOutputTokens?: number }
/** First match wins; patterns see the lower-cased model id without a `vendor/` prefix. */
export const MODEL_LIMIT_TABLE: readonly Entry[] = [
  { pattern: /^claude-(?:opus|sonnet|haiku)?-?[3-9]/, contextWindow: 200_000, maxOutputTokens: 32_000 },
  { pattern: /^claude/, contextWindow: 200_000, maxOutputTokens: 8_192 },
  { pattern: /^gpt-5/, contextWindow: 400_000, maxOutputTokens: 128_000 },
  { pattern: /^gpt-4\.1/, contextWindow: 1_047_576, maxOutputTokens: 32_768 },
  { pattern: /^gpt-4o/, contextWindow: 128_000, maxOutputTokens: 16_384 },
  { pattern: /^o[134](?:-|$)/, contextWindow: 200_000, maxOutputTokens: 100_000 },
  { pattern: /^gemini-(?:2\.5|[3-9])/, contextWindow: 1_048_576, maxOutputTokens: 65_536 },
  { pattern: /^gemini/, contextWindow: 1_000_000, maxOutputTokens: 8_192 },
  { pattern: /^grok-[4-9]/, contextWindow: 256_000 },
  { pattern: /^deepseek/, contextWindow: 128_000, maxOutputTokens: 8_192 },
  { pattern: /^(?:qwen3|qwen-?3)/, contextWindow: 131_072, maxOutputTokens: 32_768 },
  { pattern: /^qwen/, contextWindow: 32_768, maxOutputTokens: 8_192 },
  { pattern: /^glm-?[45]/, contextWindow: 128_000, maxOutputTokens: 32_768 },
  { pattern: /^kimi|^moonshot/, contextWindow: 131_072, maxOutputTokens: 16_384 },
];

const positive = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;

export function lookupModelLimits(model: string | undefined | null): Omit<ModelLimits, "source"> | undefined {
  const id = (model ?? "").trim().toLowerCase().replace(/^.*\//, "");
  if (!id) return undefined;
  const entry = MODEL_LIMIT_TABLE.find((row) => row.pattern.test(id));
  return entry ? { contextWindow: entry.contextWindow, ...entry.maxOutputTokens ? { maxOutputTokens: entry.maxOutputTokens } : {} } : undefined;
}

export function resolveModelLimits(provider: { model?: string; contextWindow?: number | null; maxOutputTokens?: number | null }): ModelLimits {
  const table = lookupModelLimits(provider.model);
  const window = positive(provider.contextWindow);
  const output = positive(provider.maxOutputTokens) ?? table?.maxOutputTokens;
  if (window) return { contextWindow: window, ...output ? { maxOutputTokens: output } : {}, source: "profile" };
  if (table) return { contextWindow: table.contextWindow, ...output ? { maxOutputTokens: output } : {}, source: "table" };
  return { contextWindow: DEFAULT_COMPACT_CONTEXT_WINDOW, ...output ? { maxOutputTokens: output } : {}, source: "default" };
}
