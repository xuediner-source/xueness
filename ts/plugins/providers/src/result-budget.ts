import type { AgentExtension, ModelRequest, Row } from "@xueness/agent";

export const MAX_TOOL_MODEL_BYTES = 65536;
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
      let changed = false;
      const messages = request.messages.map((message) => {
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
