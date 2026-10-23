/**
 * MCP tool names, schemas, approval subjects and result text.
 *
 * Ported from the Python plugin (`xueness/bundled_plugins/mcp/mcp.py`) so
 * that sessions keep their tool names across executors: `mcp__<server id>__<tool>`,
 * the tool part sanitized like ZCode `core/mcp/name.ts` (`toModelVisibleMcpNamePart`),
 * but `.` kept as Python does. Result text follows ZCode `formatMcpToolResult`
 * (text blocks, resource text, "Structured content:"), with ZCode's 50 000-byte
 * model budget instead of Python's 2000 characters.
 */
import { isDict, pyJsonDumps } from "@xueness/contracts";

export const MCP_PREFIX = "mcp__";
export const RESERVED_NAMES: ReadonlySet<string> = new Set([".", ".."]);
const ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
export const TRUNCATION_SUFFIX = "…(truncated)";
/** ZCode `createMcpToolEntry` resultBudget.maxModelBytes for an ordinary MCP tool. */
export const MCP_MODEL_BYTES = 50_000;
/** Python `_xueness_*` catalog results are clipped to this many characters. */
export const CATALOG_CHARS = 12_000;

export type Row = Record<string, unknown>;

/** A usable server id or tool name: `[A-Za-z0-9._-]{1,64}`, never `.` or `..`. */
export function validName(value: unknown): value is string {
  return typeof value === "string" && !RESERVED_NAMES.has(value) && ID_PATTERN.test(value);
}

export function namespaced(serverId: string, toolName: string): string {
  return `${MCP_PREFIX}${serverId}__${toolName}`;
}

/** `mcp__a__b__c` → ["a", "b__c"]: the earliest split where both halves are legal wins. */
export function parseNamespaced(name: unknown): [string, string] | null {
  if (typeof name !== "string" || !name.startsWith(MCP_PREFIX)) return null;
  const rest = name.slice(MCP_PREFIX.length);
  for (let index = rest.indexOf("__"); index !== -1; index = rest.indexOf("__", index + 1)) {
    const server = rest.slice(0, index);
    const tool = rest.slice(index + 2);
    if (validName(server) && validName(tool)) return [server, tool];
  }
  return null;
}

/** Python `sanitize_mcp_name_part` (`str.strip()` whitespace, code-point slice). */
export function sanitizeNamePart(name: unknown): string {
  if (typeof name !== "string" || !pyStrip(name)) return "unnamed";
  let sanitized = pyStrip(name).replace(/[^A-Za-z0-9._-]/gu, "_").replace(/_+/g, "_");
  if (!sanitized || RESERVED_NAMES.has(sanitized)) return "tool";
  sanitized = Array.from(sanitized).slice(0, 64).join("");
  return sanitized;
}

// Python str.strip() with no argument strips Unicode whitespace (str.isspace).
const PY_SPACE = "\\t\\n\\u000b\\f\\r\\u001c-\\u001f \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const STRIP = new RegExp(`^[${PY_SPACE}]+|[${PY_SPACE}]+$`, "gu");
export function pyStrip(text: string): string {
  return text.replace(STRIP, "");
}

/** The OpenAI function schema the model sees for one server tool. */
export function toolSchema(serverId: string, tool: unknown): Row {
  const item = isDict(tool) ? tool : {};
  const name = typeof item.name !== "string" || !pyStrip(item.name) ? "unnamed" : sanitizeNamePart(item.name);
  const description = typeof item.description === "string" ? item.description : "";
  const parameters = isDict(item.inputSchema) ? item.inputSchema : { type: "object", properties: {} };
  return { type: "function", function: { name: namespaced(serverId, name), description, parameters } };
}

/** Python `mcp_subject`: the tool name is part of what an approval binds to. */
export function mcpSubject(toolName: string, args: unknown): string {
  return pyJsonDumps({ tool: toolName, arguments: isDict(args) ? args : {} }, { sortKeys: true, separators: [",", ":"] });
}

/** Keep at most `maxBytes` UTF-8 bytes, cutting on a code point and marking the cut. */
export function clipBytes(text: string, maxBytes: number): string {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= maxBytes) return text;
  const budget = Math.max(0, maxBytes - Buffer.byteLength(TRUNCATION_SUFFIX, "utf8"));
  let used = 0;
  let out = "";
  for (const char of text) {
    const size = Buffer.byteLength(char, "utf8");
    if (used + size > budget) break;
    used += size;
    out += char;
  }
  return out + TRUNCATION_SUFFIX;
}

/** Python `clip`: code-point length with the truncation marker. */
export function clipChars(text: string, maxChars: number): string {
  const chars = Array.from(text);
  if (!maxChars || chars.length <= maxChars) return text;
  const keep = maxChars - Array.from(TRUNCATION_SUFFIX).length;
  if (keep <= 0) return Array.from(TRUNCATION_SUFFIX).slice(0, maxChars).join("");
  return chars.slice(0, keep).join("") + TRUNCATION_SUFFIX;
}

/** Python `_extract_text`: text blocks, resource text, otherwise the resource as JSON. */
export function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (!isDict(item)) continue;
    if (item.type === "text" && typeof item.text === "string") parts.push(item.text);
    else if (item.type === "resource" && isDict(item.resource)) {
      parts.push(typeof item.resource.text === "string" ? item.resource.text : "MCP resource: " + pyJsonDumps(item.resource, { ensureAscii: false }));
    }
  }
  return parts.join("\n");
}

export interface CallText { ok: boolean; text: string }

/** A `tools/call` result as model text; `isError: true` is a failed call. */
export function callResultText(result: Row, maxBytes = MCP_MODEL_BYTES): CallText {
  const raw = extractText(result.content);
  const structured = result.structuredContent;
  let text = raw;
  if ((Array.isArray(structured) && structured.length) || (isDict(structured) && Object.keys(structured).length)) {
    const block = "Structured content:\n" + pyJsonDumps(structured, { ensureAscii: false, indent: 2 });
    text = raw ? raw + "\n\n" + block : block;
  }
  return { ok: result.isError !== true, text: clipBytes(text, maxBytes) };
}
