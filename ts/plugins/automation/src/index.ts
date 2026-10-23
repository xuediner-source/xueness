/**
 * Timezone cron, off-peak queue and local run history (Python
 * `bundled_plugins/automation`).
 *
 * The plugin declares `workflows.store` as a required service and reaches
 * workflow runs only through that bridge, so it never imports the workflows
 * plugin. The scheduler daemon and the `offpeak_create` tool are scoped to the
 * plugin's own activation: the scheduler stops when the plugin unloads, and the
 * tool disappears from the kernel's registry.
 */
import { definePlugin, type BundledPlugin } from "@xueness/kernel";
import manifest from "../manifest.json" with { type: "json" };
import { bindPluginEnabled, type WorkflowBridge } from "./off-peak.ts";
import { Scheduler } from "./scheduler.ts";
import { offPeakCreateTool } from "./tool.ts";

export { cronField, cron, nextRun, validZone } from "./cron.ts";
export { Automations, type WorkflowBridge, type AutomationOptions, type RunOptions } from "./store.ts";
export { OffPeakQueue, type OffPeakOptions } from "./off-peak-queue.ts";
export { Scheduler, type SchedulerOptions } from "./scheduler.ts";
export { createAutomationHttp, AUTOMATION_ROUTES, type AutomationHttpOptions } from "./http.ts";
export { offPeakCreateTool, offPeakTool, type OffPeakToolOptions } from "./tool.ts";
export { bindPluginEnabled } from "./off-peak.ts";

export interface AutomationPluginOptions {
  stateDir: string;
  /** The host's catalog probe: `is_enabled(state, pluginId)`. */
  enabled(id: string): boolean;
  /** Host ceiling: the web real-provider switch. */
  allowRealHost(): boolean;
}

/** The full server wiring: scheduler daemon, HTTP families and the model tool. */
export function createAutomation(options: AutomationPluginOptions): BundledPlugin {
  return {
    manifest,
    plugin: definePlugin({
      name: "automation",
      inject: { required: ["workflows.store"] },
      apply(ctx) {
        bindPluginEnabled((_stateDir, pluginId) => options.enabled(pluginId));
        const bridge = ctx.get<WorkflowBridge>("workflows.store");
        const scheduler = new Scheduler(options.stateDir, { allowReal: options.allowRealHost(), bridge });
        ctx.effect(() => scheduler.close());
        ctx.tool(offPeakCreateTool({ stateDir: options.stateDir }));
      },
    }),
  };
}

/**
 * The agent's view of the plugin: only the `offpeak_create` tool. The server
 * owns the one scheduler per state directory (see `createAutomation`).
 */
export function createAutomationTools(options: { stateDir: string }): BundledPlugin {
  return {
    manifest,
    plugin: definePlugin({
      name: "automation",
      inject: { required: ["workflows.store"] },
      apply(ctx) { ctx.tool(offPeakCreateTool({ stateDir: options.stateDir })); },
    }),
  };
}

/** The bundled entry: the tool over `.`; a scheduler needs the host's state directory. */
export const automation: BundledPlugin = createAutomationTools({ stateDir: "." });
