import { definePlugin, type BundledPlugin } from "@xueness/kernel";
import type { AgentContext, AgentExtension, ModelRequest } from "@xueness/agent";
import manifest from "../manifest.json" with { type: "json" };
import { createNativeOpsBinding } from "./binding.ts";
import { nativeOpsTools } from "./tools.ts";
import type { NativeOpsBinding } from "./types.ts";

export * from "./types.ts";
export { createNativeOpsBinding } from "./binding.ts";
export { nativeOpsSchema } from "./tools.ts";

function modelToolName(tool: unknown): string | null {
  if (tool === null || typeof tool !== "object") return null;
  const fn = (tool as { function?: unknown }).function;
  return fn !== null && typeof fn === "object" && typeof (fn as { name?: unknown }).name === "string"
    ? (fn as { name: string }).name : null;
}

export function createNativeOps(binding: NativeOpsBinding): BundledPlugin {
  return {
    manifest,
    plugin: definePlugin({
      name: "native_ops",
      apply(ctx) {
        for (const tool of nativeOpsTools(ctx, binding)) ctx.tool(tool);
      },
    }),
  };
}

export function nativeOpsExtension(binding: NativeOpsBinding): AgentExtension {
  return {
    id: "native_ops",
    capabilities: ["native_ops.files", "native_ops.discovery", "native_ops.documents"],
    prepareRequest(context: AgentContext, request: ModelRequest): ModelRequest {
      const sessionId = typeof context.session.id === "string" ? context.session.id : undefined;
      const selected = binding.selectedFor(sessionId);
      if (!request.tools.some((tool) => modelToolName(tool)?.startsWith("xops_"))) return request;
      return {
        ...request,
        tools: request.tools.filter((tool) => {
          const name = modelToolName(tool);
          return !name?.startsWith("xops_") || selected.has(name);
        }),
      };
    },
  };
}

const defaultBinding = createNativeOpsBinding();
export const nativeOps = createNativeOps(defaultBinding);
