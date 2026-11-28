/** Tool execution policy. Both switches default off. No model-facing tool. */
import { definePlugin, type BundledPlugin } from "@xueness/kernel";
import manifest from "../manifest.json" with { type: "json" };
import { budgetDenial, budgetRewrite } from "./budget.ts";
import { dryRunDenial } from "./dry-run.ts";

export { budgetDenial, budgetRewrite, projectSession, reserve } from "./budget.ts";
export { dryRunDenial } from "./dry-run.ts";
export { bindPluginEnabled, budgetConfig, dryRunOn, turnId } from "./flags.ts";
export { createToolsHttp, TOOLS_ROUTES, type ToolsHttpOptions, type ToolsStore } from "./http.ts";

export interface ToolsOptions {
  /** The state directory holding settings.json and the budget sidecars. */
  stateDir: string | null;
  /** The session the environment is running. */
  session: () => unknown;
}

/**
 * Both policies act after the permission check, before any effect: a dry run
 * stops the call first, so a previewed call never spends budget.
 */
export function createTools(options: ToolsOptions): BundledPlugin {
  return {
    manifest,
    plugin: definePlugin({
      name: "tools",
      apply(ctx) {
        ctx.toolEvent("before_tool_effect", (payload) => {
          const denial = dryRunDenial(payload, options.stateDir) ?? budgetDenial(payload, options.stateDir, options.session());
          return denial ? { decision: "deny", result: denial } : null;
        });
        ctx.toolEvent("after_tool_execution", (payload) => budgetRewrite(payload, options.stateDir, options.session()));
      },
    }),
  };
}

export const tools: BundledPlugin = createTools({ stateDir: null, session: () => null });
