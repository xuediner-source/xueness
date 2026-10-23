/**
 * ZCode skills cases, ported from ZCode v3.15.1 `core/tests/context-builder.test.ts`
 * ("renders skills as a separate meta user system reminder", the available-skills
 * metadata cases) and `core/tests/skill-tool.test.ts` (content wrapper, legacy
 * `name` field, byte cap), plus the Xueness Skill ⇄ `skill_read` mapping.
 */
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { buildContext, buildPromptView, contractFor, type EnvInfo } from "@xueness/agent";
import { listAll, listedSkills, loadSkill, MAX_SKILL_BYTES, skillTools, validateSkill, zcodeSkillsListing } from "../src/index.ts";
import { skillFixture } from "./fixture.ts";

const env: EnvInfo = { cwd: "/workspace", platform: "linux", shell: "bash", osVersion: "Linux 6.6.0" };
const demo = { name: "demo-skill", description: "Use this for demos", path: "/workspace/.zcode/skills/demo/SKILL.md" };

describe("ZCode skills listing", () => {
  it("renders skills as a separate meta user system reminder", () => {
    const result = buildContext({ envInfo: env, currentDate: "2026-05-04", guidanceToolNames: ["Skill"], skillsListing: zcodeSkillsListing([demo]) });
    assert.deepEqual(result.systemMessages.map((message) => message.role), ["system", "system", "system"]);
    assert.deepEqual(result.metaUserAttachments.map((attachment) => attachment.source), ["skills_listing", "context_prefix"]);
    assert.ok(!result.systemMessages[0]!.content.includes("demo-skill"));
    assert.ok(result.systemMessages[2]!.content.includes("# Session-specific guidance"));
    assert.ok(result.systemMessages[2]!.content.includes("When the user types `/<skill-name>`"));
    const listing = result.metaUserAttachments[0]!.content;
    assert.ok(!listing.includes("<system-reminder>"));
    assert.ok(listing.includes("The following skills are available"));
    assert.ok(listing.includes("demo-skill"));
    assert.ok(result.metaUserAttachments[1]!.content.includes("# currentDate"));
  });
  it("lists nothing, and gives no slash guidance, without the Skill tool", () => {
    const result = buildContext({ envInfo: env, currentDate: "2026-05-04", guidanceToolNames: ["Read"], skillsListing: zcodeSkillsListing([demo]) });
    assert.deepEqual(result.metaUserAttachments.map((attachment) => attachment.source), ["context_prefix"]);
    assert.ok(!result.systemMessages.some((message) => message.content.includes("`/<skill-name>`")));
  });
  it("formats the available-skills metadata like ZCode", () => {
    const section = zcodeSkillsListing([demo])!;
    assert.equal(section, "The following skills are available for use with the Skill tool:\n\n- demo-skill: Use this for demos (file: /workspace/.zcode/skills/demo/SKILL.md)");
    assert.ok(!section.includes("`/<skill-name>`")); assert.ok(!section.includes("Do not guess missing skill names."));
    const long = zcodeSkillsListing([{ ...demo, description: "d".repeat(300) }])!;
    assert.ok(long.includes(`- demo-skill: ${"d".repeat(249)}... (file:`));
    const many = Array.from({ length: 200 }, (_, i) => ({ name: `s${String(i).padStart(3, "0")}`, description: "x".repeat(200), path: `/p/${i}/SKILL.md` }));
    const names = zcodeSkillsListing(many)!;
    assert.ok(names.includes("- s000 (file: /p/0/SKILL.md)") && !names.includes("xxx"), "over budget: names only");
    assert.equal(zcodeSkillsListing([]), null);
    assert.deepEqual(zcodeSkillsListing([{ ...demo, name: "b" }, { ...demo, name: "a" }])!.split("\n").slice(2).map((line) => line.slice(2, 3)), ["a", "b"]);
  });
  it("the prompt view turns the request-only listing message into the reminder before the context prefix", () => {
    const messages = buildPromptView([{ role: "system", content: "s" }, { role: "user", content: zcodeSkillsListing([demo]), _context_source: "skills_listing" }, { role: "user", content: "hi" }],
      { envInfo: env, currentDate: "2026-05-04", guidanceToolNames: ["Skill", "Read"] })!;
    const meta = messages.filter((message) => message._meta_source);
    assert.deepEqual(meta.map((message) => message._meta_source), ["skills_listing", "context_prefix"]);
    assert.match(String(meta[0]!.content), /^<system-reminder>\nThe following skills are available/);
    assert.equal(messages.at(-1)!.content, "hi");
    assert.ok(!messages.some((message) => message._context_source));
  });
});

describe("ZCode Skill tool", () => {
  it("loads skill content in the ZCode wrapper, expanding the skill directory variables", () => {
    const { base, root, state } = skillFixture();
    try {
      const loaded = loadSkill(state, root, "alpha");
      assert.ok(loaded.ok);
      const dir = join(root, ".xueness", "skills", "alpha");
      assert.equal(loaded.content, [`<skill_content name="alpha">`, "# Skill: alpha", `Use ${dir}/x.sh.`, "Second line.", `Base directory for this skill: ${dir}`,
        "Relative paths in this skill are relative to this base directory.", "</skill_content>"].join("\n"));
      assert.ok(loadSkill(state, root, "file:project:alpha").ok, "catalog ids still load");
      assert.deepEqual(loadSkill(state, root, "file:user:beta"), { ok: false, error: "Unknown skill: file:user:beta" }, "a shadowed row is not loadable");
      assert.deepEqual(loadSkill(state, root, "nope"), { ok: false, error: "Unknown skill: nope" });
      const stored = loadSkill(state, root, "Stored One");
      assert.ok(stored.ok && stored.content.includes("stored body") && !stored.content.includes("Base directory"));
      const project = join(root, ".xueness", "skills", "huge");
      mkdirSync(project, { recursive: true });
      writeFileSync(join(project, "SKILL.md"), `---\nname: huge\ndescription: big body\n---\n${"é".repeat(120_000)}\n\${CLAUDE_SKILL_DIR}`);
      const huge = loadSkill(state, root, "huge");
      assert.ok(huge.ok && huge.truncated && huge.content.includes("[Skill content truncated]"));
      assert.ok(Buffer.byteLength(huge.content) < MAX_SKILL_BYTES + 4096 && !huge.content.includes("\ufffd"));
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
  it("maps ZCode Skill input, including the legacy name field and a leading slash, to skill_read", () => {
    const contract = contractFor("Skill")!;
    assert.equal(contract.internal, "skill_read");
    const context = { root: "/w", accepts: () => true };
    assert.deepEqual(contract.toInternal({ skill: "demo-skill", args: "x" }, context), { id: "demo-skill" });
    assert.deepEqual(contract.toInternal({ name: "demo-skill" }, context), { id: "demo-skill" });
    assert.deepEqual(contract.toInternal({ skill: "/demo-skill" }, context), { id: "demo-skill" });
    assert.ok("error" in contract.toInternal({ skill: " " }, context));
    assert.deepEqual(contract.toModel({ id: "demo-skill" }, context), { skill: "demo-skill" });
    assert.deepEqual(contract.schema, { type: "object", properties: { skill: { type: "string", description: "The name of a skill from the available-skills list. Do not guess names." }, args: { type: "string", description: "Optional arguments for the skill" } }, required: ["skill"], additionalProperties: false });
  });
  it("tools answer from the run's workspace and state, and validate without executing", async () => {
    const { base, root, state } = skillFixture();
    try {
      const [read, validate] = skillTools({ stateDir: state, root: () => root });
      const env = { cwd: root, roots: [root], artifactsDir: base } as never;
      const ok = await read!.run({ id: "gamma" }, env);
      assert.equal(ok.ok, true); assert.deepEqual(ok.data, { id: "gamma", name: "Different", source: "resource", truncated: false });
      const missing = await read!.run({ id: "zzz" }, env);
      assert.equal(missing.ok, false); assert.equal(missing.error?.code, "skill_not_found");
      assert.equal(read!.subject?.({ id: "alpha" }), "alpha");
      const valid = await validate!.run({ content: "---\nname: ok\ndescription: fine\n---\nbody" }, env);
      assert.equal(valid.ok, true); assert.deepEqual(JSON.parse(valid.output), validateSkill("---\nname: ok\ndescription: fine\n---\nbody"));
      const invalid = await validate!.run({ content: "---\nname: ok\n---\nbody" }, env);
      assert.equal(invalid.ok, false);
      assert.equal((await validate!.run({ content: "x".repeat(300 * 1024) }, env)).error?.code, "invalid_input");
      assert.deepEqual(listedSkills(listAll(state, root).skills).map((skill) => skill.name).sort(), ["Different", "Dot skill", "Stored One", "alpha", "beta", "folded", "literal"]);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
});
