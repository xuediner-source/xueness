import assert from "node:assert/strict";
import { it } from "node:test";
import { pyJsonDumps, pyLen, pySubstring } from "@xueness/contracts";
import type { AgentContext, ModelRequest, Row } from "@xueness/agent";
import { createToolEnv, FileStateTracker, runTool, type ToolDefinition, type ToolEnv } from "@xueness/engine-tools";
import { Context } from "@xueness/kernel";
import { MAX_TOOL_MODEL_BYTES, providerToolResultBudgetExtension } from "../src/result-budget.ts";
import { createProviderResultTools } from "../src/result-tool.ts";

const sessionId = "current-session";
interface SessionScope extends Row { id: unknown; results: unknown }

it("budgets multilingual tool text in UTF-8, includes its result pointer, and leaves journal input untouched", async () => {
  const content = "头".repeat(24000) + "🙂".repeat(3000) + "尾".repeat(24000);
  const refs = [{ id: "media-ref", placeholder: "image-1" }];
  const message: Row = { role: "tool", tool_call_id: "call-123", content, _media_refs: refs, custom: { retained: true } };
  const request: ModelRequest = { messages: [message], tools: [], options: {} };
  const original = structuredClone(request);
  const extension = providerToolResultBudgetExtension();
  const projected = await extension.prepareRequest!({} as AgentContext, request);
  const result = projected.messages[0]!;
  const bounded = result.content as string;

  assert.ok(Buffer.byteLength(bounded, "utf8") <= MAX_TOOL_MODEL_BYTES);
  assert.ok(bounded.startsWith("头"));
  assert.ok(bounded.endsWith("尾"));
  assert.match(bounded, /Full result is in tool_result_read\(tool_call_id='call-123',offset=0,limit=4000\)\./);
  assert.deepEqual(result._media_refs, refs);
  assert.deepEqual(result.custom, { retained: true });
  assert.deepEqual(result._result_budget, {
    originalBytes: Buffer.byteLength(content, "utf8"), returnedBytes: Buffer.byteLength(bounded, "utf8"), truncated: true,
  });
  assert.deepEqual(request, original);
});

it("keeps small strings and structured tool content unchanged", async () => {
  const small: Row = { role: "tool", tool_call_id: "small", content: "tiny result", _media_refs: [{ id: "ref" }] };
  const structured: Row = { role: "tool", tool_call_id: "media", content: [{ type: "image", data: "opaque" }], _media_refs: [{ id: "image-ref" }] };
  const request: ModelRequest = { messages: [small, structured], tools: [], options: {} };
  const projected = await providerToolResultBudgetExtension().prepareRequest!({} as AgentContext, request);
  assert.equal(projected, request);
  assert.equal(projected.messages[0], small);
  assert.equal(projected.messages[1], structured);
  assert.equal(Object.hasOwn(small, "_result_budget"), false);
});

async function resultTool(getSession: () => Row | null): Promise<{ kernel: Context; tool: ToolDefinition<Row> }> {
  const kernel = Context.create();
  await createProviderResultTools(getSession, { catalog: () => [] }).plugin.apply(kernel, {});
  const tool = kernel.tools.get<ToolDefinition<Row>>("tool_result_read");
  assert.ok(tool);
  return { kernel, tool };
}

function toolEnv(owner: string, currentSession: () => SessionScope | null): ToolEnv {
  const base = createToolEnv({ cwd: process.cwd(), roots: [process.cwd()], artifactsDir: `${process.cwd()}-artifacts` });
  return Object.assign(base, { owner, currentSession });
}

it("pages the sanitized stored result with Unicode character offsets and nextOffset", async () => {
  const stored = { ok: true, data: { text: "a🙂b漢字" }, media: [{ data: "large media bytes" }], _read_state: { private: true } };
  const expected = pyJsonDumps({ ok: true, data: { text: "a🙂b漢字" } });
  const current: SessionScope = { id: sessionId, results: { "call-page": stored } };
  const { kernel, tool } = await resultTool(() => current);
  try {
    assert.equal(kernel.tools.ownerOf("tool_result_read"), "kernel");
    assert.equal(tool.gate, "tool_result_read");
    assert.equal(tool.mutating, false);
    assert.equal(tool.concurrencySafe, true);
    const env = toolEnv(sessionId, () => current);
    const first = await runTool(tool, { tool_call_id: "call-page", offset: 0, limit: 8 }, env);
    assert.equal(first.ok, true);
    assert.equal(first.output, pySubstring(expected, 0, 8));
    assert.deepEqual(first.data, {
      tool_call_id: "call-page", offset: 0, nextOffset: 8, totalChars: pyLen(expected), truncated: true, sourceType: "stored_result",
      page_instruction: "Continue with tool_result_read(tool_call_id='call-page',offset=8,limit=8); offsets count Unicode characters.",
    });
    const firstData = first.data as { nextOffset: number | null };
    const next = await runTool(tool, { tool_call_id: "call-page", offset: firstData.nextOffset ?? 0, limit: 8 }, env);
    assert.equal(next.output, pySubstring(expected, 8, 16));
    assert.equal((next.data as { offset: number } | undefined)?.offset, 8);
  } finally { await kernel.dispose(); }
});

it("uses the environment's current owned session and returns unknown_tool_result for missing or foreign ids", async () => {
  const parent: SessionScope = { id: "parent", results: { parentCall: { ok: true, value: "parent secret" } } };
  const child: SessionScope = { id: "child", results: { childCall: { ok: true, value: "child result" } } };
  let fallbackReads = 0;
  let bound: SessionScope | null = child;
  const { kernel, tool } = await resultTool(() => { fallbackReads += 1; return parent; });
  try {
    const env = toolEnv("child", () => bound);
    const own = await runTool(tool, { tool_call_id: "childCall" }, env);
    assert.equal(own.ok, true);
    assert.match(own.output, /child result/);
    assert.equal(fallbackReads, 0);
    const absent = await runTool(tool, { tool_call_id: "missing" }, env);
    assert.equal(absent.error?.code, "unknown_tool_result");
    bound = parent;
    const foreign = await runTool(tool, { tool_call_id: "parentCall" }, env);
    assert.equal(foreign.error?.code, "unknown_tool_result");
    assert.doesNotMatch(foreign.output, /parent secret/);
  } finally { await kernel.dispose(); }
});
