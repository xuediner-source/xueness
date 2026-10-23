/**
 * Workspace file tools as a plugin: read, list, glob, grep, write, edit.
 *
 * Directory browsing and workspace previews are `createFilesHttp`
 * (`/api/system`, `/api/directory`, `/api/sessions/<id>/files`,
 * `/api/sessions/<id>/file`). Nothing in the Python plugin handles
 * `/api/home`, so this plugin does not own it. The changes view is still
 * a later route; the manifest stays tools-only until the front door
 * takes these families.
 */
import { applyPatchTool, editTool, globTool, grepTool, listTool, readTool, writeTool } from "@xueness/engine-tools";
import { definePlugin, type BundledPlugin } from "@xueness/kernel";
import manifest from "../manifest.json" with { type: "json" };
export * from "./instructions.ts";
export * from "./read-state.ts";
export * from './file-history.ts';
export * from './file-rewind.ts';
export * from './file-rewind-api.ts';
export * from './file-bytes-api.ts';
export * from "./reference-stat.ts";
export * from "./directory-level.ts";
export * from "./directory-http.ts";
export * from "./preview.ts";
export * from "./files-http.ts";

export const FILE_TOOLS = [readTool, listTool, globTool, grepTool, writeTool, editTool, applyPatchTool] as const;

export const filesPlugin = definePlugin({
  name: "files",
  apply(ctx) {
    for (const tool of FILE_TOOLS) ctx.tool(tool);
  },
});

export const files: BundledPlugin = { manifest, plugin: filesPlugin };
