/** F07.01 — override matrix (source display), workspace switching that re-applies only the workspace layer, and legacy workspace documents. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import {
  decideWorkspaceConfigTrust, LayeredRuntimeConfig, LAYER_ORDER, LAYER_SCOPES, loadRuntimeConfig,
  migrateLegacyWorkspaceDocument, runtimeConfigOverrideMatrix, type RuntimeConfigLoadResult, type RuntimeConfigPatch,
} from "../src/index.ts";

function fixture(roots: readonly string[] = []): { base: string; state: string; roots: string[]; close: () => void } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "xueness-layers-")));
  const state = join(base, "state");
  mkdirSync(state);
  const resolved = roots.map((name) => {
    const root = join(base, name);
    mkdirSync(join(root, ".xueness"), { recursive: true });
    return realpathSync(root);
  });
  return { base, state, roots: resolved, close: () => rmSync(base, { recursive: true, force: true }) };
}

it("builds the override matrix: every effective value traceable, MCP servers carry their layer chain", () => {
  const f = fixture();
  try {
    const result = loadRuntimeConfig({
      stateDir: f.state,
      defaults: { plugins: { alpha: { a: 1 } }, mcp: { servers: { sys: { command: "sys" }, shared: { command: "defaults" } } } },
      userDefaults: { mcp: { servers: { shared: { command: "user" } } } },
      env: { XUENESS_RUNTIME_CONFIG: JSON.stringify({ mcp: { servers: { shared: { command: "env" } } } }) },
      overrides: { plugins: { alpha: { a: 9 } } },
    });
    const matrix = runtimeConfigOverrideMatrix(result);
    assert.deepEqual(matrix.layers.map((layer) => [layer.source, layer.scope, layer.present]), LAYER_ORDER.map((source) =>
      [source, LAYER_SCOPES[source], source === "defaults" || source === "userDefaults" || source === "environment" || source === "overrides"]));
    const row = (pointer: string) => matrix.values.find((value) => value.pointer === pointer);
    assert.deepEqual(row("/plugins/alpha/a"), { pointer: "/plugins/alpha/a", source: "overrides", scope: "cli" });
    assert.deepEqual(row("/mcp/servers/shared/command"), { pointer: "/mcp/servers/shared/command", source: "environment", scope: "env" });
    // Every effective leaf the provenance knows appears exactly once in the matrix.
    assert.equal(matrix.values.length, Object.keys(result.provenance).length);
    assert.deepEqual(matrix.mcpServers.find((server) => server.name === "sys"), { name: "sys", source: "defaults", scope: "system", overrides: [] });
    assert.deepEqual(matrix.mcpServers.find((server) => server.name === "shared"), { name: "shared", source: "environment", scope: "env", overrides: ["defaults", "userDefaults"] });
  } finally { f.close(); }
});

it("switching roots re-applies only the workspace layer and matches a fresh full load", () => {
  const f = fixture(["rootA", "rootB"]);
  try {
    writeFileSync(join(f.state, "runtime-config.json"), JSON.stringify({ plugins: { shared: { state: "cached" } } }));
    writeFileSync(join(f.roots[0]!, ".xueness", "config.json"), JSON.stringify({ plugins: { shared: { fromA: true } } }));
    writeFileSync(join(f.roots[1]!, ".xueness", "config.json"), JSON.stringify({ plugins: { shared: { fromB: true } } }));
    for (const root of f.roots) {
      const pending = loadRuntimeConfig({ stateDir: f.state, root });
      decideWorkspaceConfigTrust(f.state, root, pending.workspace.digest!, "allow");
    }
    const options: { stateDir: string; defaults: RuntimeConfigPatch } = { stateDir: f.state, defaults: { plugins: { shared: { base: 0 } } } };
    const layered = new LayeredRuntimeConfig(options, f.roots[0]);
    const fresh = loadRuntimeConfig({ ...options, root: f.roots[0] });
    const first = layered.snapshot();
    assert.deepEqual(first, { ...fresh, matrix: runtimeConfigOverrideMatrix(fresh) });

    // Re-apply only the workspace layer: the state file changed after the base was cached.
    writeFileSync(join(f.state, "runtime-config.json"), JSON.stringify({ plugins: { shared: { state: "rewritten" } } }));
    const switched = layered.switchRoot(f.roots[1]!);
    assert.equal(switched.config.plugins?.shared?.state, "cached", "the cached user layer is reused, not re-read");
    assert.equal(switched.config.plugins?.shared?.fromB, true, "the new root's workspace layer is applied");
    assert.equal(switched.config.plugins?.shared?.fromA, undefined, "the previous root's workspace layer is gone");
    assert.equal(switched.workspace.status, "trusted");
    assert.equal(switched.provenance["/plugins/shared/fromB"], "workspace");
    assert.equal(switched.provenance["/plugins/shared/state"], "state");
    // A fresh full load would see the rewritten file — the difference is exactly the caching.
    assert.equal(loadRuntimeConfig({ ...options, root: f.roots[1] }).config.plugins?.shared?.state, "rewritten");
    assert.equal(layered.root, f.roots[1]);
    // Switching back re-applies root A's workspace layer over the same cached base.
    assert.equal(layered.switchRoot(f.roots[0]!).config.plugins?.shared?.fromA, true);
  } finally { f.close(); }
});

it("migrates legacy workspace documents in memory without rewriting the file", () => {
  const f = fixture(["legacy"]);
  try {
    const document = {
      mcpServers: { legacyServer: { command: "legacy-server" } },
      enabledPlugins: { old: true, broken: "not-a-boolean" },
      pluginOptions: { old: { theme: "dark" } },
      hooks: { beforeTool: "separate-trust" },
    };
    const path = join(f.roots[0]!, ".xueness", "config.json");
    const raw = JSON.stringify(document);
    writeFileSync(path, raw);
    assert.equal(migrateLegacyWorkspaceDocument({ plugins: {} }).patch, null, "a modern document is not migrated");
    assert.deepEqual(migrateLegacyWorkspaceDocument(document).keys, ["mcpServers", "pluginOptions", "enabledPlugins"]);

    const pending = loadRuntimeConfig({ stateDir: f.state, root: f.roots[0] });
    assert.equal(pending.workspace.status, "pending");
    assert.ok(pending.diagnostics.some((item) => item.source === "workspace" && item.code === "workspace_legacy_migrated"));
    decideWorkspaceConfigTrust(f.state, f.roots[0]!, pending.workspace.digest!, "allow");
    const trusted: RuntimeConfigLoadResult = loadRuntimeConfig({ stateDir: f.state, root: f.roots[0] });
    assert.equal(trusted.workspace.status, "trusted");
    assert.equal(trusted.config.mcp?.servers?.legacyServer?.command, "legacy-server");
    assert.deepEqual(trusted.config.plugins?.old, { theme: "dark", enabled: true });
    assert.equal(trusted.config.plugins?.broken, undefined, "a non-boolean enabledPlugins entry is skipped");
    assert.equal(trusted.layerPatches.workspace?.mcp?.servers?.legacyServer?.command, "legacy-server");
    assert.equal(readFileSync(path, "utf8"), raw, "the legacy file is never rewritten");
  } finally { f.close(); }
});
