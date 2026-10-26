/** H01.05/H01.06: harness directory/package hot loading, rollback, and the RPC entry points. */
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  HARNESS_MANIFEST_FILE, HARNESS_METHODS, HARNESS_SDK_API_VERSION, HarnessRegistry, createHarnessApi, harnessCommand,
  loadHarness, parseHarnessManifest, readHarnessManifest, type HarnessManifest, type HarnessMountTarget,
} from "../src/index.ts";

const root = mkdtempSync(join(tmpdir(), "xueness-harness-loader-"));
after(() => rmSync(root, { recursive: true, force: true }));

const directoryManifest = (over: Partial<Record<string, unknown>> = {}): Record<string, unknown> => ({
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

let harnessDir = "";
let packageDir = "";
before(() => {
  harnessDir = join(root, "critic-solver");
  packageDir = join(root, "packaged-harness");
  mkdirSync(join(harnessDir, "skills", "repo-map"), { recursive: true });
  writeFileSync(join(harnessDir, HARNESS_MANIFEST_FILE), JSON.stringify(directoryManifest()));
  writeFileSync(join(harnessDir, "skills", "repo-map", "SKILL.md"), "# repo map\n");
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name: "packaged-harness", xuenessHarness: { ...directoryManifest(), id: "packaged-harness", version: "0.3.1" } }));
});

describe("manifest parsing", () => {
  it("accepts a well-formed manifest and keeps every contribution", () => {
    const { manifest, issues } = parseHarnessManifest(directoryManifest());
    assert.deepEqual(issues, []);
    assert.equal(manifest?.id, "critic-solver");
    assert.equal(manifest?.tools[0]?.mutating, false);
    assert.equal(manifest?.promptTemplates[0]?.template, "solve it");
  });

  it("refuses wrong sdk versions, malformed ids and duplicate contributions", () => {
    const bad = directoryManifest({ sdkApiVersion: 2, id: "Bad Id", tools: [{ name: "dup", gate: "read", mutating: false }, { name: "dup", gate: "read", mutating: false }] });
    const issues = parseHarnessManifest(bad).issues.map((issue) => issue.path);
    assert.ok(issues.includes("/sdkApiVersion"));
    assert.ok(issues.includes("/id"));
    assert.ok(issues.includes("/tools/1"));
    assert.equal(parseHarnessManifest([]).manifest, null);
  });
});

describe("reading sources", () => {
  it("reads a directory source from deepseek-harness.json", () => {
    const read = readHarnessManifest(harnessDir);
    assert.equal(read.ok, true);
    if (read.ok) {
      assert.equal(read.source.kind, "directory");
      assert.equal(read.source.manifest.id, "critic-solver");
    }
  });

  it("reads a package source from the package.json xuenessHarness block", () => {
    const read = readHarnessManifest(packageDir);
    assert.equal(read.ok, true);
    if (read.ok) {
      assert.equal(read.source.kind, "package");
      assert.equal(read.source.manifest.version, "0.3.1");
    }
  });

  it("refuses missing sources and sources without any harness manifest", () => {
    const empty = join(root, "empty");
    mkdirSync(empty);
    assert.equal(readHarnessManifest(join(root, "nope")).ok, false);
    const read = readHarnessManifest(empty);
    assert.ok(!read.ok && read.error.code === "manifest_missing");
  });

  it("refuses symlinked manifests and oversized manifests", () => {
    const linked = join(root, "linked");
    mkdirSync(linked);
    // A junction in the manifest slot exercises Windows reparse refusal without symlink privileges.
    symlinkSync(process.platform === "win32" ? harnessDir : join(harnessDir, HARNESS_MANIFEST_FILE),
      join(linked, HARNESS_MANIFEST_FILE), process.platform === "win32" ? "junction" : "file");
    const read = readHarnessManifest(linked);
    assert.ok(!read.ok && read.error.code === "symlink_refused");
    const huge = join(root, "huge");
    mkdirSync(huge);
    writeFileSync(join(huge, HARNESS_MANIFEST_FILE), `{ "sdkApiVersion": ${"1".padStart(300000, " ")}}`);
    const big = readHarnessManifest(huge);
    assert.ok(!big.ok && big.error.code === "too_large");
  });
});

describe("hot load and unload", () => {
  it("loads, lists and unloads a directory harness", () => {
    const registry = new HarnessRegistry();
    const loaded = loadHarness(registry, harnessDir, { now: () => "2026-10-26T00:00:00.000Z" });
    assert.equal(loaded.ok, true);
    const rows = registry.list();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.id, "critic-solver");
    assert.equal(rows[0]?.loadedAt, "2026-10-26T00:00:00.000Z");
    assert.deepEqual(rows[0]?.contributions, { tools: 1, hooks: 1, verifiers: 1, skills: 1, promptTemplates: 1 });
    assert.equal(registry.unmount("critic-solver"), true);
    assert.equal(registry.unmount("critic-solver"), false);
    assert.deepEqual(registry.list(), []);
  });

  it("refuses to load the same harness twice", () => {
    const registry = new HarnessRegistry();
    assert.equal(loadHarness(registry, harnessDir).ok, true);
    const again = loadHarness(registry, harnessDir);
    assert.ok(!again.ok && again.error.code === "already_mounted");
    assert.equal(registry.size, 1);
  });

  it("rolls a failed load back completely", () => {
    const registry = new HarnessRegistry();
    assert.equal(loadHarness(registry, harnessDir).ok, true);
    // Same tool name in a different harness: the registry refuses halfway.
    const clashing = join(root, "clashing");
    mkdirSync(clashing);
    writeFileSync(join(clashing, HARNESS_MANIFEST_FILE), JSON.stringify(directoryManifest({ id: "other-harness", tools: [{ name: "critique", gate: "write", mutating: true }] })));
    const failed = loadHarness(registry, clashing);
    assert.ok(!failed.ok && failed.error.code === "mount_refused");
    // Rollback: only the first harness is mounted and it owns its tool again.
    assert.deepEqual(registry.list().map((row) => row.id), ["critic-solver"]);
    assert.equal(registry.ownerOf("tools:critique"), "critic-solver");
    // After unloading the first, the clashing harness loads fine.
    registry.unmount("critic-solver");
    assert.equal(loadHarness(registry, clashing).ok, true);
  });

  it("leaves the registry untouched when the target throws before inserting", () => {
    const refusing: HarnessMountTarget = { mount: () => { throw new Error("nope"); }, unmount: () => false };
    const result = loadHarness(refusing, harnessDir);
    assert.ok(!result.ok && result.error.code === "mount_refused");
  });

  it("rolls back when a manifest is invalid or unreadable", () => {
    const registry = new HarnessRegistry();
    const invalid = join(root, "invalid");
    mkdirSync(invalid);
    writeFileSync(join(invalid, HARNESS_MANIFEST_FILE), JSON.stringify(directoryManifest({ version: "one" })));
    const bad = loadHarness(registry, invalid);
    assert.ok(!bad.ok && bad.error.code === "invalid_manifest" && bad.error.issues?.length);
    assert.equal(registry.size, 0);
  });
});

describe("registry verify", () => {
  it("reports ok for a healthy mount and degraded for drift", () => {
    const registry = new HarnessRegistry();
    assert.equal(loadHarness(registry, harnessDir).ok, true);
    const healthy = registry.verify();
    assert.equal(healthy.ok, true);
    assert.equal(healthy.items[0]?.status, "ok");
    // Drift: bump the version on disk without reloading.
    writeFileSync(join(harnessDir, HARNESS_MANIFEST_FILE), JSON.stringify(directoryManifest({ version: "1.3.0" })));
    const drifted = registry.verify();
    assert.equal(drifted.ok, false);
    assert.equal(drifted.items[0]?.status, "degraded");
    assert.ok(drifted.items[0]?.checks.some((check) => check.name === "manifest_current" && !check.ok));
    // And a missing skill file degrades contributions_resolved.
    writeFileSync(join(harnessDir, HARNESS_MANIFEST_FILE), JSON.stringify(directoryManifest()));
    rmSync(join(harnessDir, "skills", "repo-map", "SKILL.md"));
    const missing = registry.verify("critic-solver");
    assert.equal(missing.ok, false);
    assert.ok(missing.items[0]?.checks.some((check) => check.name === "contributions_resolved" && !check.ok));
    writeFileSync(join(harnessDir, "skills", "repo-map", "SKILL.md"), "# repo map\n");
    assert.equal(registry.verify().ok, true);
  });

  it("reports an unknown id as a structured failed item", () => {
    const report = new HarnessRegistry().verify("ghost");
    assert.equal(report.ok, false);
    assert.equal(report.items[0]?.checks[0]?.name, "mounted");
  });
});

describe("RPC and CLI entry points", () => {
  it("serves load/unload/list/verify over one registry", async () => {
    const api = createHarnessApi({ now: () => "2026-10-26T00:00:00.000Z" });
    assert.deepEqual([...api.methods], [...HARNESS_METHODS]);
    assert.equal(api.owns("deepseek_harness/list"), true);
    assert.equal(api.owns("deepseek_harness/nope"), false);
    const loaded = await api.dispatch("deepseek_harness/load", { source: harnessDir });
    assert.equal(loaded.ok, true);
    const listed = await api.dispatch("deepseek_harness/list", {});
    assert.equal(listed.count, 1);
    assert.equal((listed.items as Array<{ id: string }>)[0]?.id, "critic-solver");
    const verified = await api.dispatch("deepseek_harness/verify", {});
    assert.equal(verified.ok, true);
    const unloaded = await api.dispatch("deepseek_harness/unload", { id: "critic-solver" });
    assert.equal(unloaded.ok, true);
    const gone = await api.dispatch("deepseek_harness/unload", { id: "critic-solver" });
    assert.ok(!gone.ok && (gone.error as { code: string }).code === "not_mounted");
  });

  it("validates input, refuses unknown methods and honors the enabled gate", async () => {
    const api = createHarnessApi();
    assert.equal((await api.dispatch("deepseek_harness/load", {})).ok, false);
    assert.equal(((await api.dispatch("deepseek_harness/load", { source: 1 })) as { error: { code: string } }).error.code, "invalid_input");
    assert.equal(((await api.dispatch("deepseek_harness/other", {})) as { error: { code: string } }).error.code, "unknown_method");
    const off = createHarnessApi({ enabled: () => false });
    assert.equal(((await off.dispatch("deepseek_harness/list", {})) as { error: { code: string } }).error.code, "disabled");
  });

  it("runs the CLI over the same dispatch", async () => {
    const registry = new HarnessRegistry();
    const options = { registry, now: () => "2026-10-26T00:00:00.000Z" };
    const loaded = await harnessCommand(["load", harnessDir], options);
    assert.equal(loaded.code, 0);
    const listed = await harnessCommand(["list"], options);
    assert.match(listed.output, /"count":1/);
    const verified = await harnessCommand(["verify"], options);
    assert.equal(verified.code, 0);
    const bad = await harnessCommand(["load"], options);
    assert.equal(bad.code, 2);
  });
});
