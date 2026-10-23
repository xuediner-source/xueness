/** Temporary workspaces for engine-tool tests. */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createToolEnv, runTool, type ToolDefinition, type ToolEnv, type ToolResult } from "../src/index.ts";

export interface Workspace {
  base: string;
  root: string;
  artifacts: string;
  env: ToolEnv;
  path(rel: string): string;
  put(rel: string, content: string | Uint8Array): Promise<string>;
  bytes(rel: string): Promise<Buffer>;
  text(rel: string): Promise<string>;
  run<D>(tool: ToolDefinition<never, D>, input: unknown): Promise<ToolResult<D>>;
  dispose(): void;
}

export function workspace(options: { signal?: AbortSignal } = {}): Workspace {
  const base = mkdtempSync(join(tmpdir(), "xueness-tools-"));
  const root = join(base, "ws");
  const artifacts = join(base, "artifacts");
  mkdirSync(root, { recursive: true });
  let env: ToolEnv | null = null;
  const ws: Workspace = {
    base,
    root,
    artifacts,
    get env() {
      env ??= createToolEnv({ cwd: root, artifactsDir: artifacts, ...(options.signal ? { signal: options.signal } : {}) });
      return env;
    },
    path: (rel) => join(root, rel),
    async put(rel, content) {
      const target = join(root, rel);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
      return target;
    },
    bytes: (rel) => readFile(join(root, rel)),
    text: (rel) => readFile(join(root, rel), "utf8"),
    async run(tool, input) {
      return runTool(tool, input, ws.env);
    },
    dispose: () => rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
  };
  return ws;
}
