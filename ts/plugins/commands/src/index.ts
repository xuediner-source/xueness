import { definePlugin, type BundledPlugin } from "@xueness/kernel";
import manifest from "../manifest.json" with { type: "json" };
export * from "./builtin-prompts.ts";
export * from "./commands.ts";
export * from "./file-commands.ts";
export * from "./frontmatter.ts";
export * from "./http-api.ts";
export * from "./inspect.ts";
export const commands: BundledPlugin = { manifest, plugin: definePlugin({ name: "commands", apply() {} }) };
