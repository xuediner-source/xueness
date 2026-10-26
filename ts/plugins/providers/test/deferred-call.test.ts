/**
 * The DeferredToolCall wrapper tool (C-TOOL-04, F02.03): registered like any
 * providers tool so ownership and exposure are real, while its own run stays
 * an honest stable failure — the agent runtime's admission is the only
 * execution path, so a direct bridge call can never fake a result.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createToolEnv, runTool, toolSafetyMetadata, type ToolDefinition } from "@xueness/engine-tools";
import { Context, PluginHost } from "@xueness/kernel";
import { PermissionSession } from "@xueness/permissions";
import { ToolBridge } from "@xueness/tool-bridge";
import { createProviderResultTools } from "../src/index.ts";
import { DEFERRED_TOOL_CALL } from "@xueness/providers";

async function started(): Promise<{ kernel: Context; host: PluginHost; wrapper: ToolDefinition; close(): Promise<void> }> {
  const kernel = Context.create();
  const host = new PluginHost(kernel, [createProviderResultTools(() => null, { catalog: () => [] })], { enabled: { providers: true } });
  const statuses = await host.start();
  try {
    assert.equal(statuses[0]?.state, "active", statuses[0]?.error ?? statuses[0]?.issues.join("; ") ?? "providers must start");
  } catch (error) {
    await host.dispose();
    await kernel.dispose();
    throw error;
  }
  const wrapper = kernel.tools.get<ToolDefinition>(DEFERRED_TOOL_CALL);
  assert.ok(wrapper, "deferred_tool_call must register");
  return { kernel, host, wrapper, close: async () => { await host.dispose(); await kernel.dispose(); } };
}

function bridgeOf(kernel: Context, owner: string): ToolBridge {
  return new ToolBridge({ kernel, permissions: new PermissionSession({ mode: "build" }), env: createToolEnv({ cwd: process.cwd(), artifactsDir: `${process.cwd()}-artifacts`, owner }) });
}

describe("deferred_tool_call registration", () => {
  it("registers through ctx.tool with providers ownership and envelope-safe metadata", async () => {
    const { kernel, close, wrapper } = await started();
    try {
      assert.equal(kernel.tools.ownerOf(DEFERRED_TOOL_CALL), "providers");
      assert.equal(wrapper.gate, "tool_search", "the envelope shares the discovery gate; admission dispatches before the bridge in agent flows");
      assert.equal(wrapper.mutating, false);
      assert.equal(wrapper.concurrencySafe, false, "the target's concurrency class is unknown until unwrap, so the envelope never batches");
      assert.equal(toolSafetyMetadata(wrapper).readOnly, true);
    } finally { await close(); }
  });

  it("fails stably instead of faking success when a direct bridge call reaches the wrapper", async () => {
    const { kernel, close } = await started();
    try {
      const bridge = bridgeOf(kernel, "s1");
      const result = await bridge.call({ id: "c1", name: DEFERRED_TOOL_CALL, input: { tool: "alpha_two", input: {} } });
      assert.equal(result.ok, false);
      assert.equal(result.error?.code, "deferred_call_unavailable");
      assert.match(String(result.output), /envelope|unwraps/i);
    } finally { await close(); }
  });

  it("answers a malformed envelope with the wrapper schema's validation issue", async () => {
    const { kernel, close } = await started();
    try {
      const bridge = bridgeOf(kernel, "s1");
      const result = await bridge.call({ id: "c1", name: DEFERRED_TOOL_CALL, input: { tool: 42 } });
      assert.equal(result.ok, false);
      assert.equal(result.error?.code, "invalid_argument");
      assert.match(String(result.error?.message), /tool/);
    } finally { await close(); }
  });

  it("runs honestly through runTool as well, so no entry point returns a silent success", async () => {
    const { wrapper, close } = await started();
    try {
      const result = await runTool(wrapper, { tool: "alpha_two" }, createToolEnv({ cwd: process.cwd(), artifactsDir: `${process.cwd()}-artifacts` }));
      assert.equal(result.ok, false);
      assert.equal(result.error?.code, "deferred_call_unavailable");
    } finally { await close(); }
  });
});
