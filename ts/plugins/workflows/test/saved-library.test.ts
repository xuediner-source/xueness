import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { isDict, pyJsonLoads } from "@xueness/contracts";
import {
  latestRunPlan, MAX_DESCRIPTION, NAME, SavedWorkflowLibrary, sourcePlan, templatePlanDigest, validateName,
} from "../src/saved-library.ts";
import { WorkflowStore } from "../src/store.ts";

const NAME_MESSAGE = "saved workflow name must be 1..64 characters of letters, digits, dot, dash or underscore, starting with a letter or digit";

/** A minimal valid plan: one command node, no dependencies. */
function plan(name = "Fixture"): Record<string, unknown> {
  return { name, nodes: [{ id: "one", kind: "command", argv: ["echo", "hi"] }], concurrency: 1 };
}

function fixture(): { state: string; root: string; library: SavedWorkflowLibrary } {
  const base = mkdtempSync(join(tmpdir(), "xueness-saved-"));
  const state = join(base, "state"), root = join(base, "workspace");
  mkdirSync(root, { recursive: true });
  return { state, root, library: new SavedWorkflowLibrary(state) };
}

describe("saved workflow names", () => {
  it("accepts ordinary names and rejects the reserved device bases", () => {
    assert.equal(validateName("nightly-build"), "nightly-build");
    assert.equal(validateName("a"), "a");
    assert.equal(validateName("A_1.b-c"), "A_1.b-c");
    assert.equal(validateName("x".repeat(64)).length, 64);
    assert.equal(NAME.test("x".repeat(64)), true);
    for (const reserved of ["con", "PRN", "aux", "nul", "com1", "COM9", "lpt1", "LPT9", "con.txt", "Nul.json"]) {
      assert.throws(() => validateName(reserved), { name: "ValueError", message: NAME_MESSAGE }, reserved);
    }
  });

  it("rejects names that are not a single safe path component", () => {
    for (const bad of ["", ".hidden", "-lead", "_lead", "x".repeat(65), "a/b", "a\\b", "a b", "a\n", "café", "../x", "a..b/c"]) {
      assert.throws(() => validateName(bad), { name: "ValueError", message: NAME_MESSAGE }, JSON.stringify(bad));
    }
    for (const notString of [null, 1, true, ["a"], { name: "a" }]) {
      assert.throws(() => validateName(notString), { name: "ValueError", message: NAME_MESSAGE });
    }
  });
});

describe("saved workflow library", () => {
  it("saves, reloads and projects one template with its description and times", () => {
    const { state, root, library } = fixture();
    try {
      const saved = library.save(plan("Nightly"), "nightly", root, { description: "  build and test  ", source: { kind: "plan" } });
      assert.equal(saved.name, "nightly");
      assert.equal(saved.description, "build and test");
      assert.equal(saved.node_count, 1);
      assert.equal(saved.plan_name, "Nightly");
      assert.equal(saved.concurrency, 1);
      assert.equal(typeof saved.saved_at, "number");
      assert.equal(typeof saved.updated_at, "number");
      assert.match(String(saved.plan_digest), /^[a-f0-9]{64}$/);

      // One JSON file directly inside `<state>/workflows/saved`, exactly as Python writes it.
      const file = join(state, "workflows", "saved", "nightly.json");
      const onDisk = pyJsonLoads(readFileSync(file, "utf8")) as Record<string, unknown>;
      assert.equal(onDisk.name, "nightly");
      assert.equal(onDisk.description, "build and test");
      assert.deepEqual(onDisk.source, { kind: "plan" });
      assert.deepEqual(onDisk.plan, library.load("nightly").plan);

      // `save` returns the listing projection, so the plan only comes back from `load`.
      const loaded = library.load("nightly");
      assert.equal(loaded.description, "build and test");
      assert.deepEqual(loaded.plan, onDisk.plan);
      assert.equal(loaded.plan_digest, saved.plan_digest);
      assert.deepEqual(loaded.source, { kind: "plan" });
      assert.equal(loaded.saved_at, saved.saved_at);
    } finally { rmSync(join(state, ".."), { recursive: true, force: true }); }
  });

  it("defaults the description to an empty string and bounds it", () => {
    const { state, root, library } = fixture();
    try {
      assert.equal(library.save(plan(), "plain", root).description, "");
      assert.equal(library.save(plan(), "nulled", root, { description: null }).description, "");
      assert.equal(String(library.save(plan(), "long", root, { description: "d".repeat(MAX_DESCRIPTION) }).description).length, MAX_DESCRIPTION);
      assert.throws(() => library.save(plan(), "toolong", root, { description: "d".repeat(MAX_DESCRIPTION + 1) }),
        { name: "ValueError", message: `description must be a string up to ${MAX_DESCRIPTION} characters` });
      assert.throws(() => library.save(plan(), "notstring", root, { description: 5 }),
        { name: "ValueError", message: `description must be a string up to ${MAX_DESCRIPTION} characters` });
    } finally { rmSync(join(state, ".."), { recursive: true, force: true }); }
  });

  it("refuses to replace an existing name unless overwrite is an explicit true", () => {
    const { state, root, library } = fixture();
    try {
      library.save(plan("First"), "tpl", root, { description: "first" });
      const message = "saved workflow 'tpl' already exists; pass overwrite to replace it";
      assert.throws(() => library.save(plan("Second"), "tpl", root), { name: "ValueError", message });
      assert.throws(() => library.save(plan("Second"), "tpl", root, { overwrite: false }), { name: "ValueError", message });
      // Python checks `type(overwrite) is not bool`, so a truthy non-boolean is refused too.
      for (const overwrite of [1, "true", null, 0]) {
        assert.throws(() => library.save(plan("Second"), "tpl", root, { overwrite }),
          { name: "ValueError", message: "overwrite must be a boolean" });
      }
      assert.equal(library.load("tpl").description, "first");

      const replaced = library.save(plan("Second"), "tpl", root, { description: "second", overwrite: true });
      assert.equal(replaced.description, "second");
      assert.equal(replaced.plan_name, "Second");
      assert.equal(library.load("tpl").plan_name === undefined, true);
      assert.equal((library.load("tpl").plan as Record<string, unknown>).name, "Second");
      assert.equal(library.list().length, 1);
    } finally { rmSync(join(state, ".."), { recursive: true, force: true }); }
  });

  it("reports an unknown name and a damaged record with Python's messages", () => {
    const { state, root, library } = fixture();
    try {
      assert.throws(() => library.load("absent"), { name: "ValueError", message: "unknown saved workflow: absent" });
      library.save(plan(), "good", root);
      writeFileSync(join(state, "workflows", "saved", "good.json"), '{"name": "good"}');
      assert.throws(() => library.load("good"), { name: "ValueError", message: "saved workflow record is damaged: good" });
      writeFileSync(join(state, "workflows", "saved", "good.json"), "[]");
      assert.throws(() => library.load("good"), { name: "ValueError", message: "saved workflow record is damaged: good" });
      // A malformed name never reaches the file system.
      assert.throws(() => library.load("../etc"), { name: "ValueError", message: NAME_MESSAGE });
    } finally { rmSync(join(state, ".."), { recursive: true, force: true }); }
  });

  it("lists newest first and skips corrupt or unreadable files", () => {
    const { state, root, library } = fixture();
    try {
      const directory = join(state, "workflows", "saved");
      library.save(plan(), "alpha", root);
      const beta = library.save(plan(), "beta", root);
      const gamma = library.save(plan(), "gamma", root);
      // Force distinct, ordered timestamps: Python sorts on `updated_at`.
      const stamp = (name: string, at: number): void => {
        const file = join(directory, name + ".json");
        const record = pyJsonLoads(readFileSync(file, "utf8")) as Record<string, unknown>;
        record.updated_at = at;
        writeFileSync(file, JSON.stringify(record));
      };
      stamp("alpha", 100.5);
      stamp("beta", 300.5);
      stamp("gamma", 200.5);
      writeFileSync(join(directory, "broken.json"), "{not json");
      writeFileSync(join(directory, "notes.txt"), "ignored");
      writeFileSync(join(directory, ".hidden.json"), "{}");
      writeFileSync(join(directory, "con.json"), "{}");

      const rows = library.list();
      assert.deepEqual(rows.map((row) => row.name), ["beta", "gamma", "alpha"]);
      assert.equal(rows[0]?.updated_at, 300.5);
      assert.equal(rows[0]?.node_count, 1);
      assert.equal(rows[0]?.plan_name, "Fixture");
      assert.equal(beta.name, "beta");
    } finally { rmSync(join(state, ".."), { recursive: true, force: true }); }
  });

  it("keeps templatePlanDigest stable and independent of key order", () => {
    const digest = templatePlanDigest(plan());
    assert.match(digest, /^[a-f0-9]{64}$/);
    assert.equal(templatePlanDigest(plan()), digest);
    assert.equal(templatePlanDigest({ concurrency: 1, nodes: [{ argv: ["echo", "hi"], kind: "command", id: "one" }], name: "Fixture" }), digest);
    assert.notEqual(templatePlanDigest(plan("Other")), digest);
    assert.equal(templatePlanDigest({ ...plan(), unicode: "ünïcode ✓" }), templatePlanDigest({ unicode: "ünïcode ✓", ...plan() }));
  });
});

describe("saving a plan from an existing run", () => {
  it("records a script or plan source and reads a real run back", () => {
    const { state, root, library } = fixture();
    try {
      library.save(plan(), "from-script", root, { source: { kind: "script" } });
      assert.deepEqual(library.load("from-script").source, { kind: "script" });
      // `source` is only recorded when it is a dict.
      library.save(plan(), "no-source", root, { source: "script" as unknown as Record<string, unknown> });
      assert.equal(Object.hasOwn(library.load("no-source"), "source"), false);

      const store = new WorkflowStore(state);
      const run = store.create(plan("Run"), root);
      const saved = library.save(plan("Run"), "from-run", root, { source: { kind: "run", workflow_id: run.id } });
      assert.deepEqual(library.load("from-run").source, { kind: "run", workflow_id: run.id });
      // The digest covers the validated plan Python stores, not the raw input.
      assert.equal(saved.plan_digest, templatePlanDigest(library.load("from-run").plan as Record<string, unknown>));
      assert.notEqual(saved.plan_digest, templatePlanDigest(plan("Run")));

      const fromRun = sourcePlan(state, run.id, root);
      assert.equal((fromRun.plan as Record<string, unknown>).name, "Run");
      assert.deepEqual(fromRun.source, { kind: "run", workflow_id: run.id });

      const latest = latestRunPlan(state, root);
      assert.deepEqual(latest.source, { kind: "run", workflow_id: run.id });
      assert.equal((latest.plan as Record<string, unknown>).name, "Run");

      const other = join(state, "..", "other-workspace");
      mkdirSync(other, { recursive: true });
      assert.throws(() => sourcePlan(state, run.id, other), { name: "PermissionError", message: "workflow belongs to another workspace" });
      assert.throws(() => latestRunPlan(state, other), { name: "ValueError", message: "no workflow runs exist in this workspace yet" });
    } finally { rmSync(join(state, ".."), { recursive: true, force: true }); }
  });

  it("skips runs whose record cannot be read when looking for the latest", () => {
    const { state, root, library } = fixture();
    try {
      const store = new WorkflowStore(state);
      const older = store.create(plan("Older"), root);
      store.update(older.id, (record) => { record.updated_at = 100.5; });
      const newer = store.create(plan("Newer"), root);
      store.update(newer.id, (record) => { record.updated_at = 900.5; });
      writeFileSync(join(state, "workflows", newer.id + ".json"), "{broken");

      const latest = latestRunPlan(state, root);
      assert.deepEqual(latest.source, { kind: "run", workflow_id: older.id });
      assert.equal(isDict(latest.plan), true);
      assert.equal(library.list().length, 0);
    } finally { rmSync(join(state, ".."), { recursive: true, force: true }); }
  });
});
