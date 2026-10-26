/**
 * H08.01 — deepseek_harness × extensions E2E.
 *
 * One marketplace story end to end: a data-only package is installed through
 * the extensions resource route (`POST /api/resources/plugins`, the same
 * dispatch the extensions plugin mounts), its harness source directory lives
 * under the same extensions path (`<state>/resources/plugins/<id>/`), and the
 * deepseek_harness RPC hot-loads that source so every declared contribution
 * (tool, hook, verifier, skill, prompt template) is indexed, listed and
 * verified. Both plugins stay declarative: the extensions gate keeps packages
 * data-only and the harness loader refuses linked or invalid manifests, so
 * nothing on the extensions path ever executes.
 */
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { resourceDispatch } from "@xueness/sessions";
import { contributionIssues, describePackage, loadDataManifests, SDK_API_VERSION } from "@xueness/plugin-extensions";
import { createHarnessApi, HARNESS_MANIFEST_FILE, HARNESS_SDK_API_VERSION, readHarnessManifest, type HarnessApi } from "../src/index.ts";

const base = mkdtempSync(join(tmpdir(), "xueness-e2e-extensions-"));
const state = join(base, "state");
const pluginsDir = join(state, "resources", "plugins");
after(() => rmSync(base, { recursive: true, force: true }));

/** The harness source the marketplace package ships, as declarative data. */
const harnessManifest = (over: Partial<Record<string, unknown>> = {}): Record<string, unknown> => ({
  sdkApiVersion: HARNESS_SDK_API_VERSION,
  id: "critic-solver",
  version: "1.2.0",
  tools: [{ name: "critique", gate: "read", mutating: false, description: "critique a patch" }],
  hooks: [{ event: "after_tool_execution", handler: "critic.on_tool" }],
  verifiers: [{ name: "tests-pass", command: "pytest -q" }],
  skills: [{ id: "repo-map", path: "skills/repo-map/SKILL.md" }],
  promptTemplates: [{ id: "solver-system", template: "solve it" }],
  ...over,
});

/** The extensions marketplace document describing that harness package. */
const marketDocument = (over: Partial<Record<string, unknown>> = {}): Record<string, unknown> => ({
  id: "critic-solver-market",
  version: "0.1.0",
  apiVersion: SDK_API_VERSION,
  enabled: false,
  builtin: "hooks",
  capabilities: ["command"],
  description: "Marketplace listing for the critic-solver DeepSeek harness.",
  components: { hooks: [{ id: "auto-verify", description: "Run the harness gates after edits", alwaysLoad: false }] },
  events: [{ name: "critic-solver-market.gates-green", description: "All harness gates passed after an edit." }],
  ...over,
});

const criticDir = join(pluginsDir, "critic-solver");
let api: HarnessApi;

const load = async (source: string): Promise<Record<string, unknown>> => await api.dispatch("deepseek_harness/load", { source });
const listed = async (): Promise<Record<string, unknown>[]> => {
  const row = await api.dispatch("deepseek_harness/list", {});
  assert.equal(row.ok, true);
  return row.items as Record<string, unknown>[];
};

before(async () => {
  mkdirSync(join(criticDir, "skills", "repo-map"), { recursive: true });
  writeFileSync(join(criticDir, HARNESS_MANIFEST_FILE), JSON.stringify(harnessManifest()));
  writeFileSync(join(criticDir, "skills", "repo-map", "SKILL.md"), "# repo map\n");
  // The extensions plugin installs marketplace packages through the shared
  // resource dispatch; the test uses that exact route, not a private writer.
  const reply = resourceDispatch(state, "POST", ["api", "resources", "plugins"], marketDocument());
  assert.ok(reply, "the extensions resource route owns this dispatch");
  const [code, body] = reply;
  assert.equal(code, 200, `marketplace install failed: ${JSON.stringify(body)}`);
  api = createHarnessApi({ now: () => "2026-10-26T00:00:00.000Z" });
});

describe("H08.01 deepseek_harness × extensions E2E", () => {
  it("installs the marketplace package and keeps it data-only on the extensions path", () => {
    const manifests = loadDataManifests(state);
    assert.deepEqual(manifests.map((manifest) => manifest.id), ["critic-solver-market"]);
    assert.equal(manifests[0]?.builtin, "hooks");
    assert.deepEqual(contributionIssues(marketDocument()), [], "the listing must pass the extensions contribution checklist");
    const described = describePackage(marketDocument());
    assert.ok(described, "the listing must normalize into a package description");
    assert.deepEqual(described?.components.byKind.hooks, ["auto-verify"]);
    // The complementary gate: a package that reaches for build-manifest powers
    // is rejected, so the extensions path can never grow executable glue.
    const grabbing = contributionIssues(marketDocument({ features: [{ id: "critic-solver-market.sneaky" }] }));
    assert.ok(grabbing.some((issue) => issue.path === "critic-solver-market/features" && issue.message.includes("build-manifest power")));
  });

  it("hot-loads the harness source from the extensions path and indexes every contribution", async () => {
    const loaded = await load(criticDir);
    assert.deepEqual(loaded, {
      ok: true, id: "critic-solver", kind: "directory", version: "1.2.0", source: criticDir, loadedAt: "2026-10-26T00:00:00.000Z",
    });
    const registry = api.registry;
    assert.equal(registry.ownerOf("tools:critique"), "critic-solver");
    assert.equal(registry.ownerOf("hooks:after_tool_execution:critic.on_tool"), "critic-solver");
    assert.equal(registry.ownerOf("verifiers:tests-pass"), "critic-solver");
    assert.equal(registry.ownerOf("skills:repo-map"), "critic-solver");
    assert.equal(registry.ownerOf("promptTemplates:solver-system"), "critic-solver");
    const [row] = await listed();
    assert.deepEqual(row?.contributions, { tools: 1, hooks: 1, verifiers: 1, skills: 1, promptTemplates: 1 });
  });

  it("verifies the extensions-path mount with every check green", async () => {
    const report = await api.dispatch("deepseek_harness/verify", { id: "critic-solver" });
    assert.equal(report.ok, true);
    const [item] = report.items as Record<string, unknown>[];
    assert.equal(item?.status, "ok");
    const checks = item?.checks as Record<string, unknown>[];
    assert.deepEqual(checks.map((check) => check.name), ["sdk_supported", "source_present", "manifest_current", "contributions_resolved"]);
    assert.ok(checks.every((check) => check.ok === true));
  });

  it("loads package-kind harness sources from the extensions path", async () => {
    const packaged = join(pluginsDir, "packaged-harness");
    mkdirSync(packaged, { recursive: true });
    writeFileSync(join(packaged, "package.json"), JSON.stringify({
      name: "packaged-harness",
      xuenessHarness: {
        ...harnessManifest(),
        id: "packaged-harness",
        version: "0.3.1",
        tools: [{ name: "critique-packaged", gate: "read", mutating: false, description: "critique a patch (packaged)" }],
        hooks: [{ event: "after_tool_execution", handler: "packaged.on_tool" }],
        verifiers: [{ name: "tests-pass-packaged", command: "pytest -q" }],
        skills: [{ id: "repo-map-packaged", path: "skills/repo-map/SKILL.md" }],
        promptTemplates: [{ id: "solver-system-packaged", template: "solve it (packaged)" }],
      },
    }));
    const loaded = await load(packaged);
    assert.equal(loaded.ok, true);
    assert.equal(loaded.kind, "package");
    assert.equal(loaded.id, "packaged-harness");
    assert.equal(api.registry.ownerOf("tools:critique"), "critic-solver", "the packaged duplicate must not shadow the directory mount's tool");
    assert.equal(api.registry.ownerOf("tools:critique-packaged"), "packaged-harness");
  });

  it("refuses the installed data manifest file as a harness source", async () => {
    // Data manifests are single JSON documents, not source directories; the
    // loader keeps the two extension shapes apart.
    const refused = await load(join(pluginsDir, "critic-solver-market.json"));
    assert.equal(refused.ok, false);
    assert.equal((refused as { error: { code: string } }).error.code, "not_a_directory");
  });

  it("refuses a cross-harness contribution conflict without touching live mounts", async () => {
    const rival = join(pluginsDir, "rival-harness");
    mkdirSync(rival, { recursive: true });
    writeFileSync(join(rival, HARNESS_MANIFEST_FILE), JSON.stringify(harnessManifest({ id: "rival-harness" })));
    const before = await listed();
    const refused = await load(rival);
    assert.equal(refused.ok, false);
    assert.equal((refused as { error: { code: string } }).error.code, "mount_refused");
    assert.equal(api.registry.size, before.length, "a refused mount must leave the registry exactly as it was");
    assert.equal(api.registry.ownerOf("tools:critique"), "critic-solver");
  });

  it("hot-upgrades through the extensions path after an unload", async () => {
    assert.equal((await api.dispatch("deepseek_harness/unload", { id: "critic-solver" })).ok, true);
    assert.equal(api.registry.ownerOf("tools:critique"), null, "unmount frees every contribution the harness owned");
    writeFileSync(join(criticDir, HARNESS_MANIFEST_FILE), JSON.stringify(harnessManifest({ version: "1.3.0" })));
    const reloaded = await load(criticDir);
    assert.equal(reloaded.ok, true);
    assert.equal(reloaded.version, "1.3.0");
    const rows = await listed();
    assert.equal(rows.find((row) => row.id === "critic-solver")?.version, "1.3.0");
  });

  it("keeps extensions-path integrity refusals structured", async () => {
    const linked = join(pluginsDir, "linked-harness");
    mkdirSync(join(linked, "skills"), { recursive: true });
    symlinkSync(process.platform === "win32" ? criticDir : join(criticDir, HARNESS_MANIFEST_FILE),
      join(linked, HARNESS_MANIFEST_FILE), process.platform === "win32" ? "junction" : "file");
    const refused = await load(linked);
    assert.equal(refused.ok, false);
    assert.equal((refused as { error: { code: string } }).error.code, "symlink_refused");

    const stale = join(pluginsDir, "stale-harness");
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(stale, HARNESS_MANIFEST_FILE), JSON.stringify(harnessManifest({ id: "stale-harness", sdkApiVersion: HARNESS_SDK_API_VERSION + 1 })));
    const staleLoad = await load(stale);
    assert.equal(staleLoad.ok, false);
    const error = (staleLoad as { error: { code: string; message: string } }).error;
    assert.equal(error.code, "invalid_manifest");
    assert.ok(error.message.includes(HARNESS_MANIFEST_FILE), "the refusal names the rejected manifest");
    // The RPC row stays flat; the structured issues ride on the loader result.
    const read = readHarnessManifest(stale);
    assert.equal(read.ok, false);
    assert.ok(!read.ok && read.error.issues?.some((issue) => issue.path === "/sdkApiVersion"), "the SDK mismatch must be reported with its manifest path");
  });
});
