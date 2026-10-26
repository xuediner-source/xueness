/**
 * The DeferredToolCall wrapper (C-TOOL-04, F02.03): the envelope tool the model
 * calls with `{tool, input}` to invoke a `shouldDefer` tool discovered this
 * turn. The agent runtime admits the envelope before dispatch (packages/agent
 * `tools.ts`) and unwraps it into a real call to the registered target, which
 * then runs through the same owner / active / ToolBridge path as a direct
 * call. The wrapper itself executes nothing: a direct bridge call that reaches
 * this run fails stably instead of faking a result — admission is the only
 * execution path, so no second permission table can grow around it.
 */
import { failure, type ToolDefinition, type ToolResult } from "@xueness/engine-tools";
import { DEFERRED_TOOL_CALL, DEFERRED_TOOL_CALL_SCHEMA } from "@xueness/providers";

interface DeferredCallData { target: string }

export function createDeferredToolCallTool(): ToolDefinition<Record<string, unknown>, DeferredCallData> {
  return {
    name: DEFERRED_TOOL_CALL,
    description: "Call a deferred tool by name in the same turn it was discovered: {tool} is the registered tool name returned by tool_search (marked deferred) and {input} holds that tool's arguments. " +
      "The runtime unwraps this envelope into the real tool call, which is checked and scheduled exactly like a direct call.",
    inputSchema: DEFERRED_TOOL_CALL_SCHEMA,
    // The envelope dispatches before the bridge in agent flows, so this gate only
    // shapes a direct bridge call: it never asks, and the run below fails stably.
    gate: "tool_search",
    mutating: false,
    // The target's concurrency class is unknown until unwrap; batching on the
    // wrapper could parallelize mutating targets, so the envelope never batches.
    concurrencySafe: false,
    requires: {},
    async run(input): Promise<ToolResult<DeferredCallData>> {
      const target = typeof input.tool === "string" ? input.tool.trim() : "";
      return failure("deferred_call_unavailable", "deferred_tool_call is an envelope the agent runtime unwraps before dispatch; it cannot run directly" +
        (target ? ` (target ${JSON.stringify(target)} must be admitted through a model turn)` : ""));
    },
  };
}
