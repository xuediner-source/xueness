/** H04.03/H04.04: Cursor/Claude/DeepSeek rule pack import and MCP/tool bundle mounting. */
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { HarnessRegistry } from "../src/registry.ts";
import {
  CLAUDE_SKILLS_DIR, CURSOR_RULES_FILE, DEEPSEEK_HARNESS_DOTFILE, IMPORTED_PACK_VERSION,
  detectRulePackFormats, importRulePacks, importToolBundle,
} from "../src/compat/rule-pack-importer.ts";

const root = mkdtempSync(join(tmpdir(), "xueness-rule-packs-"));
after(() => rmSync(root, { recursive: true, force: true }));

const harnessManifest = (id: string, over: Partial<Record<string, unknown>> = {}): Record<string, unknown> => ({
  sdkApiVersion: 1,
  id,
  version: "2.0.0",
  tools: [{ name: `${id}-search`, gate: "mcp", mutating: false, description: "bundle tool" }],
  hooks: [],
  verifiers: [],
  skills: [],
  promptTemplates: [],
  ...over,
});

const now = (): string => "2026-10-26T00:00:00.000Z";

let cursorDir = "";
let cursorMdcDir = "";
let claudeDir = "";
let bundleDir = "";
let dotHarnessDir = "";
let multiDir = "";
let emptyDir = "";
before(() => {
  cursorDir = join(root, "Cursor Rules App");
  mkdirSync(cursorDir);
  writeFileSync(join(cursorDir, CURSOR_RULES_FILE), "Always use TypeScript.\n");

  cursorMdcDir = join(root, "mdc-project");
  mkdirSync(join(cursorMdcDir, ".cursor", "rules"), { recursive: true });
  writeFileSync(join(cursorMdcDir, ".cursor", "rules", "Always TS.mdc"), "use ts");
  writeFileSync(join(cursorMdcDir, ".cursor", "rules", "naming.md"), "use kebab case");
  writeFileSync(join(cursorMdcDir, ".cursor", "rules", "notes.txt"), "ignored");

  claudeDir = join(root, "claude-project");
  mkdirSync(join(claudeDir, ...CLAUDE_SKILLS_DIR.split("/"), "repo-map"), { recursive: true });
  mkdirSync(join(claudeDir, ...CLAUDE_SKILLS_DIR.split("/"), "patch-review"), { recursive: true });
  mkdirSync(join(claudeDir, ...CLAUDE_SKILLS_DIR.split("/"), "not-a-skill"), { recursive: true });
  writeFileSync(join(claudeDir, ...CLAUDE_SKILLS_DIR.split("/"), "repo-map", "SKILL.md"), "---\nname: repo-map\n---\nmap repos");
  writeFileSync(join(claudeDir, ...CLAUDE_SKILLS_DIR.split("/"), "patch-review", "SKILL.md"), "review patches");
  writeFileSync(join(claudeDir, ...CLAUDE_SKILLS_DIR.split("/"), "not-a-skill", "README.md"), "no SKILL.md here");

  bundleDir = join(root, "mcp-bundle");
  mkdirSync(bundleDir);
  writeFileSync(join(bundleDir, "deepseek-harness.json"), JSON.stringify(harnessManifest("external-mcp-bundle")));

  dotHarnessDir = join(root, "dot-project");
  mkdirSync(dotHarnessDir);
  writeFileSync(join(dotHarnessDir, DEEPSEEK_HARNESS_DOTFILE), JSON.stringify(harnessManifest("dotted-harness")));

  multiDir = join(root, "123-mixed");
  mkdirSync(join(multiDir, ...CLAUDE_SKILLS_DIR.split("/"), "writer"), { recursive: true });
  writeFileSync(join(multiDir, CURSOR_RULES_FILE), "be terse");
  writeFileSync(join(multiDir, ...CLAUDE_SKILLS_DIR.split("/"), "writer", "SKILL.md"), "write docs");

  emptyDir = join(root, "empty-project");
  mkdirSync(emptyDir);
});

describe("format detection", () => {
  it("recognizes each format and several at once", () => {
    assert.deepEqual(detectRulePackFormats(cursorDir), { ok: true, formats: ["cursor"] });
    assert.deepEqual(detectRulePackFormats(claudeDir), { ok: true, formats: ["claude-skills"] });
    assert.deepEqual(detectRulePackFormats(bundleDir), { ok: true, formats: ["deepseek-harness"] });
    assert.deepEqual(detectRulePackFormats(dotHarnessDir), { ok: true, formats: ["deepseek-harness"] });
    assert.deepEqual(detectRulePackFormats(multiDir), { ok: true, formats: ["cursor", "claude-skills"] });
  });

  it("refuses missing paths, files and unrecognized roots", () => {
    assert.ok(!detectRulePackFormats(join(root, "nope")).ok);
    assert.ok(!detectRulePackFormats(join(cursorDir, CURSOR_RULES_FILE)).ok);
    assert.deepEqual(detectRulePackFormats(emptyDir), { ok: true, formats: [] });
  });
});

describe("H04.03 rule pack import", () => {
  it("imports .cursorrules as a converted cursor pack", () => {
    const registry = new HarnessRegistry();
    const result = importRulePacks(registry, cursorDir, { now });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.imported.length, 1);
    assert.equal(result.imported[0]?.format, "cursor");
    assert.equal(result.imported[0]?.entry.id, "cursor-rules-app-cursor");
    assert.equal(result.imported[0]?.entry.version, IMPORTED_PACK_VERSION);
    assert.equal(result.imported[0]?.entry.manifest.promptTemplates[0]?.template, "Always use TypeScript.");
    const row = registry.list()[0];
    assert.equal(row?.id, "cursor-rules-app-cursor");
    assert.deepEqual(row?.contributions, { tools: 0, hooks: 0, verifiers: 0, skills: 0, promptTemplates: 1 });
    assert.equal(registry.ownerOf("promptTemplates:cursor-rules"), "cursor-rules-app-cursor");
  });

  it("imports .cursor/rules mdc and md files as slugged templates", () => {
    const registry = new HarnessRegistry();
    const result = importRulePacks(registry, cursorMdcDir, { now });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const templates = result.imported[0]?.entry.manifest.promptTemplates ?? [];
    assert.deepEqual(templates.map((template) => template.id).sort(), ["always-ts", "naming"]);
    assert.equal(templates.find((template) => template.id === "naming")?.template, "use kebab case");
  });

  it("imports .claude/skills as skills with source-relative paths", () => {
    const registry = new HarnessRegistry();
    const result = importRulePacks(registry, claudeDir, { now });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const entry = result.imported[0]?.entry;
    assert.equal(entry?.id, "claude-project-claude-skills");
    assert.deepEqual(entry?.manifest.skills.map((skill) => skill.id), ["patch-review", "repo-map"]);
    assert.equal(entry?.manifest.skills[0]?.path, `${CLAUDE_SKILLS_DIR}/patch-review/SKILL.md`);
    assert.equal(registry.ownerOf("skills:repo-map"), "claude-project-claude-skills");
    // The skill files resolve under the mounted source, so the resolver check is green.
    const item = registry.verify("claude-project-claude-skills").items[0];
    assert.ok(item?.checks.some((check) => check.name === "contributions_resolved" && check.ok));
  });

  it("imports .deepseek-harness.json and a native bundle manifest natively", () => {
    const registry = new HarnessRegistry();
    const dotted = importRulePacks(registry, dotHarnessDir, { now });
    assert.equal(dotted.ok, true);
    if (dotted.ok) assert.equal(dotted.imported[0]?.entry.id, "dotted-harness");
    const native = importRulePacks(registry, bundleDir, { now });
    assert.equal(native.ok, true);
    if (native.ok) {
      assert.equal(native.imported[0]?.format, "deepseek-harness");
      assert.equal(native.imported[0]?.entry.version, "2.0.0");
      assert.equal(native.imported[0]?.entry.manifest.tools[0]?.gate, "mcp");
    }
    assert.deepEqual(registry.list().map((row) => row.id), ["dotted-harness", "external-mcp-bundle"]);
  });

  it("imports every detected format from one mixed root, all-or-nothing", () => {
    const registry = new HarnessRegistry();
    const result = importRulePacks(registry, multiDir, { now });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.imported.map((pack) => pack.format), ["cursor", "claude-skills"]);
    assert.equal(result.imported[0]?.entry.id, "pack-123-mixed-cursor");
    assert.equal(registry.size, 2);
    // A broken claude half aborts the whole call: nothing lands at all.
    const broken = join(root, "broken-mixed");
    mkdirSync(join(broken, ...CLAUDE_SKILLS_DIR.split("/"), "empty"), { recursive: true });
    writeFileSync(join(broken, CURSOR_RULES_FILE), "be terse");
    const refused = importRulePacks(registry, broken, { now });
    assert.ok(!refused.ok && refused.error.code === "empty_pack");
    assert.equal(registry.size, 2);
  });

  it("honors the id option, refuses duplicates and rolls back cleanly", () => {
    const registry = new HarnessRegistry();
    assert.equal(importRulePacks(registry, cursorDir, { now, id: "My Pack" }).ok, true);
    assert.equal(registry.list()[0]?.id, "my-pack-cursor");
    const again = importRulePacks(registry, cursorDir, { now, id: "My Pack" });
    assert.ok(!again.ok && again.error.code === "already_mounted");
    assert.equal(registry.size, 1);
    assert.equal(registry.unmount("my-pack-cursor"), true);
    assert.equal(registry.size, 0);
  });

  it("refuses unreadable, symlinked and oversized rule files", () => {
    const registry = new HarnessRegistry();
    const blank = join(root, "blank-cursor");
    mkdirSync(blank);
    writeFileSync(join(blank, CURSOR_RULES_FILE), "   \n");
    const emptyPack = importRulePacks(registry, blank, { now });
    assert.ok(!emptyPack.ok && emptyPack.error.code === "empty_pack");

    const linked = join(root, "linked-cursor");
    mkdirSync(linked);
    symlinkSync(process.platform === "win32" ? cursorDir : join(cursorDir, CURSOR_RULES_FILE),
      join(linked, CURSOR_RULES_FILE), process.platform === "win32" ? "junction" : "file");
    const sym = importRulePacks(registry, linked, { now });
    assert.ok(!sym.ok && sym.error.code === "symlink_refused");

    const huge = join(root, "huge-cursor");
    mkdirSync(huge);
    writeFileSync(join(huge, CURSOR_RULES_FILE), "x".repeat(300000));
    const big = importRulePacks(registry, huge, { now });
    assert.ok(!big.ok && big.error.code === "too_large");
    assert.equal(registry.size, 0);
  });

  it("refuses an invalid .deepseek-harness.json with structured issues", () => {
    const registry = new HarnessRegistry();
    const invalid = join(root, "invalid-dot");
    mkdirSync(invalid);
    writeFileSync(join(invalid, DEEPSEEK_HARNESS_DOTFILE), JSON.stringify({ sdkApiVersion: 9, id: "Bad Id" }));
    const result = importRulePacks(registry, invalid, { now });
    assert.ok(!result.ok && result.error.code === "invalid_manifest" && result.error.issues?.length);
    assert.equal(registry.size, 0);
  });
});

describe("H04.04 MCP/tool bundle import", () => {
  it("imports an external MCP/tool bundle that lists and verifies green", () => {
    const registry = new HarnessRegistry();
    const result = importToolBundle(registry, bundleDir, { now });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.entry.id, "external-mcp-bundle");
    assert.equal(result.entry.manifest.tools[0]?.gate, "mcp");
    const row = registry.list()[0];
    assert.equal(row?.contributions.tools, 1);
    assert.equal(registry.ownerOf("tools:external-mcp-bundle-search"), "external-mcp-bundle");
    const report = registry.verify();
    assert.equal(report.ok, true);
    assert.equal(report.items[0]?.status, "ok");
  });

  it("imports a bundle from the .deepseek-harness.json dot file too", () => {
    const registry = new HarnessRegistry();
    const result = importToolBundle(registry, dotHarnessDir, { now });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.entry.manifest.tools.length, 1);
    assert.equal(registry.list()[0]?.id, "dotted-harness");
  });

  it("refuses harnesses without tools and clashing bundles without residue", () => {
    const registry = new HarnessRegistry();
    const noTools = join(root, "no-tools");
    mkdirSync(noTools);
    writeFileSync(join(noTools, "deepseek-harness.json"), JSON.stringify(harnessManifest("toolless", { tools: [] })));
    const refused = importToolBundle(registry, noTools, { now });
    assert.ok(!refused.ok && refused.error.code === "not_a_bundle");
    assert.equal(registry.size, 0);
    // Same tool name in a second bundle: the mount is refused and rolled back.
    assert.equal(importToolBundle(registry, bundleDir, { now }).ok, true);
    const clashing = join(root, "clashing-bundle");
    mkdirSync(clashing);
    writeFileSync(join(clashing, "deepseek-harness.json"), JSON.stringify(harnessManifest("other-bundle", { tools: [{ name: "external-mcp-bundle-search", gate: "read", mutating: false }] })));
    const clash = importToolBundle(registry, clashing, { now });
    assert.ok(!clash.ok && clash.error.code === "mount_refused");
    assert.deepEqual(registry.list().map((row) => row.id), ["external-mcp-bundle"]);
  });

  it("refuses missing or non-directory bundle sources", () => {
    const registry = new HarnessRegistry();
    const missing = importToolBundle(registry, join(root, "ghost"), { now });
    assert.ok(!missing.ok && missing.error.code === "not_found");
    const file = importToolBundle(registry, join(cursorDir, CURSOR_RULES_FILE), { now });
    assert.ok(!file.ok && file.error.code === "not_a_directory");
  });
});
