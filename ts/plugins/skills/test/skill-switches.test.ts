import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { mkdtempSync } from "../../../test-support/canonical-temp.ts";
import { BUNDLED_SKILLS_DIR, INITIAL_SKILL_NAMES, createSkillsHttp, listAll, listedSkills, loadSkill, pythonCatalog, readSkill, setFileSkillEnabled, validateSkill } from "../src/index.ts";

function fixture() {
  const state = mkdtempSync(join(tmpdir(), "xueness-skill-switch-"));
  const api = createSkillsHttp({ stateDir: state, projectDir: state, webRuns: state, allowedRoots: () => [state], enabled: () => true });
  return { state, api, close() { rmSync(state, { recursive: true, force: true }); } };
}

it("shows all seven initial skills while excluding disabled skills from both model catalogs and reads", () => {
  const f = fixture();
  try {
    const reply = f.api.dispatch("GET", ["api", "resources", "skills", "files"], {}, {});
    const rows = (reply?.[1] as { skills: { name: string; source: string; enabled: boolean }[] }).skills;
    const discovered = listAll(f.state, null, true, BUNDLED_SKILLS_DIR).skills;
    const catalog = pythonCatalog(discovered), standard = listedSkills(discovered);
    for (const name of INITIAL_SKILL_NAMES) {
      const row = rows.find(row => row.name === name)!; assert(row); assert.equal(row.source, "bundled"); assert.equal(row.enabled, false);
      assert.equal(catalog.includes(name), false); assert.equal(standard.some(row => row.name === name), false);
      assert.equal(loadSkill(f.state, null, name, BUNDLED_SKILLS_DIR).ok, false);
      assert.equal(readSkill(f.state, `file:bundled:${name}`, null, BUNDLED_SKILLS_DIR).ok, false);
      assert.equal(validateSkill(readFileSync(join(BUNDLED_SKILLS_DIR, name, "SKILL.md"), "utf8")).ok, true);
    }
  } finally { f.close(); }
});

it("persists each user's choice and refuses model reads after the skill is switched off", () => {
  const f = fixture();
  try {
    const path = ["api", "resources", "skills", "files", "state"], id = "file:bundled:ask-user-question";
    assert.equal(f.api.dispatch("POST", path, {}, { id, enabled: true })?.[0], 200);
    assert.equal(loadSkill(f.state, null, "ask-user-question", BUNDLED_SKILLS_DIR).ok, true);
    const restored = createSkillsHttp({ stateDir: f.state, projectDir: f.state, webRuns: f.state, allowedRoots: () => [], enabled: () => true });
    assert.equal(restored.dispatch("POST", path, {}, { id, enabled: false })?.[0], 200);
    assert.equal(loadSkill(f.state, null, id, BUNDLED_SKILLS_DIR).ok, false);
    assert.equal(JSON.parse(readFileSync(join(f.state, "skill-state.json"), "utf8")).enabled[id], false);
    assert.equal(f.api.dispatch("POST", path, {}, { id: "file:bundled:unknown", enabled: true })?.[0], 404);
    assert.equal(f.api.dispatch("POST", path, {}, { id, enabled: 1 })?.[0], 400);
  } finally { f.close(); }
});

it("also gates imported directory skills, fails closed on corrupt choices and leaves shipped files unchanged", () => {
  const f = fixture();
  try {
    mkdirSync(join(f.state, "skills/custom"), { recursive: true }); writeFileSync(join(f.state, "skills/custom/SKILL.md"), "---\nname: custom\ndescription: A user skill.\n---\nUse me.\n");
    assert.equal(loadSkill(f.state, null, "custom").ok, true);
    setFileSkillEnabled(f.state, "file:user:custom", false); assert.equal(loadSkill(f.state, null, "custom").ok, false);
    const original = readFileSync(join(BUNDLED_SKILLS_DIR, "ask-user-question/SKILL.md"));
    setFileSkillEnabled(f.state, "file:bundled:ask-user-question", true);
    assert.deepEqual(readFileSync(join(BUNDLED_SKILLS_DIR, "ask-user-question/SKILL.md")), original);
    writeFileSync(join(f.state, "skill-state.json"), "{broken"); assert.equal(loadSkill(f.state, null, "ask-user-question", BUNDLED_SKILLS_DIR).ok, false);
    assert.throws(() => setFileSkillEnabled(f.state, "file:bundled:ask-user-question", true), /invalid/);
  } finally { f.close(); }
});
