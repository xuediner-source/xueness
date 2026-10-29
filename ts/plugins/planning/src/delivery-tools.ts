import { pyJsonDumps } from "@xueness/contracts";
import type { ToolDefinition } from "@xueness/engine-tools";
import { definePlugin, type BundledPlugin } from "@xueness/kernel";
import manifest from "../manifest.json" with { type: "json" };
import { planDelivery, type Row } from "./delivery.ts";
import { planningTaskTools, type PlanningToolsOptions } from "./task-tools.ts";
import { deliveryVerifyTool } from "./delivery-verify-tool.ts";
export function deliveryPlanTool(session: () => Row | null): ToolDefinition<{ items: unknown }> {
  return {
    name: "delivery_plan", description: "Register immutable output checks; each item needs a path, nonempty contains list, or min_links >= 1. Never register input/source paths as outputs.",
    gate: "todo_write", mutating: false, concurrencySafe: false, requires: {},
    inputSchema: { type: "object", additionalProperties: false, required: ["items"], properties: {
      items: { type: "array", minItems: 1, maxItems: 40, items: { type: "object", additionalProperties: false, required: ["id", "label"], properties: {
        id: { type: "string", pattern: "^[A-Za-z0-9_-]{1,64}$" }, label: { type: "string", minLength: 1, maxLength: 500 },
        path: { type: "string", minLength: 1, maxLength: 4096, description: "Explicit requested output path only; omit for chat-only checks." },
        contains: { type: "array", maxItems: 100, items: { type: "string", minLength: 1, maxLength: 300 } },
        min_links: { type: "integer", minimum: 0, maximum: 100, default: 0 },
      } } },
    } },
    async run(input) { const items = planDelivery(session(), input.items); return { ok: true, output: pyJsonDumps({ items }), data: { items } }; },
  };
}
export function createPlanning(options: PlanningToolsOptions): BundledPlugin {
  return { manifest, plugin: definePlugin({ name: "planning", apply(ctx) { ctx.tool(deliveryPlanTool(options.session)); ctx.tool(deliveryVerifyTool(options)); for (const tool of planningTaskTools(options)) ctx.tool(tool); } }) };
}
