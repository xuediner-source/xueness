import type { AgentContext, AgentExtension } from "@xueness/agent";
import type { McpActivityEvent, McpRuntimeBinding } from "./runtime.ts";

const MAX_QUEUED_EVENTS = 100;
const detach = new WeakMap<AgentContext, () => void>();
const queued = new WeakMap<AgentContext, McpActivityEvent[]>();

function enqueue(context: AgentContext, event: McpActivityEvent): void {
  const events = queued.get(context);
  if (!events) return;
  if (events.length === MAX_QUEUED_EVENTS) events.shift();
  events.push({ ...event });
}

function flush(context: AgentContext): void {
  const events = queued.get(context);
  if (!events) return;
  while (events.length) {
    context.emit({ ...events[0]! });
    events.shift();
  }
}

/** Binds activation-time and live MCP metadata events at durable run boundaries. */
export function mcpRuntimeExtension(binding: McpRuntimeBinding): AgentExtension {
  return {
    id: "mcp",
    capabilities: ["mcp.connections"],
    beforeRun(context) {
      detach.get(context)?.();
      queued.set(context, []);
      const port = binding.current;
      if (port) detach.set(context, port.onActivity((event) => enqueue(context, event)));
      flush(context);
    },
    beforeModelRequest: flush,
    toolResultRecorded: flush,
    settleRun: flush,
    close(context) {
      detach.get(context)?.();
      detach.delete(context);
      queued.delete(context);
    },
  };
}
