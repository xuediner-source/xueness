import { mkdtempSync } from "../../../test-support/canonical-temp.ts";
/**
 * F07.03 — unified hook lifecycle and trust boundary: the trusted-plugin
 * boundary (`hook-boundary.json`), plugin hook admission, configuration
 * revisions that invalidate stale grants, and the UI-facing summary.
 */
import assert from "node:assert/strict";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  admitted, authorizationRevision, canonicalWorkspace, configSummary, discover, grantTrust,
  hooksBinding, loadBoundary, loadTrust, pluginHookRows, pluginTrusted, registerPluginHooks,
  setFeature, stateFileDigest, statusDocument, type Row,
} from "../src/index.ts";

function withEnv(run: (state: string, workspace: string) => void): void {
  const base = mkdtempSync(join(tmpdir(), "hooks-f07-"));
  const state = join(base, "state");
  const workspace = join(base, "ws");
  mkdirSync(state); mkdirSync(workspace);
  try { run(state, workspace); } finally { rmSync(base, { recursive: true, force: true }); }
}
const writeHooks = (workspace: string, entries: Row[]): void => {
  mkdirSync(join(workspace, ".xueness"), { recursive: true });
  writeFileSync(join(workspace, ".xueness", "hooks.json"), JSON.stringify(entries));
};
const hookRow = (command = "echo hello"): Row[] => [{ id: "h1", event: "SessionStart", command }];

describe("F07.03 hook boundary (hook-boundary.json)", () => {
  it("absent means every bundled plugin is trusted", () => withEnv((state) => {
    const boundary = loadBoundary(state);
    assert.deepEqual(boundary, { status: "absent", trustedPlugins: ["*"], trustsAll: true });
    assert.ok(pluginTrusted(boundary, "hooks"));
  }));
  it("an explicit list trusts only its members and [] trusts none", () => withEnv((state) => {
    writeFileSync(join(state, "hook-boundary.json"), JSON.stringify({ schemaVersion: 1, trustedPlugins: ["hooks", "skills"] }));
    const boundary = loadBoundary(state);
    assert.deepEqual(boundary, { status: "ok", trustedPlugins: ["hooks", "skills"], trustsAll: false });
    assert.ok(pluginTrusted(boundary, "hooks") && !pluginTrusted(boundary, "commands"));
    writeFileSync(join(state, "hook-boundary.json"), JSON.stringify({ schemaVersion: 1, trustedPlugins: [] }));
    const none = loadBoundary(state);
    assert.equal(none.status, "ok");
    assert.ok(!pluginTrusted(none, "hooks"));
  }));
  it("a broken boundary is corrupt and trusts no plugin", () => withEnv((state) => {
    const path = join(state, "hook-boundary.json");
    const cases = [
      JSON.stringify({ schemaVersion: 1, trustedPlugins: ["hooks"], extra: 1 }),
      JSON.stringify({ schemaVersion: 2, trustedPlugins: ["hooks"] }),
      "{not json",
      JSON.stringify({ schemaVersion: 1, trustedPlugins: ["hooks", "hooks"] }),
      JSON.stringify({ schemaVersion: 1, trustedPlugins: Array.from({ length: 65 }, (_, i) => `p${i}`) }),
    ];
    for (const text of cases) {
      writeFileSync(path, text);
      const boundary = loadBoundary(state);
      assert.equal(boundary.status, "corrupt", text);
      assert.ok(!pluginTrusted(boundary, "hooks") && !pluginTrusted(boundary, "p0"));
    }
    rmSync(path);
    mkdirSync(join(state, "nowhere"));
    symlinkSync(join(state, "nowhere"), path, process.platform === "win32" ? "junction" : "dir");
    assert.equal(loadBoundary(state).status, "corrupt");
  }));
});

describe("F07.03 plugin hook admission", () => {
  it("admits trusted plugin hooks under a plugin: id and refuses invalid ones", () => {
    const rows: Row[] = [{ id: "a", event: "SessionStart", command: "echo", matcher: "Read", args: ["x"], timeout: 5, pipeline: true }, { id: "b", event: "NotAnEvent", command: "echo" }];
    const { hooks, views } = pluginHookRows([{ plugin: "hooks", rows }], loadBoundary("/nonexistent-state"));
    assert.equal(hooks.length, 1);
    assert.equal(hooks[0]!.id, "plugin:hooks:a");
    assert.equal(hooks[0]!.source, "plugin");
    assert.equal(hooks[0]!.plugin, "hooks");
    assert.equal(hooks[0]!.matcher, "Read");
    assert.equal(hooks[0]!.pipeline, true);
    assert.deepEqual(views.map((view) => [view.id, view.admitted, view.reason]), [["a", true, "plugin_trusted"], ["b", false, "plugin_hook_invalid"]]);
    const refused = pluginHookRows([{ plugin: "hooks", rows: [rows[0]!] }], { status: "ok", trustedPlugins: [], trustsAll: false });
    assert.equal(refused.views[0]!.reason, "plugin_not_trusted");
    assert.equal(refused.hooks.length, 0);
  });
  it("the host registers contributions on the shared binding", () => {
    const binding = hooksBinding();
    registerPluginHooks(binding, "hooks", [{ id: "a", event: "Stop", command: "echo" }]);
    registerPluginHooks(binding, "bad plugin", [{ id: "a", event: "Stop", command: "echo" }]);
    const { views } = pluginHookRows(binding.contributions, loadBoundary("/nonexistent-state"));
    assert.deepEqual(views.map((view) => view.admitted), [true, false]);
  });
});

describe("F07.03 revision-bound workspace hook grants", () => {
  it("a grant holds only while the reviewed configuration is unchanged", () => withEnv((state, workspace) => {
    setFeature(state, true);
    writeHooks(workspace, hookRow());
    let admission = admitted(state, workspace);
    assert.equal(admission.reason, "pending_trust");
    const digest = String(admission.pending[0]!.digest);
    const revision = authorizationRevision(state, workspace);
    assert.ok(grantTrust(state, workspace, admission.pending).ok);
    const record = loadTrust(state).records.find((row) => row.digest === digest);
    assert.equal(record!.configRevisionAtGrant, revision);
    admission = admitted(state, workspace);
    assert.equal(admission.reason, "trusted");
    assert.equal(admission.hooks.length, 1);
    // Editing the declaration changes the revision and makes the grant stale.
    writeHooks(workspace, hookRow("echo changed"));
    assert.notEqual(authorizationRevision(state, workspace), revision);
    admission = admitted(state, workspace);
    assert.equal(admission.reason, "pending_trust");
    assert.equal(admission.hooks.length, 0);
    assert.equal(admission.pending[0]!.staleTrust, true);
    const document = statusDocument(state, workspace) as { items: Record<string, unknown>[]; reason: string; authorizationRevision: string };
    assert.equal(document.items[0]!.trustState, "stale_trust");
    assert.equal(document.reason, "stale_trust");
    assert.match(String(document.authorizationRevision), /^[0-9a-f]{64}$/);
    // Re-granting under the new revision restores the hook.
    assert.ok(grantTrust(state, workspace, admission.pending).ok);
    assert.equal(admitted(state, workspace).reason, "trusted");
  }));
  it("flipping the feature switch also invalidates old grants; legacy grants stay honored", () => withEnv((state, workspace) => {
    setFeature(state, true);
    writeHooks(workspace, hookRow());
    const before = authorizationRevision(state, workspace);
    setFeature(state, false);
    assert.notEqual(authorizationRevision(state, workspace), before);
    setFeature(state, true);
    assert.equal(authorizationRevision(state, workspace), before);
    // A pre-F07.03 record without configRevisionAtGrant is still a valid grant.
    const row = discover(workspace).hooks[0]!;
    writeFileSync(join(state, "hook-trust.json"), JSON.stringify({ schemaVersion: 1, records: [{ workspace: canonicalWorkspace(workspace), digest: row.digest, decision: "trusted", grantedAt: "2026-01-01T00:00:00+00:00" }] }));
    assert.equal(admitted(state, workspace).reason, "trusted");
  }));
  it("re-granting an already-recorded hook re-stamps it to the current revision", () => withEnv((state, workspace) => {
    setFeature(state, true);
    writeHooks(workspace, hookRow());
    assert.ok(grantTrust(state, workspace, admitted(state, workspace).pending).ok);
    assert.equal(admitted(state, workspace).reason, "trusted");
    // A second declaration changes the revision, so the first grant goes stale.
    writeHooks(workspace, [...hookRow(), { id: "second", event: "Stop", command: "echo", args: ["second"] }]);
    const pending = admitted(state, workspace).pending;
    assert.equal(pending.length, 2);
    assert.equal(grantTrust(state, workspace, pending).granted, 2);
    // Re-reviewing restores both: an unchanged record must not pin the old revision.
    assert.equal(admitted(state, workspace).reason, "trusted");
    assert.equal(admitted(state, workspace).pending.length, 0);
  }));
  it("the revision is stable per input bytes and null-safe without a workspace", () => withEnv((state, workspace) => {
    assert.equal(authorizationRevision(state, null), authorizationRevision(state, null));
    assert.equal(authorizationRevision(state, workspace), authorizationRevision(state, workspace));
    writeHooks(workspace, hookRow());
    const withHooks = authorizationRevision(state, workspace);
    assert.notEqual(withHooks, authorizationRevision(state, null));
    writeFileSync(join(state, "note.txt"), "stable bytes");
    assert.equal(stateFileDigest(state, "note.txt", 64), stateFileDigest(state, "note.txt", 64));
    assert.match(String(stateFileDigest(state, "note.txt", 64)), /^[0-9a-f]{64}$/);
    assert.equal(stateFileDigest(state, "absent.json", 64), null);
  }));
});

describe("F07.03 configuration summary (UI state)", () => {
  it("walks the ui.state ladder from feature to trust", () => withEnv((state, workspace) => {
    assert.equal((configSummary as (...args: any[]) => any)(state, workspace).ui.state, "feature_disabled");
    setFeature(state, true);
    assert.equal((configSummary as (...args: any[]) => any)(state, null).ui.state, "no_workspace");
    assert.equal((configSummary as (...args: any[]) => any)(state, workspace).ui.state, "no_workspace_hooks");
    writeHooks(workspace, [{ ...hookRow()[0]!, enabled: false }]);
    assert.equal((configSummary as (...args: any[]) => any)(state, workspace).ui.state, "no_enabled_hooks");
    writeHooks(workspace, hookRow());
    const pending = (configSummary as (...args: any[]) => any)(state, workspace);
    assert.equal(pending.ui.state, "pending_trust");
    assert.equal(pending.ui.pending, 1);
    assert.ok(grantTrust(state, workspace, admitted(state, workspace).pending).ok);
    const trusted = (configSummary as (...args: any[]) => any)(state, workspace, { contributions: [{ plugin: "hooks", rows: [{ id: "a", event: "Stop", command: "echo" }] }] });
    assert.equal(trusted.ui.state, "trusted");
    assert.equal(trusted.ui.trusted, 1);
    assert.equal(trusted.ui.pluginHooksAdmitted, 1);
    assert.equal(trusted.boundary.workspaceScripts, "digest");
    assert.deepEqual(trusted.userHooks, []);
    writeFileSync(join(state, "hook-trust.json"), "{broken");
    assert.equal((configSummary as (...args: any[]) => any)(state, workspace).ui.state, "trust_store_corrupt");
  }));
});
