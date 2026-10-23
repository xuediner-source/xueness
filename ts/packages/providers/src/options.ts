/**
 * Ports of `runtime_options.py` and `lightweight_config.py`: saved-profile
 * validation and the one OpenAI-compatible payload builder shared by normal
 * calls and connection checks. Error messages match Python exactly.
 */
import { PyValueError, isDict, pyCasefold, pyStrip } from "@xueness/contracts";

type Dict = Record<string, unknown>;

export const RUNTIME_PROFILES = new Set(["standard", "lightweight"]);
export const TOOL_CALLING_MODES = new Set(["native", "json"]);
const MAX_TOKENS_FIELDS = new Set(["max_tokens", "max_completion_tokens"]);
const COMPATIBILITY_KEYS = new Set(["streamUsage", "parallelToolCalls", "maxTokensField", "toolChoice", "think"]);
export const LIGHTWEIGHT_CONTEXT_WINDOW = 8192;
export const LIGHTWEIGHT_MAX_OUTPUT_TOKENS = 1024;

export const LIGHTWEIGHT_DEFAULTS: Readonly<Dict> = Object.freeze({
  optionalContextChars: 1800, toolResultChars: 1400, initialTools: "auto",
  maxDiscoveredTools: 6, toolSearchResults: 3, resultPageChars: 1200,
  fileReadChars: 4000, overflowRetry: true, overflowRetryRatio: 0.6,
  jsonRepairAttempts: 1, stepLimit: 64, requestTimeoutSeconds: 120, transportRetries: 0,
});
const INTEGER_RANGES: Record<string, [number, number]> = {
  reserveTokens: [0, 8192], optionalContextChars: [0, 6000],
  toolResultChars: [400, 12000], maxDiscoveredTools: [0, 12],
  toolSearchResults: [1, 6], resultPageChars: [128, 4000],
  fileReadChars: [128, 12000], jsonRepairAttempts: [0, 2],
  stepLimit: [1, 64], wallTimeSeconds: [1, 3600], seed: [0, 2147483647],
  requestTimeoutSeconds: [1, 300], transportRetries: [0, 2],
};
const FLOAT_RANGES: Record<string, [number, number]> = { overflowRetryRatio: [0.25, 0.85], temperature: [0, 2], topP: [0, 1] };
const KEYS = new Set([...Object.keys(INTEGER_RANGES), ...Object.keys(FLOAT_RANGES), "initialTools", "overflowRetry"]);
const SAMPLING_KEYS = new Set(["temperature", "topP", "seed"]);

/** Python `type(x) is int` for a JSON value (bool excluded; `5.0` is a known gap). */
export function isPyInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function has(record: Dict, key: string): boolean {
  return Object.hasOwn(record, key);
}

/** `lightweight_config.validate_options`. */
export function validateOptions(value: unknown, protocol = "openai"): Dict {
  if (!isDict(value) || Object.keys(value).some((key) => !KEYS.has(key))) {
    throw new PyValueError("lightweightOptions must contain supported options only");
  }
  if (protocol !== "openai" && Object.keys(value).some((key) => SAMPLING_KEYS.has(key))) {
    throw new PyValueError("lightweight sampling options require an OpenAI-compatible provider");
  }
  const clean: Dict = {};
  for (const [key, item] of Object.entries(value)) {
    if (Object.hasOwn(INTEGER_RANGES, key)) {
      const [low, high] = INTEGER_RANGES[key] as [number, number];
      if (!isPyInt(item) || !(low <= item && item <= high)) {
        throw new PyValueError(`lightweightOptions.${key} must be an integer from ${low} to ${high}`);
      }
    } else if (Object.hasOwn(FLOAT_RANGES, key)) {
      const [low, high] = FLOAT_RANGES[key] as [number, number];
      if (typeof item !== "number" || !(low <= item && item <= high) || !Number.isFinite(item) || (key === "topP" && item === 0)) {
        throw new PyValueError(`lightweightOptions.${key} is outside the supported range`);
      }
    } else if (key === "initialTools") {
      if (typeof item !== "string" || !["auto", "minimal", "core"].includes(item)) {
        throw new PyValueError("lightweightOptions.initialTools must be auto, minimal or core");
      }
    } else if (typeof item !== "boolean") {
      throw new PyValueError("lightweightOptions.overflowRetry must be a boolean");
    }
    clean[key] = item;
  }
  return clean;
}

export interface EffectiveOptionsInput {
  value?: unknown;
  context?: number | null;
  output?: number | null;
}

/** `lightweight_config.effective_options` (the provider fields are passed explicitly). */
export function effectiveOptions(input: EffectiveOptionsInput = {}): Dict {
  const options: Dict = { ...LIGHTWEIGHT_DEFAULTS, ...validateOptions(input.value ?? {}) };
  const context = input.context || 8192;
  const output = input.output || Math.min(1024, Math.floor(context / 4));
  if (!has(options, "reserveTokens")) options["reserveTokens"] = context < 4096 ? 128 : 512;
  if (context - output - (options["reserveTokens"] as number) < 256) {
    throw new PyValueError("lightweightOptions.reserveTokens leaves fewer than 256 input tokens");
  }
  return options;
}

/** `lightweight_config.session_options`. */
export function sessionOptions(session: unknown): Dict {
  const record = isDict(session) ? session : {};
  if (record["runtime_profile"] !== "lightweight") return {};
  return { ...LIGHTWEIGHT_DEFAULTS, ...validateOptions(has(record, "lightweight_options") ? record["lightweight_options"] : {}) };
}

function boundedInteger(value: unknown, field: string, minimum: number, maximum: number): number {
  if (!isPyInt(value) || !(minimum <= value && value <= maximum)) {
    throw new PyValueError(`${field} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

/** `validate_compatibility`: a fresh mapping, or a refusal of unknown/invalid values. */
export function validateCompatibility(value: unknown): Dict {
  if (!isDict(value)) throw new PyValueError("compatibility must be an object");
  if (Object.keys(value).some((key) => !COMPATIBILITY_KEYS.has(key))) {
    throw new PyValueError("compatibility contains an unsupported option");
  }
  const clean: Dict = {};
  for (const key of ["streamUsage", "parallelToolCalls"]) {
    if (has(value, key)) {
      if (typeof value[key] !== "boolean") throw new PyValueError(`compatibility.${key} must be a boolean`);
      clean[key] = value[key];
    }
  }
  if (has(value, "maxTokensField")) {
    const field = value["maxTokensField"];
    if (typeof field !== "string" || !MAX_TOKENS_FIELDS.has(field)) throw new PyValueError("compatibility.maxTokensField is unsupported");
    clean["maxTokensField"] = field;
  }
  if (has(value, "toolChoice")) {
    if (value["toolChoice"] !== "auto" && value["toolChoice"] !== "required") {
      throw new PyValueError("compatibility.toolChoice must be auto or required");
    }
    clean["toolChoice"] = value["toolChoice"];
  }
  if (has(value, "think")) {
    if (typeof value["think"] !== "boolean") throw new PyValueError("compatibility.think must be a boolean");
    clean["think"] = value["think"];
  }
  return clean;
}

export interface RuntimeOptions {
  runtime_profile: string;
  context_window: number | null;
  max_output_tokens: number | null;
  tool_calling: string;
  compatibility: Dict;
  lightweight_options: Dict;
}

/** `resolve_runtime_options`: validated runtime values with profile defaults. */
export function resolveRuntimeOptions(record: unknown, protocol = "openai"): RuntimeOptions {
  if (!isDict(record)) throw new PyValueError("provider profile must be an object");
  const profile = has(record, "runtimeProfile") ? record["runtimeProfile"] : "standard";
  if (typeof profile !== "string" || !RUNTIME_PROFILES.has(profile)) {
    throw new PyValueError("runtimeProfile must be standard or lightweight");
  }
  const contextWindow = has(record, "contextWindow")
    ? boundedInteger(record["contextWindow"], "contextWindow", 2048, 262144)
    : profile === "lightweight" ? LIGHTWEIGHT_CONTEXT_WINDOW : null;
  const maxOutputTokens = has(record, "maxOutputTokens")
    ? boundedInteger(record["maxOutputTokens"], "maxOutputTokens", 128, 32768)
    : profile === "lightweight" ? Math.min(LIGHTWEIGHT_MAX_OUTPUT_TOKENS, Math.floor((contextWindow as number) / 4)) : null;
  if (maxOutputTokens !== null && contextWindow !== null && maxOutputTokens > Math.floor(contextWindow / 2)) {
    throw new PyValueError("maxOutputTokens must be no greater than half of contextWindow");
  }
  const toolCalling = has(record, "toolCalling") ? record["toolCalling"] : "native";
  if (typeof toolCalling !== "string" || !TOOL_CALLING_MODES.has(toolCalling)) {
    throw new PyValueError("toolCalling must be native or json");
  }
  if (toolCalling === "json" && (protocol !== "openai" || profile !== "lightweight")) {
    throw new PyValueError("toolCalling=json requires an OpenAI-compatible lightweight profile");
  }
  const compatibility = validateCompatibility(has(record, "compatibility") ? record["compatibility"] : {});
  if (protocol !== "openai" && Object.keys(compatibility).length) {
    throw new PyValueError("compatibility options are supported only for OpenAI-compatible providers");
  }
  const lightweightOptions = validateOptions(has(record, "lightweightOptions") ? record["lightweightOptions"] : {}, protocol);
  if (profile === "lightweight") effectiveOptions({ value: lightweightOptions, context: contextWindow, output: maxOutputTokens });
  return {
    runtime_profile: profile, context_window: contextWindow, max_output_tokens: maxOutputTokens,
    tool_calling: toolCalling, compatibility, lightweight_options: lightweightOptions,
  };
}

/** `public_runtime_options`: whitelisted metadata with the legacy default shape. */
export function publicRuntimeOptions(record: Dict): Dict {
  const options = resolveRuntimeOptions(record, (has(record, "protocol") ? record["protocol"] : "openai") as string);
  const result: Dict = {};
  const profile = options.runtime_profile;
  if (has(record, "runtimeProfile") || profile !== "standard") result["runtimeProfile"] = profile;
  if (has(record, "contextWindow") || profile === "lightweight") result["contextWindow"] = options.context_window;
  if (has(record, "maxOutputTokens") || profile === "lightweight") result["maxOutputTokens"] = options.max_output_tokens;
  if (has(record, "toolCalling") || options.tool_calling !== "native") result["toolCalling"] = options.tool_calling;
  if (has(record, "compatibility") || Object.keys(options.compatibility).length) result["compatibility"] = { ...options.compatibility };
  if (has(record, "lightweightOptions")) result["lightweightOptions"] = { ...options.lightweight_options };
  return result;
}

/** `providers_api.known_reasoning_levels`. */
export function knownReasoningLevels(model: unknown): string[] {
  if (typeof model !== "string") return [];
  const name = pyCasefold(pyStrip(model));
  const family = (prefixes: string[]): boolean => prefixes.some((prefix) => name === prefix || name.startsWith(`${prefix}-`));
  if (family(["gpt-6-astra", "gpt-6-sol", "gpt-6-luna"])) return ["low", "medium", "high", "xhigh", "max"];
  if (family(["o3", "o4"])) return ["low", "medium", "high"];
  return [];
}

export interface OpenAiPayloadInput {
  model: unknown;
  messages: unknown;
  tools: unknown;
  runtimeProfile?: unknown;
  contextWindow?: unknown;
  maxOutputTokens?: unknown;
  toolCalling?: unknown;
  compatibility?: unknown;
  stream?: boolean;
  reasoningEffort?: unknown;
  testConnection?: boolean;
  defaultMaxTokensField?: string;
  lightweightOptions?: unknown;
  testMaxTokens?: unknown;
}

/** `build_openai_payload`: one body for inference or connection tests. */
export function buildOpenAiPayload(input: OpenAiPayloadInput): Dict {
  const compatibility = validateCompatibility(input.compatibility ?? {});
  const profile = input.runtimeProfile ?? "standard";
  if (typeof profile !== "string" || !RUNTIME_PROFILES.has(profile)) throw new PyValueError("runtimeProfile must be standard or lightweight");
  const toolCalling = input.toolCalling ?? "native";
  if ((typeof toolCalling !== "string" || !TOOL_CALLING_MODES.has(toolCalling)) && toolCalling !== "plain") {
    throw new PyValueError("toolCalling must be native, json or plain");
  }
  if (toolCalling === "json" && profile !== "lightweight") throw new PyValueError("toolCalling=json requires a lightweight profile");
  const testMaxTokens = input.testMaxTokens ?? 8;
  if (!isPyInt(testMaxTokens) || !(testMaxTokens >= 1 && testMaxTokens <= 128)) {
    throw new PyValueError("test_max_tokens must be an integer from 1 to 128");
  }
  let contextWindow = input.contextWindow ?? null;
  if (contextWindow !== null) contextWindow = boundedInteger(contextWindow, "contextWindow", 2048, 262144);
  let maxOutputTokens = input.maxOutputTokens ?? null;
  if (maxOutputTokens === null && profile === "lightweight") {
    maxOutputTokens = Math.min(LIGHTWEIGHT_MAX_OUTPUT_TOKENS, Math.floor(((contextWindow as number | null) || LIGHTWEIGHT_CONTEXT_WINDOW) / 4));
  }
  if (maxOutputTokens !== null) maxOutputTokens = boundedInteger(maxOutputTokens, "maxOutputTokens", 128, 32768);
  if (maxOutputTokens !== null && contextWindow !== null && (maxOutputTokens as number) > Math.floor((contextWindow as number) / 2)) {
    throw new PyValueError("maxOutputTokens must be no greater than half of contextWindow");
  }
  const body: Dict = { model: input.model, messages: input.messages };
  if (toolCalling === "native") body["tools"] = input.tools;
  if (input.stream) {
    body["stream"] = true;
    const includeUsage = has(compatibility, "streamUsage") ? compatibility["streamUsage"] : profile === "standard";
    if (includeUsage) body["stream_options"] = { include_usage: true };
  }
  if (toolCalling === "native") {
    if (has(compatibility, "parallelToolCalls")) body["parallel_tool_calls"] = compatibility["parallelToolCalls"];
    if (has(compatibility, "toolChoice")) body["tool_choice"] = compatibility["toolChoice"];
  }
  if (has(compatibility, "think")) body["think"] = compatibility["think"];
  const tokenField = has(compatibility, "maxTokensField") ? compatibility["maxTokensField"] as string
    : profile === "lightweight" ? "max_tokens" : input.defaultMaxTokensField ?? "max_tokens";
  let tokenLimit: number | null = null;
  if (input.testConnection) tokenLimit = maxOutputTokens !== null ? Math.min(testMaxTokens, maxOutputTokens as number) : testMaxTokens;
  else if (maxOutputTokens !== null) tokenLimit = maxOutputTokens as number;
  if (tokenLimit !== null) body[tokenField] = tokenLimit;
  if (input.reasoningEffort !== undefined && input.reasoningEffort !== null && !has(compatibility, "think")) {
    body["reasoning_effort"] = input.reasoningEffort;
  }
  const options = validateOptions(input.lightweightOptions ?? {});
  if (profile === "lightweight" && !input.testConnection) {
    for (const [key, field] of [["temperature", "temperature"], ["topP", "top_p"], ["seed", "seed"]] as const) {
      if (has(options, key)) body[field] = options[key];
    }
  }
  return body;
}
