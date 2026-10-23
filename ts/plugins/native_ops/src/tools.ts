import type { Context } from "@xueness/kernel";
import { READS_WORKSPACE, WRITES_WORKSPACE, type ToolDefinition, type ToolEnv, type ToolResult } from "@xueness/engine-tools";
import schemasJson from "../assets/schemas.json" with { type: "json" };
import { invokeNativeFileTool } from "./worker.ts";
import {
  NATIVE_OPS_DISCOVERY_NAME, NATIVE_OPS_NAMES, NATIVE_OPS_TOOL_NAMES,
  type NativeOpsBinding, type NativeOpsRawName, type NativeOpsSchemas,
} from "./types.ts";

const schemaData = schemasJson as unknown as NativeOpsSchemas;
const rawInput = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const nameForOwner = (env: ToolEnv): string | undefined => {
  if (typeof env.owner === "string" && env.owner) return env.owner;
  const session = env.currentSession?.();
  return session && typeof session.id === "string" ? session.id : undefined;
};

function pathSubjects(input: Record<string, unknown>): string[] {
  const paths: string[] = [];
  if (typeof input.path === "string" && input.path) paths.push(input.path);
  if (Array.isArray(input.files)) {
    for (const file of input.files) if (rawInput(file) && typeof file.path === "string" && file.path) paths.push(file.path);
  }
  if (typeof input.to === "string" && input.to) paths.push(input.to);
  return paths.length ? [...new Set(paths)] : ["."];
}

function adaptedDescription(rawName: NativeOpsRawName): string {
  return schemaData.tools[rawName].description
    .replaceAll("ops_", "xops_")
    .replaceAll("DSH session cwd", "Xueness session workspace root");
}

function fileTool(ctx: Context, rawName: NativeOpsRawName): ToolDefinition<Record<string, unknown>> {
  const name = `xops_${rawName}`;
  const mutating = ["replace", "write_file", "edit_file", "copy", "move", "remove"].includes(rawName);
  const gate = rawName === "replace" || rawName === "edit_file" ? "edit" : mutating ? "write" : "read";
  return {
    name,
    description: adaptedDescription(rawName),
    inputSchema: schemaData.tools[rawName].inputSchema as ToolDefinition["inputSchema"],
    gate,
    mutating,
    concurrencySafe: !mutating,
    requires: mutating ? WRITES_WORKSPACE : READS_WORKSPACE,
    subjectKind: "path",
    subjectPaths: pathSubjects,
    run: (input, env) => invokeNativeFileTool(ctx, rawName, input, env),
  };
}

const discoverySchema: ToolDefinition["inputSchema"] = {
  type: "object",
  properties: { names: { type: "array", minItems: 1, items: { type: "string", enum: NATIVE_OPS_TOOL_NAMES } } },
  additionalProperties: false,
};

function discoveryTool(binding: NativeOpsBinding): ToolDefinition<Record<string, unknown>> {
  return {
    name: NATIVE_OPS_DISCOVERY_NAME,
    description: "List the fixed xops_* file and document tools, or select named tools for this session's next model step. Selection runs no worker and changes no files.",
    inputSchema: discoverySchema,
    gate: "read",
    mutating: false,
    concurrencySafe: false,
    requires: {},
    subjectKind: "text",
    subject: () => "",
    async run(input, env): Promise<ToolResult> {
      const supplied = input.names;
      if (supplied === undefined) {
        const tools = NATIVE_OPS_NAMES.map((rawName) => ({
          name: `xops_${rawName}`,
          description: adaptedDescription(rawName),
        }));
        const data = { tools, selected: [...binding.selectedFor(nameForOwner(env))] };
        return { ok: true, output: JSON.stringify(data), data };
      }
      if (!Array.isArray(supplied) || !supplied.length || supplied.some((name) => typeof name !== "string" || !NATIVE_OPS_TOOL_NAMES.includes(name))) {
        return { ok: false, output: "names must contain one or more fixed xops_* file or document tool names.", error: { code: "invalid_argument", message: "names must contain one or more fixed xops_* file or document tool names." } };
      }
      const selected = binding.select(nameForOwner(env), supplied as string[]);
      const tools = [...new Set(supplied as string[])].map((name) => {
        const rawName = name.slice("xops_".length) as NativeOpsRawName;
        return { name, description: adaptedDescription(rawName), inputSchema: schemaData.tools[rawName].inputSchema };
      });
      const data = { selected, tools };
      return { ok: true, output: JSON.stringify(data), data };
    },
  };
}

export function nativeOpsTools(ctx: Context, binding: NativeOpsBinding): ToolDefinition<Record<string, unknown>>[] {
  return [...NATIVE_OPS_NAMES.map((name) => fileTool(ctx, name)), discoveryTool(binding)];
}

export function selectedNativeOps(binding: NativeOpsBinding, owner?: string): Set<string> {
  return binding.selectedFor(owner);
}

export function nativeOpsSchema(rawName: NativeOpsRawName): NativeOpsSchemas["tools"][NativeOpsRawName] {
  return schemaData.tools[rawName];
}
