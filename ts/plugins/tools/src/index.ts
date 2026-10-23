/** Tool execution policy. Both switches default off. No model-facing tool. */
import { definePlugin, type BundledPlugin } from "@xueness/kernel";
import manifest from "../manifest.json" with { type: "json" };
import { afterToolExecution, beforeToolEffect } from "./budget.ts";
import { beforeToolExecution } from "./dry-run.ts";

export { afterToolExecution, beforeToolEffect, projectSession, reserve } from "./budget.ts";
export { beforeToolExecution } from "./dry-run.ts";
export { bindPluginEnabled, budgetConfig, dryRunOn, turnId } from "./flags.ts";
export { createToolsHttp, TOOLS_ROUTES, type ToolsHttpOptions, type ToolsStore } from "./http.ts";

export const tools: BundledPlugin = {
  manifest,
  plugin: definePlugin({
    name: "tools",
    apply(ctx) {
      ctx.toolEvent("before_tool_execution", beforeToolExecution);
      ctx.toolEvent("before_tool_effect", beforeToolEffect);
      ctx.toolEvent("after_tool_execution", afterToolExecution);
    },
  }),
};
