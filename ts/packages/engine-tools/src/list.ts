/**
 * list: entries of one directory, directories first-class with a trailing
 * `/`, sorted by name, capped. Hidden entries are included.
 */
import { readdir } from "node:fs/promises";
import { resolveWorkspacePath } from "./paths.ts";
import { failure, READS_WORKSPACE, statOrNull, type ToolDefinition } from "./tool.ts";

export const LIST_DEFAULT_LIMIT = 500;

export interface ListInput {
  path?: string;
  limit?: number;
}

export interface ListData {
  path: string;
  entries: string[];
  total: number;
  truncated: boolean;
}

export const listTool: ToolDefinition<ListInput, ListData> = {
  name: "list",
  gate: "list",
  mutating: false,
  concurrencySafe: true,
  requires: READS_WORKSPACE,
  description: "List one directory. Directories end with `/`. Use glob to search recursively.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      path: { type: "string", minLength: 1 },
      limit: { type: "integer", minimum: 1, maximum: 5000 },
    },
  },
  async run(input, env) {
    const target = await resolveWorkspacePath(input.path ?? ".", env.cwd, env.roots);
    const info = await statOrNull(target.absolute);
    if (!info) return failure("not_found", `directory not found: ${target.display}`);
    if (!info.isDirectory()) return failure("not_a_directory", `${target.display} is not a directory; use read`);
    const names = (await readdir(target.absolute, { withFileTypes: true }))
      .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const limit = input.limit ?? LIST_DEFAULT_LIMIT;
    const entries = names.slice(0, limit);
    const truncated = names.length > limit;
    let output = entries.length ? entries.join("\n") : "(empty directory)";
    if (truncated) output += `\n\n[showing ${limit} of ${names.length} entries]`;
    return { ok: true, output, data: { path: target.display, entries, total: names.length, truncated } };
  },
};
