/**
 * Bounded provider measurements and termination (`response_metadata.py`),
 * plus the result decorations `_with_reported_usage` / `_with_request_attempts`.
 */
import { PyValueError, isDict, pyDictGet, pyGet, pyGetItem, pyTruthy } from "@xueness/contracts";

export const TOKEN_KEYS = new Set([
  "prompt_tokens", "completion_tokens", "total_tokens", "input_tokens", "output_tokens", "cached_tokens",
  "cache_read_input_tokens", "cache_creation_input_tokens", "reasoning_tokens",
]);
export const DETAIL_KEYS = new Set(["cached_tokens", "reasoning_tokens", "accepted_prediction_tokens", "rejected_prediction_tokens", "audio_tokens"]);
export const FINISH_REASONS = new Set(["stop", "length", "tool_calls", "content_filter", "context_limit", "paused", "unknown"]);
const FINISH_ALIASES: Record<string, string> = {
  end_turn: "stop", stop_sequence: "stop", tool_use: "tool_calls", function_call: "tool_calls", max_tokens: "length",
  pause_turn: "paused", refusal: "content_filter", context_length: "context_limit", context_length_exceeded: "context_limit",
};

export type Usage = Record<string, number | Record<string, number>>;

/** `reported_model`: record a bounded wire model ID (at most eight distinct). */
export function reportedModel(metadata: Record<string, unknown> | null | undefined, value: unknown): void {
  if (!metadata || typeof value !== "string" || !value || Array.from(value).length > 256) return;
  for (const char of value) if ((char.codePointAt(0) ?? 0) < 32) return;
  if (!Array.isArray(metadata._response_models)) metadata._response_models = [];
  const models = metadata._response_models as string[];
  if (!models.includes(value) && models.length < 8) models.push(value);
}

/** `token_count`. */
export function tokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 1_000_000_000;
}

/** `reported_usage`: whitelisted counters; Anthropic input adds cache reads/creation. */
export function reportedUsage(raw: unknown): Usage {
  if (!isDict(raw)) return {};
  const result: Usage = {};
  for (const [key, value] of Object.entries(raw)) if (TOKEN_KEYS.has(key) && tokenCount(value)) result[key] = value;
  for (const key of ["prompt_tokens_details", "completion_tokens_details"]) {
    const detail = pyGet(raw, key);
    if (isDict(detail)) {
      const clean: Record<string, number> = {};
      for (const [name, value] of Object.entries(detail)) if (DETAIL_KEYS.has(name) && tokenCount(value)) clean[name] = value;
      if (Object.keys(clean).length) result[key] = clean;
    }
  }
  const count = (key: string): number => (typeof result[key] === "number" ? (result[key] as number) : 0);
  if (!("prompt_tokens" in result) && "input_tokens" in result) {
    const total = count("input_tokens") + count("cache_read_input_tokens") + count("cache_creation_input_tokens");
    if (tokenCount(total)) result.prompt_tokens = total;
  }
  if (!("completion_tokens" in result) && "output_tokens" in result) result.completion_tokens = result.output_tokens as number;
  return result;
}

/** `finish_reason`: normalized termination, `unknown` for unrecognized strings. */
export function finishReason(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = Object.hasOwn(FINISH_ALIASES, raw) ? (FINISH_ALIASES[raw] as string) : raw;
  return FINISH_REASONS.has(value) ? value : "unknown";
}

export interface TokenLimits {
  maxOutputTokens?: number | null;
  contextWindow?: number | null;
}

/** `incomplete_reason`: why a response stopped early, or null when complete. */
export function incompleteReason(reason: string | null | undefined, usage: unknown, provider: TokenLimits): string | null {
  if (reason === null || reason === undefined || reason === "stop" || reason === "tool_calls") return null;
  if (reason !== "length") {
    return ({ context_limit: "context_limit", content_filter: "provider_filtered", paused: "provider_paused" } as Record<string, string>)[reason]
      ?? "unknown_termination";
  }
  const clean = reportedUsage(usage);
  const inputs = clean.prompt_tokens;
  const outputs = clean.completion_tokens;
  const limit = provider.maxOutputTokens;
  const window = provider.contextWindow;
  if (tokenCount(outputs) && tokenCount(limit) && outputs >= limit) return "output_limit";
  if (tokenCount(inputs) && tokenCount(outputs) && tokenCount(window) && tokenCount(limit)
    && inputs + limit > window && inputs + outputs >= window - 32) return "context_limit";
  return "generation_limit";
}

export const PAUSE_MESSAGES: Record<string, string> = {
  context_limit: "上下文容量已耗尽，回答尚未完成。再次续写前将重新整理请求历史；若用户输入本身过长，请缩短输入或新建会话。",
  output_limit: "本次生成达到输出上限，回答尚未完成。已有正文已保留，可发送“继续”补写；输出预算包含模型思考。",
  generation_limit: "模型因生成限制停止，回答尚未完成。服务未提供足够信息区分输出上限与上下文限制；已有正文已保留。",
  provider_filtered: "模型服务过滤了本次响应，回答尚未完成。",
  provider_paused: "模型服务暂停了本次响应，回答尚未完成。",
  unknown_termination: "模型返回了无法识别的结束原因，尚不能确认回答完整。",
};

/** `_with_reported_usage`: keep wire usage / finish / model, discarding lookalikes. */
export function withReportedUsage(message: unknown, payload: unknown): Record<string, unknown> {
  if (!isDict(message)) throw new PyValueError("provider message must be an object");
  const result: Record<string, unknown> = { ...message };
  delete result._usage;
  delete result._finish_reason;
  delete result._response_models;
  reportedModel(result, pyDictGet(payload, "model"));
  const usage = reportedUsage(pyDictGet(payload, "usage"));
  if (Object.keys(usage).length) result._usage = usage;
  const rawChoices = pyDictGet(payload, "choices");
  const choices = pyTruthy(rawChoices) ? rawChoices : [];
  let first: unknown = null;
  if (pyTruthy(choices)) first = pyGetItem(choices, 0);
  const rawReason = pyTruthy(choices) && isDict(first) ? pyGet(first, "finish_reason") : pyDictGet(payload, "stop_reason");
  const reason = finishReason(rawReason);
  if (reason !== null) result._finish_reason = reason;
  return result;
}

/** `_with_request_attempts`: adapter-owned retry telemetry. */
export function withRequestAttempts(response: unknown, attempts: number): Record<string, unknown> {
  if (!isDict(response)) throw new PyValueError("provider response must be an object");
  const result: Record<string, unknown> = { ...response };
  delete result._request_attempts;
  result._request_attempts = Math.max(1, Math.trunc(attempts));
  return result;
}
