import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { catalogIssues, validateManifest, type PluginManifest } from "@xueness/contracts";
import { Context, PluginHost } from "@xueness/kernel";
import { BUNDLED_TS_PLUGINS } from "@xueness/server";
import { pythonToolFacts, pythonUnavailableReason } from "../../../test-support/python-oracle.ts";

/** TS tools with no Python namesake (or, for `task`, a core-special one), and the Python tool whose Gate kind and flags they take over. */
const PYTHON_ANALOGUES: Record<string, string> = { exec_output: "background_logs", exec_kill: "background_cancel", skill_read: "read", task: "task_collect" };
/** TypeScript-only tools (Step 3, ZCode ExitPlanMode); the frozen Python registry has no counterpart. */
const TS_ONLY_TOOLS = new Set(["exit_plan_mode", "enter_plan_mode", "apply_patch"]);

/** Python calls MCP tools through Gate kind `mcp`, which `core.Gate.check` counts as mutating (plan mode refuses it). */
const MCP_FAMILY = { gate: "mcp", mutating: true, concurrencySafe: false };

const manifests = (): PluginManifest[] => BUNDLED_TS_PLUGINS.map(({ manifest }) => {
  const result = validateManifest(manifest);
  assert.deepEqual(result.issues, []);
  return result.manifest as PluginManifest;
});

describe("bundled TypeScript plugins", () => {
  it("are every directory under plugins/, with valid manifests forming a clean catalog", () => {
    const dirs = readdirSync(join(import.meta.dirname, "..", "..", "..", "plugins")).sort();
    assert.deepEqual(manifests().map((manifest) => manifest.id).sort(), dirs);
    assert.deepEqual(catalogIssues(manifests()), []);
  });

  it("all load with their declared grants and register exactly their declared tools", async () => {
    const kernel = Context.create();
    // Default-off plugins (browser, off by default as in Python) are switched on to check their grants too.
    const host = new PluginHost(kernel, BUNDLED_TS_PLUGINS, { enabled: Object.fromEntries(manifests().map((manifest) => [manifest.id, true])) });
    for (const status of await host.start()) assert.equal(status.state, "active", `${status.id}: ${status.error ?? status.issues.join("; ")}`);
    // A tool family (`mcp__*`) registers its tools only while a run has servers, so none appear here.
    const declared = manifests().flatMap((manifest) => manifest.tools.filter((tool) => !tool.name.endsWith("*")).map((tool) => [tool.name, manifest.id]));
    assert.deepEqual(kernel.tools.list().map((tool) => [tool.name, kernel.tools.ownerOf(tool.name)]), declared);
    await host.dispose();
    assert.equal(kernel.tools.size, 0);
    await kernel.dispose();
  });

  it("declare the Gate kind and flags the Python registry uses for the same tools", { skip: pythonUnavailableReason() ?? false }, () => {
    const facts = pythonToolFacts();
    for (const manifest of manifests()) {
      for (const tool of manifest.tools) {
        if (TS_ONLY_TOOLS.has(tool.name)) continue;
        if (tool.name === "mcp__*") { assert.deepEqual({ gate: tool.gate, mutating: tool.mutating, concurrencySafe: tool.concurrencySafe }, MCP_FAMILY, "mcp/mcp__*"); continue; }
        const python = facts[PYTHON_ANALOGUES[tool.name] ?? tool.name];
        assert.ok(python, `${manifest.id}/${tool.name} has no Python counterpart`);
        assert.deepEqual({ gate: tool.gate, mutating: tool.mutating, concurrencySafe: tool.concurrencySafe }, python, `${manifest.id}/${tool.name}`);
      }
    }
  });
});
