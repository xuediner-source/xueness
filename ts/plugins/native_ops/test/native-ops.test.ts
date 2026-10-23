import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { after, describe, it } from "node:test";
import type { AgentContext, ModelRequest } from "@xueness/agent";
import { createToolEnv, type ToolDefinition, type ToolResult } from "@xueness/engine-tools";
import { Context, PluginHost } from "@xueness/kernel";
import { PermissionSession, type PermissionMode } from "@xueness/permissions";
import { ToolBridge } from "@xueness/tool-bridge";
import { files } from "@xueness/plugin-files";

const roots: string[] = [];
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

// Exercise the shipped, relocatable plugin outside the checkout's inherited ACLs.
const relocated = realpathSync(mkdtempSync(join(tmpdir(), "xueness-native-ops-plugin-")));
roots.push(relocated);
const original = resolve(import.meta.dirname, "..");
const plugin = join(relocated, "plugin");
cpSync(original, plugin, { recursive: true, filter: (path) => !["test", "node_modules"].includes(relative(original, path).split(/[\\/]/)[0] ?? "") });
symlinkSync(resolve(original, "../../node_modules"), join(plugin, "node_modules"), process.platform === "win32" ? "junction" : "dir");
const { createNativeOps, createNativeOpsBinding, nativeOpsExtension } = await import(pathToFileURL(join(plugin, "src/index.ts")).href) as typeof import("../src/index.ts");
const { activeNativeWorkerCount } = await import(pathToFileURL(join(plugin, "src/worker.ts")).href) as typeof import("../src/worker.ts");

async function fixture(mode: PermissionMode = "edit", owner = "native-ops-test-session") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "xueness-native-ops-")));
  roots.push(root);
  const workspace = join(root, "workspace");
  const artifacts = join(root, "artifacts");
  mkdirSync(workspace);
  mkdirSync(artifacts);
  const kernel = Context.create();
  const binding = createNativeOpsBinding();
  const host = new PluginHost(kernel, [files, createNativeOps(binding)]);
  const status = await host.start();
  assert.ok(status.every((item) => item.state === "active"), JSON.stringify(status));
  const permissions = new PermissionSession({ mode });
  const env = createToolEnv({ cwd: workspace, roots: [workspace], artifactsDir: artifacts, owner });
  const bridge = new ToolBridge({ kernel, permissions, env });
  return {
    root, workspace, kernel, host, binding, env, bridge,
    call(name: string, input: unknown = {}, id = `${name}-${Math.random()}`): Promise<ToolResult> {
      return bridge.call({ id, name, input });
    },
    async close(): Promise<void> { await host.dispose(); await kernel.dispose(); },
  };
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

describe("native_ops fixed worker", () => {
  it("reads multiple files, records complete read proofs, and applies only the observed revision", async () => {
    const f = await fixture();
    try {
      writeFileSync(join(f.workspace, "a.txt"), "alpha\n");
      writeFileSync(join(f.workspace, "b.txt"), "bravo\n");
      const read = await f.call("xops_read_files", { files: [{ path: "a.txt" }, { path: "b.txt" }] });
      assert.equal(read.ok, true, read.output);
      const items = record(read.data).items as Record<string, unknown>[];
      assert.equal(items.length, 2);
      assert.equal(items.every((item) => item.complete === true && item.status === "completed"), true);
      assert.equal(f.env.tracker.get(join(f.workspace, "a.txt"))?.partial, false);
      const stat = await f.call("xops_stat", { path: "a.txt" });
      assert.equal(stat.ok, true, stat.output);
      const revision = record(stat.data).revision;
      assert.equal(typeof revision, "string");

      const stale = await f.call("xops_edit_file", {
        path: "a.txt", expectedRevision: "0".repeat(64), edits: [{ oldText: "alpha", newText: "wrong" }],
      });
      assert.equal(stale.ok, false);
      assert.equal(readFileSync(join(f.workspace, "a.txt"), "utf8"), "alpha\n");

      const invalid = await f.call("xops_edit_file", { path: "a.txt", edits: [{ oldText: "alpha", newText: "wrong" }] });
      assert.equal(invalid.error?.code, "invalid_argument");
      assert.equal(readFileSync(join(f.workspace, "a.txt"), "utf8"), "alpha\n");

      const edit = await f.call("xops_edit_file", {
        path: "a.txt", expectedRevision: revision, edits: [{ oldText: "alpha", newText: "ALPHA" }],
      });
      assert.equal(edit.ok, true, edit.output);
      assert.equal(readFileSync(join(f.workspace, "a.txt"), "utf8"), "ALPHA\n");
    } finally { await f.close(); }
  });

  it("starts with bounded tools per session and adds only explicitly discovered tools", async () => {
    const f = await fixture("edit", "session-a");
    try {
      assert.deepEqual([...f.binding.selectedFor("session-a")].sort(), ["xops_discover_tools", "xops_read_files"]);
      const discovered = await f.call("xops_discover_tools", { names: ["xops_stat", "xops_read_pdf"] });
      assert.equal(discovered.ok, true, discovered.output);
      assert.deepEqual([...f.binding.selectedFor("session-a")].sort(), ["xops_discover_tools", "xops_read_files", "xops_read_pdf", "xops_stat"]);
      assert.deepEqual([...f.binding.selectedFor("session-b")].sort(), ["xops_discover_tools", "xops_read_files"]);

      const extension = nativeOpsExtension(f.binding);
      const request = { tools: ["xops_read_files", "xops_stat", "xops_read_pdf", "ordinary_tool"].map((name) => ({ function: { name } })) } as unknown as ModelRequest;
      const selected = await extension.prepareRequest!({ session: { id: "session-a" } } as unknown as AgentContext, request);
      const other = await extension.prepareRequest!({ session: { id: "session-b" } } as unknown as AgentContext, request);
      const names = (value: ModelRequest): string[] => value.tools.map((tool) => (tool as { function?: { name?: string } }).function?.name ?? "");
      assert.deepEqual(names(selected), ["xops_read_files", "xops_stat", "xops_read_pdf", "ordinary_tool"]);
      assert.deepEqual(names(other), ["xops_read_files", "ordinary_tool"]);
    } finally { await f.close(); }
  });

  it("refuses writes in plan mode and rejects paths outside the workspace before starting a worker", async () => {
    const f = await fixture("plan");
    try {
      const outside = join(f.root, "outside.txt");
      writeFileSync(outside, "keep\n");
      const before = activeNativeWorkerCount();
      const write = await f.call("xops_write_file", { path: "new.txt", content: "no", expectedRevision: "absent" });
      assert.equal(write.error?.code, "plan_mode_denied");
      assert.equal(existsSync(join(f.workspace, "new.txt")), false);
      const escaped = await f.call("xops_stat", { path: outside });
      assert.equal(escaped.error?.code, "path_outside_workspace");
      assert.equal(activeNativeWorkerCount(), before);
    } finally { await f.close(); }
  });

  it("removes tools on disable and drains an in-flight worker", async () => {
    const f = await fixture("edit", "session-abort");
    try {
      writeFileSync(join(f.workspace, "large-scan.txt"), Buffer.alloc(32 * 1024 * 1024, 120));
      const pending = f.call("xops_grep", { pattern: "a-token-that-is-absent", outputMode: "files_with_matches", limit: 1 }, "abort-scan");
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      assert.ok(activeNativeWorkerCount() > 0, "the fixed worker did not remain active long enough to abort");
      await f.host.disable("native_ops");
      const result = await pending;
      assert.equal(result.error?.code, "cancelled");
      assert.equal(activeNativeWorkerCount(), 0);
      assert.equal(f.kernel.tools.get<ToolDefinition>("xops_grep"), undefined);
    } finally { await f.close(); }
  });
});
