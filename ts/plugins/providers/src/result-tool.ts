import { isDict, pyJsonDumps, pyLen, pySubstring, type JsonSchema } from "@xueness/contracts";
import type { Row } from "@xueness/agent";
import { definePlugin, type BundledPlugin } from "@xueness/kernel";
import { failure, type ToolDefinition, type ToolEnv, type ToolResult } from "@xueness/engine-tools";
import manifest from "../manifest.json" with { type: "json" };
import { createDeferredToolCallTool } from "./deferred-call.ts";
import { createToolSearchTool, type ProviderToolSearchBinding } from "./tool-search.ts";

const MAX_PAGE_CHARS = 4000;
const DEFAULT_PAGE_CHARS = 1200;

interface ResultReadInput { tool_call_id: string; offset?: number; limit?: number }
interface ResultReadData {
  tool_call_id: string;
  offset: number;
  nextOffset: number | null;
  totalChars: number;
  truncated: boolean;
  sourceType: "stored_result";
  page_instruction: string;
}
interface SessionResultScope { id: unknown; results: unknown }
type ScopedToolEnv = ToolEnv & { currentSession?: () => SessionResultScope | null };

const inputSchema: JsonSchema = {
  type: "object",
  properties: {
    tool_call_id: { type: "string", minLength: 1 },
    offset: { type: "integer", minimum: 0, default: 0 },
    limit: { type: "integer", minimum: 1, maximum: MAX_PAGE_CHARS, default: DEFAULT_PAGE_CHARS },
  },
  required: ["tool_call_id"],
  additionalProperties: false,
};

function storedResultText(value: unknown): string {
  if (!isDict(value)) return pyJsonDumps(value);
  const root = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "media" && key !== "_read_state"));
  return pyJsonDumps(root);
}

function readResult(session: () => Row | null, input: ResultReadInput, env: ToolEnv): ToolResult<ResultReadData> {
  const scopedEnv = env as ScopedToolEnv;
  const current = typeof scopedEnv.currentSession === "function" ? scopedEnv.currentSession() : session();
  if (!current || scopedEnv.owner !== undefined && current.id !== scopedEnv.owner) return failure("unknown_tool_result", `unknown tool result: ${input.tool_call_id}`);
  if (!isDict(current.results) || !Object.hasOwn(current.results, input.tool_call_id)) return failure("unknown_tool_result", `unknown tool result: ${input.tool_call_id}`);

  const text = storedResultText(current.results[input.tool_call_id]);
  const totalChars = pyLen(text);
  const offset = input.offset ?? 0;
  const limit = input.limit ?? DEFAULT_PAGE_CHARS;
  const start = Math.min(offset, totalChars);
  const end = Math.min(start + limit, totalChars);
  const output = pySubstring(text, start, end);
  const nextOffset = end < totalChars ? end : null;
  const page_instruction = nextOffset === null
    ? offset > totalChars ? `Offset ${offset} exceeds the stored result length ${totalChars}. Retry from offset 0..${totalChars}.` : "This stored-result page reaches the end; no further result page is available."
    : `Continue with tool_result_read(tool_call_id='${input.tool_call_id}',offset=${nextOffset},limit=${limit}); offsets count Unicode characters.`;
  return {
    ok: true,
    output,
    data: { tool_call_id: input.tool_call_id, offset, nextOffset, totalChars, truncated: nextOffset !== null, sourceType: "stored_result", page_instruction },
  };
}

/**
 * The providers tool face: bounded stored-result paging, the generic
 * `tool_search` discovery executor and the DeferredToolCall envelope. The
 * search binding is required, so every host that builds this factory wires
 * the live kernel catalog (F02.02).
 */
export function providerResultTools(session: () => Row | null, tools: ProviderToolSearchBinding): ToolDefinition[] {
  const tool: ToolDefinition<ResultReadInput, ResultReadData> = {
    name: "tool_result_read",
    description: "Read a bounded page of the stored JSON text of a full recorded tool result from the current session.",
    inputSchema,
    gate: "tool_result_read",
    mutating: false,
    concurrencySafe: true,
    requires: {},
    async run(input, env) { return readResult(session, input, env); },
  };
  return [
    tool as unknown as ToolDefinition,
    createToolSearchTool(session, tools) as unknown as ToolDefinition,
    createDeferredToolCallTool() as unknown as ToolDefinition,
  ];
}

export function createProviderResultTools(session: () => Row | null, tools: ProviderToolSearchBinding): BundledPlugin {
  const plugin = definePlugin({ name: "providers", apply(ctx) {
    for (const tool of providerResultTools(session, tools)) ctx.tool(tool);
  } });
  return { manifest, plugin };
}
