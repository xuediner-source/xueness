/**
 * glob: files matching a pattern, newest first.
 * Honours .gitignore/.ignore and skips VCS and dependency directories unless
 * `include_ignored` is set. Paths are shown relative to the workspace root.
 */
import { stat } from "node:fs/promises";
import { assertRelativeGlob, compileGlob } from "./glob-pattern.ts";
import { resolveWorkspacePath } from "./paths.ts";
import { failure, READS_WORKSPACE, statOrNull, type ToolDefinition } from "./tool.ts";
import { walkFiles } from "./walk.ts";

export const GLOB_DEFAULT_LIMIT = 500;
export const GLOB_MAX_LIMIT = 5000;
const STAT_CONCURRENCY = 32;

export interface GlobInput {
  pattern: string;
  path?: string;
  limit?: number;
  include_ignored?: boolean;
}

export interface GlobData {
  pattern: string;
  base: string;
  count: number;
  truncated: boolean;
  walkTruncated: boolean;
  files: string[];
}

export function joinDisplay(base: string, path: string): string {
  return base === "." ? path : `${base}/${path}`;
}

/** Map with bounded concurrency, preserving order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index] as T);
    }
  });
  await Promise.all(workers);
  return results;
}

export const globTool: ToolDefinition<GlobInput, GlobData> = {
  name: "glob",
  gate: "glob",
  mutating: false,
  concurrencySafe: true,
  requires: READS_WORKSPACE,
  description: [
    "Find files by name pattern, newest first. `*` and `?` match within a name, `**` spans directories, `{a,b}` lists alternatives.",
    "A pattern without `/` (like `*.ts`) matches at any depth; `src/**/*.test.ts` matches from the search path.",
    "Respects .gitignore and skips .git and node_modules unless include_ignored is true.",
  ].join(" "),
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["pattern"],
    properties: {
      pattern: { type: "string", minLength: 1, maxLength: 1024 },
      path: { type: "string", minLength: 1, description: "Directory to search, relative to the working directory. Default: working directory." },
      limit: { type: "integer", minimum: 1, maximum: GLOB_MAX_LIMIT },
      include_ignored: { type: "boolean", description: "Also search ignored files and dependency directories." },
    },
  },
  async run(input, env) {
    assertRelativeGlob(input.pattern);
    const matcher = compileGlob(input.pattern);
    const base = await resolveWorkspacePath(input.path ?? ".", env.cwd, env.roots);
    const info = await statOrNull(base.absolute);
    if (!info) return failure("not_found", `directory not found: ${base.display}`);
    if (!info.isDirectory()) return failure("not_a_directory", `${base.display} is not a directory`);
    const ignoring = !input.include_ignored;
    const walk = await walkFiles(base.absolute, { respectIgnore: ignoring, skipDefaultExcludes: ignoring, ...(env.signal ? { signal: env.signal } : {}) });
    const matched = walk.files.filter((file) => matcher.test(file.path));
    const stamped = await mapLimit(matched, STAT_CONCURRENCY, async (file) => ({
      path: joinDisplay(base.display, file.path),
      mtime: (await stat(file.absolute).catch(() => null))?.mtimeMs ?? 0,
    }));
    stamped.sort((a, b) => b.mtime - a.mtime || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const limit = input.limit ?? GLOB_DEFAULT_LIMIT;
    const files = stamped.slice(0, limit).map((entry) => entry.path);
    const truncated = stamped.length > limit;
    const notes: string[] = [];
    if (truncated) notes.push(`[showing ${limit} of ${stamped.length} matches, newest first; narrow the pattern or path]`);
    if (walk.truncated) notes.push(`[search stopped after ${walk.visitedEntries} entries; narrow the path]`);
    let output = files.join("\n");
    if (!files.length) {
      output = `No files match ${JSON.stringify(input.pattern)} in ${base.display}.`;
      if (ignoring) output += " Ignored files and dependency directories were skipped (include_ignored: true searches them).";
    }
    if (notes.length) output += `\n\n${notes.join("\n")}`;
    return {
      ok: true,
      output,
      data: { pattern: input.pattern, base: base.display, count: stamped.length, truncated, walkTruncated: walk.truncated, files },
    };
  },
};
