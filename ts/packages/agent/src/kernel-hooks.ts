import type { ToolDefinition } from "@xueness/engine-tools";
import type { Context } from "@xueness/kernel";
import type { AgentPluginHooks } from "./types.ts";

const SAFE_GATES = new Set(["read", "list", "glob", "grep", "goal_read", "todo_read", "tool_result_read", "read_session_context"]);
/** Registry ownership is the single source of truth; policy stays bound to state. */
export function kernelAgentHooks(kernel: Context, options: Pick<AgentPluginHooks, "enabled" | "extensions" | "showReasoning" | "propagateCancellation" | "requiredCapabilities">): AgentPluginHooks {
  if (kernel.restricted) throw new TypeError("agent schema discovery requires the kernel context");
  return {
    ...options,
    toolOwner: (name) => kernel.tools.ownerOf(name),
    tools: () => kernel.tools.list<ToolDefinition>().map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.modelSchema ?? tool.inputSchema } })),
    concurrencySafe: (name) => {
      const tool = kernel.tools.get(name);
      return tool?.concurrencySafe === true && !tool.mutating && SAFE_GATES.has(tool.gate);
    },
  };
}
