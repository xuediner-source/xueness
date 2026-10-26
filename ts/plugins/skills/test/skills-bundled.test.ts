/**
 * The shipped documentation, visualization, and Seagull research skills:
 * every SKILL.md passes discovery and validation, they rank below every other
 * source (a user or project skill of the same name shadows them), the Skill
 * result names their base directory, and without the bundled root (the Python
 * parity path) nothing changes.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { BUNDLED_SKILLS_DIR, listAll, listedSkills, loadSkill, MAX_SKILL_BYTES, setFileSkillEnabled, validateSkill, zcodeSkillsListing } from "../src/index.ts";

const base = mkdtempSync(join(tmpdir(), "xue-skills-bundled-"));
after(() => rmSync(base, { recursive: true, force: true }));
const NAMES = ["docx", "pdf", "pptx", "xlsx"];
const SEAGULL_NAMES = ["seagull-game-security", "seagull-lab", "seagull-license-security", "seagull-memory", "seagull-pentest", "seagull-reverse"];
const ALL = [...NAMES, "visualize", ...SEAGULL_NAMES, "ask-user-question"].sort();

describe("bundled skills", () => {
  it("bundled skills are discovered and valid; the document skills are Apache-2.0 and free of ZCode-only syntax", () => {
    const state = join(base, "s1"); mkdirSync(state);
    const found = listAll(state, null, true, BUNDLED_SKILLS_DIR);
    assert.deepEqual(found.diagnostics, []);
    assert.deepEqual(found.skills.map((row) => [row.name, row.source, row.scope, row.shadowed]).sort(), ALL.map((name) => [name, "bundled", "bundled", false]));
    const visualize = readFileSync(join(BUNDLED_SKILLS_DIR, "visualize", "SKILL.md"), "utf8");
    assert.equal(validateSkill(visualize).ok, true);
    assert.ok(Buffer.byteLength(visualize) < MAX_SKILL_BYTES, "visualize loads untruncated");
    assert.match(readFileSync(join(BUNDLED_SKILLS_DIR, "visualize", "LICENSE.md"), "utf8"), /Apache-2\.0/u);
    for (const name of NAMES) {
      const text = readFileSync(join(BUNDLED_SKILLS_DIR, name, "SKILL.md"), "utf8");
      assert.equal(validateSkill(text).ok, true, name);
      assert.ok(Buffer.byteLength(text) < MAX_SKILL_BYTES, `${name} loads untruncated`);
      assert.match(text, /^license: Apache-2\.0/mu);
      assert.equal(/zcode/iu.test(text), false, `${name} has no ZCode-only citation syntax`);
      assert.match(readFileSync(join(BUNDLED_SKILLS_DIR, name, "LICENSE.txt"), "utf8"), /Apache License, Version 2\.0/u);
    }
    for (const name of [...SEAGULL_NAMES, "ask-user-question"]) {
      const text = readFileSync(join(BUNDLED_SKILLS_DIR, name, "SKILL.md"), "utf8");
      assert.equal(validateSkill(text).ok, true, name);
      assert.equal(loadSkill(state, null, name, BUNDLED_SKILLS_DIR).ok, false, `${name} awaits the user's enable choice`);
      setFileSkillEnabled(state, `file:bundled:${name}`, true);
      const loaded = loadSkill(state, null, name, BUNDLED_SKILLS_DIR);
      assert.ok(loaded.ok && loaded.source === "bundled" && !loaded.truncated, `${name} loads untruncated as bundled`);
      assert.ok(loaded.ok && loaded.content.includes(`Base directory for this skill: ${join(BUNDLED_SKILLS_DIR, name)}`), `${name} includes its base directory`);
    }
    assert.ok(zcodeSkillsListing(listedSkills(found.skills))!.includes("- docx:"));
  });

  it("rank below user and project skills and load with their base directory", () => {
    const state = join(base, "s2"), root = join(base, "w2");
    mkdirSync(join(state, "skills", "pdf"), { recursive: true }); mkdirSync(join(root, ".xueness", "skills", "xlsx"), { recursive: true });
    writeFileSync(join(state, "skills", "pdf", "SKILL.md"), "---\nname: pdf\ndescription: my own pdf workflow\n---\nMine.\n");
    writeFileSync(join(root, ".xueness", "skills", "xlsx", "SKILL.md"), "---\nname: xlsx\ndescription: project sheets\n---\nProject.\n");
    const rows = listAll(state, root, true, BUNDLED_SKILLS_DIR).skills;
    const winner = (name: string) => rows.find((row) => row.name === name && !row.shadowed)!;
    assert.equal(winner("pdf").source, "user");
    assert.equal(winner("xlsx").source, "project");
    assert.equal(rows.find((row) => row.name === "pdf" && row.source === "bundled")!.shadowedBy, "user");
    const docx = loadSkill(state, root, "docx", BUNDLED_SKILLS_DIR);
    assert.ok(docx.ok && docx.source === "bundled" && !docx.truncated);
    assert.ok(docx.ok && docx.content.includes(`Base directory for this skill: ${join(BUNDLED_SKILLS_DIR, "docx")}`));
    const mine = loadSkill(state, root, "pdf", BUNDLED_SKILLS_DIR);
    assert.ok(mine.ok && mine.content.includes("Mine."));
  });

  it("are absent without the bundled root, as in Python", () => {
    const state = join(base, "s3"); mkdirSync(state);
    assert.deepEqual(listAll(state, null).skills, []);
    assert.deepEqual(loadSkill(state, null, "docx"), { ok: false, error: "Unknown skill: docx" });
  });
});
