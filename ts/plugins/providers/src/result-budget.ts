import type { AgentExtension, ModelRequest, Row } from "@xueness/agent";

export const MAX_TOOL_MODEL_BYTES = 65536;
/** Compactable tool-result groups kept in full. Older groups, and results a later call replaced, become short pointers. */
export const TOOL_RESULT_KEEP_RECENT_GROUPS = 5;
const MIN_EXPIRE_CHARS = 256;
const COMPACTABLE_TOOLS = new Set([
  "Read", "Bash", "Grep", "Glob", "WebFetch", "WebSearch", "Edit", "Write", "ApplyPatch",
  "read", "exec", "grep", "glob", "web_fetch", "web_search", "edit", "write", "apply_patch", "list",
]);
const READ_TOOLS = new Set(["Read", "read"]);
const WRITE_TOOLS = new Set(["Write", "write", "Edit", "edit"]);

export function expiredToolResultStub(toolCallId: string): string {
  return `[Expired tool result cleared from the model window. Full text remains in the session; page it with tool_result_read(tool_call_id='${toolCallId}',offset=0,limit=4000).]`;
}
export function supersededToolResultStub(toolCallId: string, newerId: string): string {
  return `[Superseded by a later result (${newerId}). Full text remains in the session; page it with tool_result_read(tool_call_id='${toolCallId}',offset=0,limit=4000).]`;
}

function settled(content: string): boolean {
  return content.startsWith("[Expired tool result ") || content.startsWith("[Superseded by a later result") || content === "[Old tool result content cleared]";
}
function isErrorResult(content: string): boolean {
  if (content.startsWith("<tool_use_error>")) return true;
  if (!content.startsWith("{")) return false;
  try {
    const parsed = JSON.parse(content) as unknown;
    return !!parsed && typeof parsed === "object" && !Array.isArray(parsed) && (parsed as Row).ok === false;
  } catch { return false; }
}
function argsOf(raw: unknown): Row {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Row;
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Row : {};
  } catch { return {}; }
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Row;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
function pathOf(args: Row): string {
  const path = typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : "";
  return path.replaceAll("\\", "/");
}

interface ToolHit { index: number; id: string; name: string; key: string; path: string; content: string; error: boolean; group: number }

/**
 * Request-view only. The journal and stored tool result stay intact, so
 * `tool_result_read` can still page a result this pass replaced with a stub.
 * The latest groups stay in full. An earlier result is also stubbed when a
 * later call repeats it, or when a later write/edit replaces a file that was read.
 */
export function expireToolResults(messages: readonly Row[], keepRecentGroups = TOOL_RESULT_KEEP_RECENT_GROUPS): Row[] {
  const calls = new Map<string, { name: string; key: string; path: string }>();
  let group = -1;
  const hits: ToolHit[] = [];
  messages.forEach((message, index) => {
    if (message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length) {
      group += 1;
      for (const call of message.tool_calls) {
        if (!call || typeof call !== "object") continue;
        const row = call as Row;
        const fn = row.function && typeof row.function === "object" ? row.function as Row : {};
        const id = typeof row.id === "string" ? row.id : "";
        const name = typeof fn.name === "string" ? fn.name : "";
        if (!id || !name) continue;
        const args = argsOf(fn.arguments);
        calls.set(id, { name, key: `${name}\0${stable(args)}`, path: pathOf(args) });
      }
      return;
    }
    if (message.role !== "tool" || typeof message.tool_call_id !== "string" || typeof message.content !== "string") return;
    const known = calls.get(message.tool_call_id);
    if (!known || !COMPACTABLE_TOOLS.has(known.name)) return;
    hits.push({ index, id: message.tool_call_id, name: known.name, key: known.key, path: known.path, content: message.content, error: isErrorResult(message.content), group });
  });
  if (!hits.length) return messages as Row[];

  const latestByKey = new Map<string, string>();
  for (const hit of hits) if (!hit.error) latestByKey.set(hit.key, hit.id);
  const lastWriteByPath = new Map<string, string>();
  const writeAfter = new Map<string, string>();
  for (let index = hits.length - 1; index >= 0; index -= 1) {
    const hit = hits[index]!;
    if (hit.error || !hit.path) continue;
    if (WRITE_TOOLS.has(hit.name)) lastWriteByPath.set(hit.path, hit.id);
    else if (READ_TOOLS.has(hit.name)) {
      const newer = lastWriteByPath.get(hit.path);
      if (newer) writeAfter.set(hit.id, newer);
    }
  }
  const maxGroup = hits.reduce((max, hit) => Math.max(max, hit.group), -1);
  const oldestKept = maxGroup - (Math.max(1, keepRecentGroups) - 1);
  const replacements = new Map<number, string>();
  for (const hit of hits) {
    if (hit.error || settled(hit.content)) continue;
    const newerKey = latestByKey.get(hit.key);
    const newerWrite = writeAfter.get(hit.id);
    const superseded = (!!newerKey && newerKey !== hit.id) || !!newerWrite;
    const aged = hit.group >= 0 && hit.group < oldestKept && hit.content.length >= MIN_EXPIRE_CHARS;
    if (!superseded && !aged) continue;
    const newerId = newerKey && newerKey !== hit.id ? newerKey : newerWrite;
    const stub = superseded && newerId ? supersededToolResultStub(hit.id, newerId) : expiredToolResultStub(hit.id);
    if (hit.content.length <= stub.length) continue;
    replacements.set(hit.index, stub);
  }
  if (!replacements.size) return messages as Row[];
  return messages.map((message, index) => replacements.has(index) ? { ...message, content: replacements.get(index)! } : message);
}
const OMITTED = "\n\n[... middle omitted ...]\n\n";

const utf8Bytes = (value: string): number => Buffer.byteLength(value, "utf8");

function prefixByBytes(value: string, maxBytes: number): string {
  let end = 0;
  let bytes = 0;
  while (end < value.length) {
    const code = value.codePointAt(end)!;
    const width = code > 0xffff ? 2 : 1;
    const size = utf8Bytes(value.slice(end, end + width));
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += width;
  }
  return value.slice(0, end);
}

function suffixByBytes(value: string, maxBytes: number): string {
  let start = value.length;
  let bytes = 0;
  while (start > 0) {
    let begin = start - 1;
    const last = value.charCodeAt(begin);
    if (last >= 0xdc00 && last <= 0xdfff && begin > 0) {
      const prior = value.charCodeAt(begin - 1);
      if (prior >= 0xd800 && prior <= 0xdbff) begin -= 1;
    }
    const size = utf8Bytes(value.slice(begin, start));
    if (bytes + size > maxBytes) break;
    bytes += size;
    start = begin;
  }
  return value.slice(start);
}

function truncate(content: string, toolCallId: string): string {
  const pointer = `Full result is in tool_result_read(tool_call_id='${toolCallId}',offset=0,limit=4000).`;
  const framing = `${OMITTED}${pointer}${OMITTED}`;
  const available = Math.max(0, MAX_TOOL_MODEL_BYTES - utf8Bytes(framing));
  const head = Math.ceil(available / 2);
  const tail = available - head;
  return prefixByBytes(content, head) + framing + suffixByBytes(content, tail);
}

/** Request-only projection; the journal and stored tool result are never rewritten. */
export function providerToolResultBudgetExtension(): AgentExtension {
  return {
    id: "providers",
    capabilities: ["providers.tool_result_budget"],
    prepareRequest(_context, request: ModelRequest) {
      const expired = expireToolResults(request.messages);
      let changed = expired !== request.messages;
      const messages = expired.map((message) => {
        if (message.role !== "tool" || typeof message.content !== "string") return message;
        const originalBytes = utf8Bytes(message.content);
        if (originalBytes <= MAX_TOOL_MODEL_BYTES) return message;
        changed = true;
        const content = truncate(message.content, typeof message.tool_call_id === "string" ? message.tool_call_id : "");
        return { ...message, content, _result_budget: { originalBytes, returnedBytes: utf8Bytes(content), truncated: true } };
      });
      return changed ? { ...request, messages } : request;
    },
  };
}
