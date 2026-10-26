/** H10.01-02 genome mutate + skill diff. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createGenome, mutateGenome, mulberry32, genomeLineageOf } from "../src/optimizer/genome.ts";
import { applySkillDiff, createMemorySkillStore } from "../src/optimizer/skill-diff.ts";

describe("genome mutate (H10.01)", () => {
  it("mutates deterministically under a seeded RNG", () => {
    const base = createGenome({ id: "g0", prompt: "Solve tasks.", paths: ["skills/a.md"] });
    const a = mutateGenome(base, { rng: mulberry32(42), idFactory: () => "g1" });
    const b = mutateGenome(base, { rng: mulberry32(42), idFactory: () => "g1" });
    assert.deepEqual(a, b);
    assert.equal(genomeLineageOf(a).parentId, "g0");
    assert.equal(genomeLineageOf(a).generation, 1);
    assert.notEqual(a.prompt, base.prompt);
  });
});

describe("skill diff (H10.02)", () => {
  it("applies and reverts without drift", () => {
    const store = createMemorySkillStore({ "skills/a.md": "old" });
    const applied = applySkillDiff(store, "/sandbox", {
      id: "d1",
      files: [{ path: "skills/a.md", content: "new" }, { path: "skills/b.md", content: "extra" }],
    });
    assert.equal(store.read("skills/a.md"), "new");
    assert.equal(store.read("skills/b.md"), "extra");
    applied.revert();
    assert.equal(store.read("skills/a.md"), "old");
    assert.equal(store.read("skills/b.md"), null);
  });

  it("rejects paths that escape the sandbox", () => {
    const store = createMemorySkillStore();
    assert.throws(() => applySkillDiff(store, "/sandbox", {
      id: "x",
      files: [{ path: "../etc/passwd", content: "nope" }],
    }), /escapes sandbox/);
  });
});
