import { toolExposure, type ToolDefinition } from "@xueness/engine-tools";
import type { Context } from "@xueness/kernel";
import type { AgentPluginHooks } from "./types.ts";

const SAFE_GATES = new Set(["read", "list", "glob", "grep", "goal_read", "todo_read", "tool_result_read", "tool_search", "read_session_context"]);
/** Registry ownership is the single source of truth; policy stays bound to state. */
export function kernelAgentHooks(kernel: Context, options: Pick<AgentPluginHooks, "enabled" | "extensions" | "showReasoning" | "propagateCancellation" | "requiredCapabilities" | "batchConcurrency">): AgentPluginHooks {
  if (kernel.restricted) throw new TypeError("agent schema discovery requires the kernel context");
  return {
    ...options,
    toolOwner: (name) => kernel.tools.ownerOf(name),
    // DeferredToolCall admission (C-TOOL-04) resolves the envelope's target
    // against this live registry view: classification shapes exposure only.
    toolDefinition: (name) => kernel.tools.get<ToolDefinition>(name) ?? null,
    // Standard-profile rule: every registered tool enters the request schema except
    // `shouldDefer` ones, which stay in the registry catalog for discovery. The
    // lightweight profile re-selects from this view; classification never grants power.
    tools: () => kernel.tools.list<ToolDefinition>().filter((tool) => toolExposure(tool) !== "deferred").map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.modelSchema ?? tool.inputSchema } })),
    concurrencySafe: (name) => {
      const tool = kernel.tools.get(name);
      return tool?.concurrencySafe === true && !tool.mutating && !tool.destructive && SAFE_GATES.has(tool.gate);
    },
  };
}
