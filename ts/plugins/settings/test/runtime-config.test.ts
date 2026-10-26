import { mkdtempSync } from "../../../test-support/canonical-temp.ts";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { createRuntimeConfigApi, decideWorkspaceConfigTrust, loadRuntimeConfig, type RuntimeConfigPatch } from "../src/index.ts";

function fixture(): { base: string; state: string; root: string; close: () => void } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "xueness-runtime-config-")));
  const state = join(base, "state"), root = join(base, "project");
  mkdirSync(state); mkdirSync(root);
  return { base, state, root, close: () => rmSync(base, { recursive: true, force: true }) };
}

it("merges trusted layers by priority and tracks the winning source for leaves", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.state, "runtime-config.json"), '{"plugins":{"alpha":{"nested":{"state":2},"list":[2],"flag":false,"__proto__":{"polluted":true},"constructor":{"bad":true},"prototype":{"bad":true}}}}');
    mkdirSync(join(f.root, ".xueness"));
    writeFileSync(join(f.root, ".xueness", "config.json"), JSON.stringify({ plugins: { alpha: { nested: { project: 3 }, list: [3], flag: true } }, hooks: { beforeTool: "ignored" } }));
    const defaults: RuntimeConfigPatch = { plugins: { alpha: { nested: { base: 0, user: 0, state: 0, project: 0, env: 0, host: 0 }, list: [0, 1], flag: true } } };
    const first = loadRuntimeConfig({ stateDir: f.state, root: f.root, defaults, userDefaults: { plugins: { alpha: { nested: { user: 1 } } } }, env: { XUENESS_RUNTIME_CONFIG: JSON.stringify({ plugins: { alpha: { nested: { env: 4 }, list: [4, 5], flag: false } } }) }, overrides: { plugins: { alpha: { nested: { host: 5 } } } } });
    assert.equal(first.workspace.status, "pending");
    assert.deepEqual(first.config.plugins?.alpha, { nested: { base: 0, user: 1, state: 2, project: 0, env: 4, host: 5 }, list: [4, 5], flag: false });
    assert.equal(first.provenance["/plugins/alpha/nested/env"], "environment");
    assert.equal(first.provenance["/plugins/alpha/nested/host"], "overrides");
    assert.ok(first.diagnostics.some((item) => item.code === "workspace_hooks_separate_trust"));
  } finally { f.close(); }
});

it("ignores invalid JSON without changing the source file or lower-priority config", () => {
  const f = fixture();
  try {
    const source = "{invalid";
    writeFileSync(join(f.state, "runtime-config.json"), source);
    const result = loadRuntimeConfig({ stateDir: f.state, defaults: { plugins: { alpha: { enabled: true } } } });
    assert.deepEqual(result.config, { plugins: { alpha: { enabled: true } } });
    assert.ok(result.diagnostics.some((item) => item.source === "state" && item.code === "invalid_file"));
    assert.equal(readFileSync(join(f.state, "runtime-config.json"), "utf8"), source);
  } finally { f.close(); }
});

it("requires an exact current root and digest allow record, and invalidates changed or revoked files", () => {
  const f = fixture();
  try {
    const path = join(f.root, ".xueness", "config.json");
    mkdirSync(join(f.root, ".xueness"));
    writeFileSync(path, JSON.stringify({ plugins: { project: { enabled: true } } }));
    const pending = loadRuntimeConfig({ stateDir: f.state, root: f.root });
    assert.equal(pending.workspace.status, "pending");
    assert.equal(pending.config.plugins, undefined);
    decideWorkspaceConfigTrust(f.state, realpathSync(f.root), pending.workspace.digest!, "allow");
    assert.equal(loadRuntimeConfig({ stateDir: f.state, root: f.root }).workspace.status, "trusted");
    assert.equal(loadRuntimeConfig({ stateDir: f.state, root: f.root }).config.plugins?.project?.enabled, true);

    writeFileSync(path, JSON.stringify({ plugins: { project: { enabled: false } } }));
    const changed = loadRuntimeConfig({ stateDir: f.state, root: f.root });
    assert.equal(changed.workspace.status, "pending");
    assert.equal(changed.config.plugins, undefined);
    decideWorkspaceConfigTrust(f.state, realpathSync(f.root), changed.workspace.digest!, "allow");
    decideWorkspaceConfigTrust(f.state, realpathSync(f.root), changed.workspace.digest!, "revoke");
    const revoked = loadRuntimeConfig({ stateDir: f.state, root: f.root });
    assert.equal(revoked.workspace.status, "pending");
    assert.equal(revoked.config.plugins, undefined);
    if (process.platform !== "win32") assert.equal(statSync(join(f.state, "runtime-config-trust.json")).mode & 0o777, 0o600);
  } finally { f.close(); }
});

it("gates HTTP by settings and authorized root, redacts secret and MCP env values, and persists partial user updates", async () => {
  const f = fixture();
  try {
    const projectConfig = join(f.root, ".xueness", "config.json");
    mkdirSync(join(f.root, ".xueness"));
    const projectSource = JSON.stringify({
      plugins: { candidate: { apiKey: "project-api-key", authorization: "project-authorization" } },
      mcp: { servers: { projectServer: { env: { PROJECT_TOKEN: "project-env-secret", ordinary: "project-env-value" } } } },
      hooks: { beforeTool: "kept-on-disk-only" },
    });
    writeFileSync(projectConfig, projectSource);
    writeFileSync(join(f.state, "runtime-config.json"), JSON.stringify({
      plugins: { alpha: { nested: { first: true }, apiKey: "hidden-api-key", password: "hidden-password" } },
      mcp: { servers: { server: { env: { PRIVATE_TOKEN: "hidden-env", visibleName: "hidden-env-too" }, token: "hidden-token" } } },
    }));
    let isEnabled = false;
    const api = createRuntimeConfigApi({ stateDir: f.state, enabled: () => isEnabled, resolveRoot: (root) => root === realpathSync(f.root) ? realpathSync(f.root) : null });
    assert.equal((await api.dispatch("GET", ["api", "runtime-config"], { root: f.root }, {}))?.[0], 403);
    isEnabled = true;
    assert.equal((await api.dispatch("GET", ["api", "runtime-config"], { root: join(f.base, "outside") }, {}))?.[0], 403);
    const reply = await api.dispatch("GET", ["api", "runtime-config"], { root: f.root }, {});
    assert.equal(reply?.[0], 200);
    const view = reply?.[1] as {
      config: { plugins: Record<string, Record<string, unknown>>; mcp: { servers: Record<string, Record<string, unknown>> } };
      workspaceCandidate?: { plugins: Record<string, Record<string, unknown>>; mcp: { servers: Record<string, Record<string, unknown>> } };
      workspace: { status: string };
    };
    assert.equal(view.workspace.status, "pending");
    const plugin = view.config.plugins.alpha!;
    assert.equal(plugin.apiKey, "[redacted]");
    assert.equal(plugin.password, "[redacted]");
    assert.deepEqual((view.config.mcp.servers.server!.env), { PRIVATE_TOKEN: "[redacted]", visibleName: "[redacted]" });
    assert.equal(view.config.mcp.servers.server!.token, "[redacted]");
    const candidate = view.workspaceCandidate!;
    assert.equal(candidate.plugins.candidate!.apiKey, "[redacted]");
    assert.equal(candidate.plugins.candidate!.authorization, "[redacted]");
    assert.deepEqual(candidate.mcp.servers.projectServer!.env, { PROJECT_TOKEN: "[redacted]", ordinary: "[redacted]" });
    assert.equal(Object.hasOwn(candidate, "hooks"), false);
    assert.equal(readFileSync(projectConfig, "utf8"), projectSource);

    assert.equal((await api.dispatch("POST", ["api", "runtime-config"], {}, { config: { plugins: { alpha: { nested: { second: false } } } } }))?.[0], 200);
    const saved = JSON.parse(readFileSync(join(f.state, "runtime-config.json"), "utf8"));
    assert.deepEqual(saved.plugins.alpha.nested, { first: true, second: false });
    assert.equal(saved.plugins.alpha.apiKey, "hidden-api-key");
    assert.equal(readFileSync(projectConfig, "utf8"), projectSource);
    if (process.platform !== "win32") assert.equal(statSync(join(f.state, "runtime-config.json")).mode & 0o777, 0o600);

    const trust = await api.dispatch("POST", ["api", "runtime-config", "trust"], {}, { root: f.root, digest: (loadRuntimeConfig({ stateDir: f.state, root: f.root }).workspace.digest), decision: "allow", confirmed: true });
    assert.equal(trust?.[0], 200);
  } finally { f.close(); }
});
