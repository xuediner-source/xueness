/**
 * Strict whole-reply handling and detection for model-native tool-call markup
 * (for example XML `<tool_call>` blocks) when running under the JSON protocol.
 *
 * Security boundary: executable calls are ONLY accepted when the entire trimmed
 * reply consists solely of closed `<tool_call>...</tool_call>` blocks. Prose
 * mixed with markup or truncated tags is never mined for intent and is rejected
 * with `native_markup_in_json_mode` + the detected dialect.
 */
import { isDict } from "@xueness/contracts";
import { argumentsObject, envelopeText, finiteJsonText, strictJson, type MarkupDialect } from "@xueness/providers";

type Row = Record<string, unknown>;

export type ParsedMarkupResult =
  | { ok: true; dialect: MarkupDialect; calls: { name: string; arguments: Row }[] }
  | { ok: false; code: string; instruction: string; dialect: MarkupDialect };

const TOOL_NAME_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_MARKUP_CALLS = 16;

const fail = (dialect: MarkupDialect, code: string, instruction: string): ParsedMarkupResult => ({ ok: false, code, instruction, dialect });
const markupFail = (dialect: MarkupDialect): ParsedMarkupResult => fail(
  dialect,
  "native_markup_in_json_mode",
  'Do not emit <tool_call> markup or prose in JSON mode. Reply with only {"tool":"NAME","arguments":{...}} or {"answer":"...","evidence":[]}, or switch this provider profile to Native tool calling.',
);

/** Detect known model-native tool-call markup dialects anywhere in a reply (including prose-prefixed or truncated output). */
export function detectNativeToolMarkup(content: string): MarkupDialect | null {
  if (typeof content !== "string" || !content) return null;
  if (/<function_calls>|<invoke\s+name=/iu.test(content)) return "function_calls_xml";
  if (/<tool_call>\s*[\s\S]*?<arg_key>/iu.test(content) || /<arg_key>[\s\S]*?<\/arg_key>\s*<arg_value>/iu.test(content)) return "xml_tool_call_kv";
  if (/<tool_call>/iu.test(content)) return "xml_tool_call_json";
  return null;
}

function schemaProperty(tools: readonly Row[], toolName: string, key: string): Row | null {
  const schema = tools.find((entry) => isDict(entry.function) && entry.function.name === toolName);
  const params = schema && isDict(schema.function) && isDict(schema.function.parameters) ? schema.function.parameters : null;
  const props = params && isDict(params.properties) ? params.properties : null;
  return props && isDict(props[key]) ? (props[key] as Row) : null;
}

function coerceKvValue(rawValue: string, propSchema: Row | null): unknown {
  const declaredType = typeof propSchema?.type === "string"
    ? propSchema.type
    : Array.isArray(propSchema?.type) && propSchema.type.every((item) => typeof item === "string")
      ? (propSchema.type.find((item) => item !== "null") ?? null)
      : null;
  if (declaredType === "string") return rawValue;
  const trimmed = rawValue.trim();
  if (declaredType === "boolean") {
    if (trimmed === "true") return true;
    if (trimmed === "false") return false;
    return rawValue;
  }
  if (declaredType === "integer" || declaredType === "number") {
    try {
      const parsed = strictJson(trimmed);
      if (typeof parsed === "number" && Number.isFinite(parsed) && (declaredType === "number" || Number.isInteger(parsed))) return parsed;
    } catch { /* leave raw text so schema validation rejects unambiguously */ }
    return rawValue;
  }
  if (declaredType === "array" || declaredType === "object") {
    try {
      const parsed = strictJson(trimmed);
      if ((declaredType === "array" && Array.isArray(parsed)) || (declaredType === "object" && isDict(parsed))) return parsed;
    } catch { /* leave raw text */ }
    return rawValue;
  }
  // Absent schema property: convert unambiguous JSON primitives/containers, keep arbitrary text verbatim.
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(trimmed)) {
    try {
      const num = strictJson(trimmed);
      if (typeof num === "number" && Number.isFinite(num)) return num;
    } catch { /* fall through */ }
  }
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    try {
      const container = strictJson(trimmed);
      if (isDict(container) || Array.isArray(container)) return container;
    } catch { /* keep raw text */ }
  }
  return rawValue;
}

function parseJsonMarkupBlock(inner: string): { ok: true; call: { name: string; arguments: Row } } | { ok: false; res: ParsedMarkupResult } {
  if (!inner.endsWith("}")) return { ok: false, res: markupFail("xml_tool_call_json") };
  let obj: unknown;
  try {
    obj = strictJson(inner);
  } catch (error) {
    if (error instanceof Error && error.name === "DuplicateKey") {
      return { ok: false, res: fail("xml_tool_call_json", "duplicate_json_key", "Duplicate keys are not allowed in tool arguments.") };
    }
    return { ok: false, res: markupFail("xml_tool_call_json") };
  }
  if (!isDict(obj)) return { ok: false, res: markupFail("xml_tool_call_json") };
  try { finiteJsonText(obj); } catch {
    return { ok: false, res: fail("xml_tool_call_json", "invalid_json_value", "Use finite JSON numbers and valid Unicode text without unpaired UTF-16 surrogates.") };
  }
  const allowedKeys = Object.keys(obj).every((key) => key === "name" || key === "tool" || key === "arguments");
  const hasName = Object.hasOwn(obj, "name"), hasTool = Object.hasOwn(obj, "tool");
  const rawName = hasName ? obj.name : obj.tool;
  if (!allowedKeys || (hasName && hasTool) || typeof rawName !== "string" || !TOOL_NAME_RE.test(rawName.trim()) || !Object.hasOwn(obj, "arguments")) {
    return { ok: false, res: markupFail("xml_tool_call_json") };
  }
  const name = rawName.trim();
  let args: Row;
  if (isDict(obj.arguments)) args = obj.arguments;
  else if (typeof obj.arguments === "string") {
    try { args = argumentsObject(obj.arguments); } catch { return { ok: false, res: markupFail("xml_tool_call_json") }; }
  } else {
    return { ok: false, res: markupFail("xml_tool_call_json") };
  }
  return { ok: true, call: { name, arguments: args } };
}

function parseKvMarkupBlock(inner: string, tools: readonly Row[]): { ok: true; call: { name: string; arguments: Row } } | { ok: false; res: ParsedMarkupResult } {
  const firstKey = inner.indexOf("<arg_key>");
  const namePart = (firstKey < 0 ? inner : inner.slice(0, firstKey)).trim();
  if (!TOOL_NAME_RE.test(namePart)) return { ok: false, res: markupFail("xml_tool_call_kv") };
  const rest = firstKey < 0 ? "" : inner.slice(firstKey);
  const args: Row = {};
  const pairRe = /\s*<arg_key>([\s\S]*?)<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>\s*/gy;
  let cursor = 0;
  while (cursor < rest.length) {
    pairRe.lastIndex = cursor;
    const match = pairRe.exec(rest);
    if (!match) return { ok: false, res: markupFail("xml_tool_call_kv") };
    const key = match[1]!.trim();
    const rawValue = match[2]!;
    if (!key || /<\/?arg_(?:key|value)>/i.test(key) || /<\/?arg_(?:key|value)>/i.test(rawValue)) {
      return { ok: false, res: markupFail("xml_tool_call_kv") };
    }
    if (Object.hasOwn(args, key)) {
      return { ok: false, res: fail("xml_tool_call_kv", "duplicate_json_key", "Duplicate argument keys are not allowed inside <tool_call>.") };
    }
    args[key] = coerceKvValue(rawValue, schemaProperty(tools, namePart, key));
    cursor = pairRe.lastIndex;
  }
  try { finiteJsonText(args); } catch {
    return { ok: false, res: fail("xml_tool_call_kv", "invalid_json_value", "Use valid Unicode text without unpaired UTF-16 surrogates in tool arguments.") };
  }
  return { ok: true, call: { name: namePart, arguments: args } };
}

const XML_FENCE = /^```xml[ \t]*\r?\n([\s\S]*)\r?\n```$/iu;

/**
 * Parse a whole-reply `<tool_call>...</tool_call>` payload (one or more closed
 * blocks with nothing else). Returns `null` when the reply is not purely closed
 * `<tool_call>` markup (e.g. mixed prose or truncated tags).
 */
export function parseWholeReplyToolMarkup(content: string, tools: readonly Row[]): ParsedMarkupResult | null {
  if (typeof content !== "string") return null;
  let text = envelopeText(content);
  const xmlFence = XML_FENCE.exec(text);
  if (xmlFence) text = xmlFence[1]!.trim();
  if (!text.startsWith("<tool_call>") || !text.endsWith("</tool_call>")) return null;
  const blocks: string[] = [];
  const blockRe = /\s*<tool_call>([\s\S]*?)<\/tool_call>\s*/gy;
  let cursor = 0;
  while (cursor < text.length) {
    blockRe.lastIndex = cursor;
    const match = blockRe.exec(text);
    if (!match || blocks.length >= MAX_MARKUP_CALLS) {
      return markupFail(detectNativeToolMarkup(text) ?? "xml_tool_call_kv");
    }
    const inner = match[1]!;
    if (/<\/?tool_call>/iu.test(inner)) return markupFail(detectNativeToolMarkup(text) ?? "xml_tool_call_kv");
    blocks.push(inner);
    cursor = blockRe.lastIndex;
  }
  if (!blocks.length) return null;
  const calls: { name: string; arguments: Row }[] = [];
  let dialect: MarkupDialect = "xml_tool_call_kv";
  for (const inner of blocks) {
    const trimmed = inner.trim();
    const parsed = trimmed.startsWith("{") ? parseJsonMarkupBlock(trimmed) : parseKvMarkupBlock(inner, tools);
    if (!parsed.ok) return parsed.res;
    dialect = trimmed.startsWith("{") ? "xml_tool_call_json" : "xml_tool_call_kv";
    calls.push(parsed.call);
  }
  return { ok: true, dialect, calls };
}
