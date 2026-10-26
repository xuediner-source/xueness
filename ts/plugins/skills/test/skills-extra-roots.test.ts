import { mkdtempSync } from "../../../test-support/canonical-temp.ts";
/**
 * F07.04 — additional skill directories: `<state>/skill-directories.json`
 * lists operator roots, each its own jail, optionally namespaced. Same-name
 * collisions are never silent — the loser stays listed as shadowed, and a
 * namespaced root keeps its copy reachable as `namespace:name` — while the
 * shipped bundled skills keep working beside the new roots.
 */
import assert from "node:assert/strict";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  BUNDLED_SKILLS_DIR, extraSkillRoots, listAll, loadSkill, loadSkillDirectories,
  MAX_EXTRA_SKILL_ROOTS, namespacedName,
} from "../src/index.ts";

const base = mkdtempSync(join(tmpdir(), "xue-skills-extra-"));
after(() => rmSync(base, { recursive: true, force: true }));

const skill = (directory: string, name: string, body = `Use ${name}.`): string => {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "SKILL.md");
  writeFileSync(path, `---\nname: ${name}\ndescription: ${name} skill\n---\n\n${body}\n`);
  return path;
};
const configure = (state: string, directories: unknown[]): void => {
  writeFileSync(join(state, "skill-directories.json"), JSON.stringify({ schemaVersion: 1, directories }));
};

describe("F07.04 skill-directories.json loading", () => {
  it("absent means no extra roots", () => {
    const state = join(base, "s-absent"); mkdirSync(state);
    assert.deepEqual(loadSkillDirectories(state), { directories: [], diagnostics: [], status: "absent" });
    assert.deepEqual(extraSkillRoots(state), []);
  });
  it("resolves relative and absolute paths against the state directory and keeps namespace and enabled", () => {
    const state = join(base, "s-ok"); mkdirSync(state);
    mkdirSync(join(base, "abs-skills"), { recursive: true });
    configure(state, [{ path: "../rel-skills" }, { path: join(base, "abs-skills"), namespace: "docs" }, { path: "../off", enabled: false }]);
    const loaded = loadSkillDirectories(state);
    assert.equal(loaded.status, "ok");
    assert.deepEqual(loaded.diagnostics, []);
    assert.deepEqual(loaded.directories, [
      { path: join(base, "rel-skills"), namespace: null, enabled: true },
      { path: join(base, "abs-skills"), namespace: "docs", enabled: true },
      { path: join(base, "off"), namespace: null, enabled: false },
    ]);
  });
  it("drops invalid namespaces and duplicate roots with diagnostics, and caps the list", () => {
    const state = join(base, "s-edge"); mkdirSync(join(state, "ok"), { recursive: true });
    const many = Array.from({ length: MAX_EXTRA_SKILL_ROOTS + 2 }, () => ({ path: "ok" }));
    configure(state, [{ path: "ok" }, { path: "bad", namespace: "Docs" }, { path: "bad2", namespace: "1x" }, { path: "ok" }, ...many]);
    const loaded = loadSkillDirectories(state);
    assert.equal(loaded.status, "ok");
    assert.deepEqual(loaded.directories.map((row) => row.path), [join(state, "ok")]);
    assert.ok(loaded.diagnostics.some((row) => row.code === "skill_directory_invalid_namespace"));
    assert.ok(loaded.diagnostics.some((row) => row.code === "skill_directory_duplicate"));
    assert.ok(loaded.diagnostics.some((row) => row.code === "skill_directories_limit"));
    // A disabled or missing root is skipped at root level; only diagnostics surface.
    assert.deepEqual(extraSkillRoots(state).filter((root) => root.base).map((root) => root.base), [join(state, "ok")]);
  });
  it("a broken document is corrupt with a diagnostic and never a throw", () => {
    const state = join(base, "s-corrupt"); mkdirSync(state);
    const path = join(state, "skill-directories.json");
    for (const text of ["{not json", "{}", JSON.stringify({ schemaVersion: 2, directories: [] }), JSON.stringify({ schemaVersion: 1, directories: [], extra: 1 }), JSON.stringify({ schemaVersion: 1 })]) {
      writeFileSync(path, text);
      const loaded = loadSkillDirectories(state);
      assert.equal(loaded.status, "corrupt", text);
      assert.deepEqual(loaded.directories, []);
      assert.equal(loaded.diagnostics.length, 1);
      assert.deepEqual(extraSkillRoots(state).map((root) => root.base), [""]);
    }
  });
  it("a linked document or root is refused", { skip: process.platform === "win32" }, () => {
    const state = join(base, "s-link"); mkdirSync(join(base, "target"), { recursive: true }); mkdirSync(state);
    symlinkSync(join(base, "target"), join(state, "skill-directories.json"));
    assert.equal(loadSkillDirectories(state).status, "corrupt");
    symlinkSync(join(base, "target"), join(base, "linked-root"));
    mkdirSync(join(base, "s-link2"));
    configure(join(base, "s-link2"), [{ path: "../linked-root" }]);
    const roots = extraSkillRoots(join(base, "s-link2"));
    assert.deepEqual(roots.map((root) => root.base), [""]);
    assert.equal(roots[0]!.diagnostics[0]!.code, "skill_root_symlink");
  });
});

describe("F07.04 extra-root discovery, namespacing and merge", () => {
  it("lists extra skills with their namespace, id and attachments, and loads them by namespaced name", () => {
    const state = join(base, "d1"), root = join(base, "w1"), extra = join(base, "x1");
    mkdirSync(state); mkdirSync(root);
    const dir = join(extra, "pdf-tools"); skill(dir, "pdf-tools", "Extra workflow.");
    writeFileSync(join(dir, "reference.txt"), "refs");
    configure(state, [{ path: "../x1", namespace: "docs" }]);
    const rows = listAll(state, root).skills;
    const row = rows.find((item) => item.name === "docs:pdf-tools")!;
    assert.ok(row);
    assert.equal(row.source, "extra"); assert.equal(row.scope, "extra"); assert.equal(row.namespace, "docs");
    assert.equal(row.id, "file:extra:docs:pdf-tools");
    assert.equal(row.rootPath, extra); assert.equal(row.shadowed, false);
    assert.deepEqual(row.attachments, [{ name: "reference.txt", bytes: 4 }]);
    assert.equal(namespacedName("docs", "pdf-tools"), "docs:pdf-tools");
    const loaded = loadSkill(state, root, "docs:pdf-tools");
    assert.ok(loaded.ok && loaded.source === "extra" && loaded.content.includes("Extra workflow."));
    assert.ok(loaded.ok && loaded.content.includes(`Base directory for this skill: ${dir}`));
  });
  it("never silently overrides: a same-name loser stays listed as shadowed, the namespaced copy stays reachable", () => {
    const state = join(base, "d2"), root = join(base, "w2"), plain = join(base, "x2"), spaced = join(base, "x3");
    mkdirSync(state); mkdirSync(root);
    skill(join(state, "skills", "pdf"), "pdf", "User pdf.");
    skill(join(plain, "pdf"), "pdf", "Plain extra pdf.");
    skill(join(spaced, "pdf"), "pdf", "Namespaced extra pdf.");
    configure(state, [{ path: "../x2" }, { path: "../x3", namespace: "team" }]);
    const rows = listAll(state, root).skills;
    const winner = rows.find((item) => item.name === "pdf" && !item.shadowed)!;
    assert.equal(winner.source, "user");
    const loser = rows.find((item) => item.name === "pdf" && item.source === "extra")!;
    assert.equal(loser.shadowed, true); assert.equal(loser.shadowedBy, "user");
    const namespaced = rows.find((item) => item.name === "team:pdf")!;
    assert.equal(namespaced.shadowed, false);
    const extra = loadSkill(state, root, "team:pdf");
    assert.ok(extra.ok && extra.content.includes("Namespaced extra pdf."));
    const user = loadSkill(state, root, "pdf");
    assert.ok(user.ok && user.content.includes("User pdf."));
  });
  it("project skills outrank extra roots and extra roots outrank the bundled ones, which stay available", () => {
    const state = join(base, "d3"), root = join(base, "w3"), extra = join(base, "x4");
    mkdirSync(state); mkdirSync(root);
    skill(join(root, ".xueness", "skills", "docx"), "docx", "Project docx.");
    skill(join(extra, "docx"), "docx", "Extra docx.");
    skill(join(extra, "pdf"), "pdf", "Extra pdf.");
    configure(state, [{ path: "../x4" }]);
    const rows = listAll(state, root, true, BUNDLED_SKILLS_DIR).skills;
    const docx = rows.filter((item) => item.name === "docx");
    assert.equal(docx.find((item) => !item.shadowed)!.source, "project");
    assert.equal(docx.find((item) => item.source === "extra")!.shadowedBy, "project");
    assert.equal(docx.find((item) => item.source === "bundled")!.shadowedBy, "project");
    assert.equal(rows.find((item) => item.name === "pdf" && !item.shadowed)!.source, "extra");
    const bundled = rows.filter((item) => item.source === "bundled" && !item.shadowed);
    assert.equal(bundled.length, 10, "the other bundled skills still list beside the extra roots");
    assert.ok(loadSkill(state, root, "pptx", BUNDLED_SKILLS_DIR).ok, "an untouched bundled skill still loads");
  });
  it("missing or unreadable extra roots and a corrupt document surface as diagnostics, never a failed listing", () => {
    const state = join(base, "d4"), root = join(base, "w4");
    mkdirSync(state); mkdirSync(root);
    writeFileSync(join(state, "skill-directories.json"), "{broken");
    const found = listAll(state, root);
    assert.deepEqual(found.skills, []);
    assert.equal(found.diagnostics[0]!.code, "skill_directories_invalid_json");
    configure(state, [{ path: "../missing-root" }]);
    const missing = listAll(state, root);
    assert.deepEqual(missing.skills, []);
    assert.equal(missing.diagnostics[0]!.code, "skill_directory_unreadable");
  });
});
