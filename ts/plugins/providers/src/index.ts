import { definePlugin, type BundledPlugin, type ToolDescriptor } from "@xueness/kernel";
import manifest from "../manifest.json" with { type: "json" };
import type { ToolSearchCatalogEntry } from "./tool-search.ts";
import { providerResultTools } from "./result-tool.ts";
export * from "./http-api.ts";
export * from "./profile-store.ts";
export * from "./provider-config.ts";
export * from "./execution-selection.ts";
export * from "./execution-ports.ts";
export * from "./diagnostic-wire.ts";
export * from "./verification.ts";
export * from "./default-selection.ts";
export * from "./runtime.ts";
export * from "./semantic.ts";
export * from "./zcode-compact.ts";
export * from "./zcode-compact-extension.ts";
export * from "./zcode-compact-view.ts";
export * from "./activity.ts";
export * from "./model-status.ts";
export * from "./request-shaping.ts";
export * from "./admission-policy.ts";
export * from "./admission-controller.ts";
export * from "./aux-admission.ts";
export * from "./model-execution.ts";
export * from "./model-diagnostics.ts";
export * from "./model-debug.ts";
export * from "./result-budget.ts";
export * from "./result-tool.ts";
export * from "./tool-search.ts";
export * from "./selection-levels.ts";
export * from "./title-model.ts";
export * from "./composer-models.ts";
export * from "./live-tasks.ts";
/**
 * The bundled face: it registers the manifest's three tools with no session
 * and the live registry declarations as the search catalog (plugins see tool
 * declarations, not descriptions), so a PluginHost that starts the whole
 * bundle serves exactly the tools the manifest declares. Hosts with a live
 * session build `createProviderResultTools` instead (F02.02).
 */
export const providersPlugin = definePlugin({ name: "providers", apply(ctx) {
  const catalog = (): ToolSearchCatalogEntry[] => ctx.tools.list<ToolDescriptor & { alwaysLoad?: boolean; shouldDefer?: boolean }>()
    .map(({ name, alwaysLoad, shouldDefer }) => ({ name, description: "", alwaysLoad, shouldDefer }));
  for (const tool of providerResultTools(() => null, { catalog })) ctx.tool(tool);
} });
export const providers: BundledPlugin = { manifest, plugin: providersPlugin };
