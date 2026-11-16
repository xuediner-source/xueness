import type { AgentExtension, ModelRequest, Row } from "@xueness/agent";

export const MAX_TOOL_MODEL_BYTES = 65536;
/** Compactable tool-result groups kept in full. Older groups, and results a later call replaced, become short pointers. */
export const TOOL_RESULT_KEEP_RECENT_GROUPS = 5;
const MIN_EXPIRE_CHARS = 256;
const COMPACTABLE_TOOLS = new Set([
  "Read", "Bash", "Grep", "Glob", "WebFetch", "WebSearch", "Edit", "Write", "ApplyPatch",
  "read", "exec", "grep", "glob", "web_fetch", "web_search", "edit", "write", "apply_patch", "list",
]);

export function expiredToolResultStub(toolCallId: string): string {
  return `[Expired tool result cleared from the model window. Full text remains in the session; page it with tool_result_read(tool_call_id='${toolCallId}',offset=0,limit=4000).]`;
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
/** Share of the model's window at which a standard-profile request starts clearing old tool results. */
export const TOOL_RESULT_CLEAR_TRIGGER = 0.6;

/**
 * Threshold clearing for large-context models. Nothing is touched while the
 * request is comfortably inside the window. Once `advance` is set (the
 * request passed the trigger), every compactable result older than the latest
 * `keepRecentGroups` groups becomes a pointer, and the id of the newest
 * cleared result is returned as the boundary. Later requests clear up to that
 * same boundary whether or not they are over the trigger, so the cleared part
 * of the history is byte-stable and a prompt cache keeps reusing it; the
 * boundary only ever moves forward. No result is cleared because a later call
 * repeated it: that would rewrite the middle of the history at any step.
 */
export function clearToolResultsBefore(messages: readonly Row[], boundary: string | null, advance: boolean, keepRecentGroups = TOOL_RESULT_KEEP_RECENT_GROUPS): { messages: Row[]; boundary: string | null } {
  const owners = new Map<string, string>();
  let group = -1;
  const hits: { index: number; id: string; content: string; group: number }[] = [];
  messages.forEach((message, index) => {
    if (message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length) {
      group += 1;
      for (const call of message.tool_calls) {
        const row = call && typeof call === "object" ? call as Row : {};
        const fn = row.function && typeof row.function === "object" ? row.function as Row : {};
        if (typeof row.id === "string" && typeof fn.name === "string") owners.set(row.id, fn.name);
      }
      return;
    }
    if (message.role !== "tool" || typeof message.tool_call_id !== "string" || typeof message.content !== "string") return;
    if (!COMPACTABLE_TOOLS.has(owners.get(message.tool_call_id) ?? "")) return;
    hits.push({ index, id: message.tool_call_id, content: message.content, group });
  });
  let limit = boundary ? hits.find((hit) => hit.id === boundary)?.group ?? -1 : -1;
  if (advance) limit = Math.max(limit, group - Math.max(1, keepRecentGroups));
  if (limit < 0) return { messages: messages as Row[], boundary: null };
  const replacements = new Map<number, string>();
  let last: string | null = null;
  for (const hit of hits) {
    if (hit.group > limit) break;
    last = hit.id;
    if (isErrorResult(hit.content) || settled(hit.content) || hit.content.length < MIN_EXPIRE_CHARS) continue;
    replacements.set(hit.index, expiredToolResultStub(hit.id));
  }
  if (!replacements.size) return { messages: messages as Row[], boundary: last ?? boundary };
  return { messages: messages.map((message, index) => replacements.has(index) ? { ...message, content: replacements.get(index)! } : message), boundary: last };
}

/** A deliberately high estimate of a request's size in tokens (UTF-8 bytes / 3), enough to decide when to clear. */
function estimateRequestTokens(messages: readonly Row[]): number {
  let bytes = 0;
  for (const message of messages) {
    bytes += typeof message.content === "string" ? Buffer.byteLength(message.content, "utf8") : message.content == null ? 0 : Buffer.byteLength(JSON.stringify(message.content), "utf8");
    if (Array.isArray(message.tool_calls)) bytes += Buffer.byteLength(JSON.stringify(message.tool_calls), "utf8");
  }
  return Math.ceil(bytes / 3);
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
    prepareRequest(context, request: ModelRequest) {
      // A large-context model keeps everything until the request passes a share of its window, then
      // clears up to a boundary remembered on the session so the cleared prefix stays stable for the
      // prompt cache.
      const session = context?.session as Row | undefined;
      const lightweight = (session?.runtime_profile ?? context?.provider?.runtimeProfile) === "lightweight";
      let expired: Row[];
      // The lightweight view already holds every tool result to a page and drops whole exchanges at a
      // remembered boundary. Expiring results here as well ran after that view was budgeted and measured:
      // in JSON tool mode it matched nothing (results are plain text by then), and with native calls it
      // rewrote a message in the middle of the history on every step, which is exactly what a local
      // server's cache cannot reuse.
      if (lightweight) expired = request.messages as Row[];
      else {
        const window = Number(context?.provider?.contextWindow) || 0;
        const held = typeof session?.tool_result_clear_boundary === "string" ? session.tool_result_clear_boundary : null;
        const over = window > 0 && estimateRequestTokens(request.messages) > window * TOOL_RESULT_CLEAR_TRIGGER;
        const cleared = held || over ? clearToolResultsBefore(request.messages, held, over) : { messages: request.messages as Row[], boundary: held };
        expired = cleared.messages;
        if (session && cleared.boundary && cleared.boundary !== held) session.tool_result_clear_boundary = cleared.boundary;
      }
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
