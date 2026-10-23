/** ZCode adapter's zero-output completion check (runner-diagnostics.ts), before the core anomaly guard. */
import { isDict } from "@xueness/contracts";
import { ProviderRequestError } from "@xueness/providers";
import type { Row } from "./types.ts";

export class EmptyModelCompletionError extends ProviderRequestError {
  constructor() { super({ category: "invalid_response", stage: "response", exceptionType: "EmptyModelCompletion" }); }
}

export function isZeroOutputCompletion(response: Row, reasoning = false): boolean {
  if (reasoning) return false;
  if (typeof response.reasoning_content === "string" && response.reasoning_content.length) return false;
  if (Array.isArray(response._reasoning_blocks) && response._reasoning_blocks.some((block) => isDict(block) && typeof block.thinking === "string" && block.thinking.length)) return false;
  if (typeof response.reasoning === "string" && response.reasoning.length || Array.isArray(response.reasoning) && response.reasoning.some((item) => isDict(item) && typeof item.text === "string" && item.text.length)) return false;
  return isSuspiciousEmptyCompletion(response);
}

/** Core's final anomaly guard also covers a reasoning-only zero-usage abnormal finish. */
export function isSuspiciousEmptyCompletion(response: Row): boolean {
  if (typeof response._finish_reason !== "string") return false;
  const finish = response._finish_reason.trim().toLowerCase();
  if (["stop", "tool_calls", "tool-calls"].includes(finish)) return false;
  if (typeof response.content === "string" && response.content.length) return false;
  if (Array.isArray(response.tool_calls) && response.tool_calls.length) return false;
  const usage = isDict(response._usage) ? response._usage : {};
  const total = usage.total_tokens ?? usage.totalTokens;
  if (typeof total === "number") return total === 0;
  return !["prompt_tokens", "input_tokens", "completion_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens", "reasoning_tokens"].some((key) => typeof usage[key] === "number" && Number(usage[key]) > 0);
}
