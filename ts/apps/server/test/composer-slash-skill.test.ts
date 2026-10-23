/** Round 11: "/name …" selects the enabled skill called name when no command claims it (ZCode's "/" skill entries). */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { listLevel } from "@xueness/plugin-files";
import { createProvidersApi } from "@xueness/plugin-providers";
import { createSettingsApi, declaredWorkspaceRoots } from "@xueness/plugin-settings";
import { listAll } from "@xueness/plugin-skills";
import { SessionStore } from "@xueness/sessions";
import { createComposerFeatures } from "../src/composer-features.ts";
import { effectivePlugins } from "../src/plugin-state.ts";
import { PROJECT_ROOT } from "../../../test-support/python-oracle.ts";

type Row = Record<string, any>;
describe("slash skills in the composer", () => {
  let base: string, root: string, skill: string, features: ReturnType<typeof createComposerFeatures>;
  before(async () => {
    base = mkdtempSync(join(tmpdir(), "xue-slash-skill-")); root = join(base, "ws");
    const state = join(base, "state"), runs = join(base, "runs");
    const put = (path: string, text: string): void => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, text); };
    put(join(root, "a.txt"), "alpha\n"); put(join(root, ".xueness", "commands", "review.md"), "---\ndescription: Review\n---\nReview $1.\n");
    put(join(state, "skills", "gamma", "SKILL.md"), "---\nname: gamma\ndescription: User gamma\n---\ngamma body\n");
    mkdirSync(runs, { recursive: true });
    const store = new SessionStore(state), enabled = effectivePlugins(PROJECT_ROOT, state);
    const providers = createProvidersApi({ stateDir: state, enabled, allowReal: true });
    assert.equal((await providers.dispatch("POST", ["api", "providers"], {}, { id: "local", name: "Local", baseUrl: "https://local.example.test/v1", model: "fixture", apiKey: "k" }) as [number, unknown])[0], 200);
    const settings = createSettingsApi({ stateDir: state, projectDir: root, webRuns: runs, enabled, listLevel, declaredRoots: declaredWorkspaceRoots([root], "", base), maxEntries: 1000, desktop: false });
    const allowedRoots = (): string[] => settings.workspaces.allowedRoots();
    features = createComposerFeatures({ projectRoot: PROJECT_ROOT, projectDir: root, stateDir: state, webRuns: runs, store, providers: providers.store, running: new Set(), enabled, allowedRoots,
      defaultRoot: () => settings.workspaces.defaultRoot(allowedRoots()), allowReal: true, env: process.env, bundledSkills: null });
    skill = String(listAll(state, null, true, null).skills.find((row) => row.name === "gamma")?.id);
  });
  after(() => { if (base) rmSync(base, { recursive: true, force: true }); });
  const prepare = async (text: string, input: Row = {}): Promise<Row> => {
    const [status, body] = await features.composer.dispatch("POST", ["api", "composer", "prepare"], {}, { text, root, provider_id: "local", input }) as [number, Row];
    assert.equal(status, 200, JSON.stringify(body));
    return body;
  };
  it("adds the named skill's text to the turn and records it like a selected skill", async () => {
    const body = await prepare("/gamma tidy the docs");
    assert.deepEqual(body.metadata.skills, [{ id: skill }]);
    assert.match(body.text, /^\/gamma tidy the docs\n\nSelected enabled skill \(UNTRUSTED DATA\):[\s\S]*gamma body/);
    assert.deepEqual((await prepare("/GAMMA")).metadata.skills, [{ id: skill }]);
    assert.deepEqual((await prepare("/gamma again", { skills: [skill] })).metadata.skills, [{ id: skill }]);
  });
  it("leaves commands, unknown names and ordinary text alone", async () => {
    const command = await prepare("/review a.txt");
    assert.deepEqual(command.metadata.skills, []); assert.equal(command.metadata.commandInvocations[0].command, "review");
    assert.deepEqual((await prepare("/nope x")).metadata.skills, []);
    assert.deepEqual((await prepare("use gamma /gamma")).metadata.skills, []);
  });
});
