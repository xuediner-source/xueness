/** H04.01/H04.02: SWE-bench JSONL task import and evaluation JSONL export. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  evaluateSweBenchRun,
  exportSweBenchEvaluations,
  importSweBenchTasks,
  summarizeSweBenchEvaluations,
  type SweBenchEvaluation,
  type SweBenchRunOutcome,
  type SweBenchTask,
} from "../src/compat/swe-bench-harness.ts";

const taskLine = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    instance_id: "astropy__astropy-12907",
    repo: "astropy/astropy",
    base_commit: "d16bfe1",
    patch: "--- a/a.py\n+++ b/a.py\n",
    test_patch: "--- a/test_a.py\n+++ b/test_a.py\n",
    problem_statement: "Modeling's separability_matrix fails.",
    hints_text: "",
    created_at: "2022-03-04T00:00:00Z",
    version: "4.3",
    environment_setup_commit: "d16bfe1",
    FAIL_TO_PASS: ["test_one", "test_two"],
    PASS_TO_PASS: ["test_keep"],
    ...overrides,
  });

const outcomeFor = (instanceId: string, testResults: Record<string, string>): SweBenchRunOutcome => ({
  instanceId,
  testResults: testResults as SweBenchRunOutcome["testResults"],
  modelPatch: "+ fix\n",
  model: "deepseek-v4.1",
});

describe("importSweBenchTasks (H04.01)", () => {
  it("imports standard JSONL patch tasks with all standard fields", () => {
    const { tasks, issues } = importSweBenchTasks(taskLine());
    assert.deepEqual(issues, []);
    assert.equal(tasks.length, 1);
    const task = tasks[0] as SweBenchTask;
    assert.equal(task.instanceId, "astropy__astropy-12907");
    assert.equal(task.repo, "astropy/astropy");
    assert.equal(task.baseCommit, "d16bfe1");
    assert.equal(task.patch, "--- a/a.py\n+++ b/a.py\n");
    assert.equal(task.testPatch, "--- a/test_a.py\n+++ b/test_a.py\n");
    assert.deepEqual(task.failToPass, ["test_one", "test_two"]);
    assert.deepEqual(task.passToPass, ["test_keep"]);
    assert.equal(task.version, "4.3");
  });

  it("keeps file order across many lines and tolerates blank lines, CRLF and a trailing newline", () => {
    const first = taskLine({ instance_id: "a__a-1" });
    const second = taskLine({ instance_id: "b__b-2" });
    const document = `${first}\r\n\r\n${second}\r\n`;
    const { tasks, issues } = importSweBenchTasks(document);
    assert.deepEqual(issues, []);
    assert.deepEqual(tasks.map((task) => task.instanceId), ["a__a-1", "b__b-2"]);
  });

  it("accepts lowercase fail_to_pass / pass_to_pass keys", () => {
    const { tasks, issues } = importSweBenchTasks(taskLine({ fail_to_pass: ["t1"], FAIL_TO_PASS: undefined, pass_to_pass: [], PASS_TO_PASS: undefined }));
    assert.deepEqual(issues, []);
    assert.deepEqual(tasks[0]?.failToPass, ["t1"]);
    assert.deepEqual(tasks[0]?.passToPass, []);
  });

  it("reports invalid JSON lines with their 1-based line number and keeps good records", () => {
    const document = `${taskLine()}\nnot json at all\n${taskLine({ instance_id: "c__c-3" })}\n`;
    const { tasks, issues } = importSweBenchTasks(document);
    assert.equal(tasks.length, 2);
    assert.equal(issues.length, 1);
    assert.equal(issues[0]?.line, 2);
    assert.match(issues[0]?.message ?? "", /invalid JSON/);
  });

  it("rejects records missing required fields", () => {
    const full = JSON.parse(taskLine()) as Record<string, unknown>;
    for (const key of ["instance_id", "repo", "base_commit", "patch"]) {
      const record: Record<string, unknown> = { ...full };
      record[key] = key === "patch" ? "" : undefined;
      const { tasks, issues } = importSweBenchTasks(JSON.stringify(record));
      assert.equal(tasks.length, 0, key);
      assert.equal(issues.length, 1, key);
      assert.match(issues[0]?.message ?? "", new RegExp(`required field ${key}`));
    }
  });

  it("rejects non-object records and reports malformed test lists without dropping the task", () => {
    const { tasks, issues } = importSweBenchTasks(`${JSON.stringify([1, 2])}\n${taskLine({ FAIL_TO_PASS: "test_one" })}\n`);
    assert.equal(tasks.length, 1);
    assert.deepEqual(tasks[0]?.failToPass, []);
    assert.equal(issues.length, 2);
    assert.match(issues[0]?.message ?? "", /must be a JSON object/);
    assert.match(issues[1]?.message ?? "", /FAIL_TO_PASS must be an array of test id strings/);
  });

  it("skips duplicate instance ids and reports the line", () => {
    const document = `${taskLine()}\n${taskLine({ repo: "other/repo" })}\n`;
    const { tasks, issues } = importSweBenchTasks(document);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]?.repo, "astropy/astropy");
    assert.equal(issues.length, 1);
    assert.equal(issues[0]?.line, 2);
  });

  it("returns empty results for an empty document", () => {
    const { tasks, issues } = importSweBenchTasks("\n \n");
    assert.deepEqual(tasks, []);
    assert.deepEqual(issues, []);
  });
});

describe("evaluateSweBenchRun and export (H04.02)", () => {
  const { tasks } = importSweBenchTasks(taskLine());
  const task = tasks[0] as SweBenchTask;

  it("resolves when every FAIL_TO_PASS passes and no PASS_TO_PASS regressed", () => {
    const evaluation = evaluateSweBenchRun(task, outcomeFor(task.instanceId, { test_one: "passed", test_two: "passed", test_keep: "passed" }));
    assert.equal(evaluation.resolved, true);
    assert.equal(evaluation.instance_id, task.instanceId);
    assert.deepEqual(evaluation.fail_to_pass, { test_one: "passed", test_two: "passed" });
    assert.deepEqual(evaluation.pass_to_pass, { test_keep: "passed" });
  });

  it("does not resolve when a FAIL_TO_PASS test fails or is missing", () => {
    const failed = evaluateSweBenchRun(task, outcomeFor(task.instanceId, { test_one: "failed", test_two: "passed", test_keep: "passed" }));
    assert.equal(failed.resolved, false);
    const missing = evaluateSweBenchRun(task, outcomeFor(task.instanceId, { test_one: "passed", test_keep: "passed" }));
    assert.equal(missing.resolved, false);
    assert.equal(missing.fail_to_pass.test_two, "failed");
  });

  it("does not resolve when a PASS_TO_PASS test regressed", () => {
    const regression = evaluateSweBenchRun(task, outcomeFor(task.instanceId, { test_one: "passed", test_two: "passed", test_keep: "error" }));
    assert.equal(regression.resolved, false);
    assert.equal(regression.pass_to_pass.test_keep, "error");
  });

  it("exports evaluations as canonical JSONL with one parseable line per record", () => {
    const evaluations = [
      evaluateSweBenchRun(task, outcomeFor(task.instanceId, { test_one: "passed", test_two: "passed", test_keep: "passed" })),
      evaluateSweBenchRun(task, outcomeFor("other__id-9", { test_one: "failed" })),
    ];
    const jsonl = exportSweBenchEvaluations(evaluations);
    assert.ok(jsonl.endsWith("\n"));
    const lines = jsonl.split("\n").filter((line) => line.length > 0);
    assert.equal(lines.length, 2);
    const first = JSON.parse(lines[0] as string) as SweBenchEvaluation;
    assert.equal(first.instance_id, "astropy__astropy-12907");
    assert.equal(first.resolved, true);
    assert.equal(first.model, "deepseek-v4.1");
    assert.equal(first.model_patch, "+ fix\n");
    const second = JSON.parse(lines[1] as string) as SweBenchEvaluation;
    assert.equal(second.resolved, false);
  });

  it("exports byte-identical JSONL for equal inputs regardless of key insertion order", () => {
    const left = exportSweBenchEvaluations([evaluateSweBenchRun(task, outcomeFor(task.instanceId, { test_one: "passed", test_two: "passed", test_keep: "passed" }))]);
    const reordered: SweBenchEvaluation = {
      model_patch: "+ fix\n",
      resolved: true,
      fail_to_pass: { test_two: "passed", test_one: "passed" },
      pass_to_pass: { test_keep: "passed" },
      model: "deepseek-v4.1",
      base_commit: "d16bfe1",
      repo: "astropy/astropy",
      instance_id: "astropy__astropy-12907",
    };
    const right = exportSweBenchEvaluations([reordered]);
    assert.equal(left, right);
  });

  it("exports an empty string for no evaluations", () => {
    assert.equal(exportSweBenchEvaluations([]), "");
  });

  it("summarizes totals and the deterministic resolution rate", () => {
    const evaluations = [
      evaluateSweBenchRun(task, outcomeFor(task.instanceId, { test_one: "passed", test_two: "passed", test_keep: "passed" })),
      evaluateSweBenchRun(task, outcomeFor("x__x-1", { test_one: "skipped" })),
    ];
    assert.deepEqual(summarizeSweBenchEvaluations(evaluations), { total: 2, resolved: 1, unresolved: 1, resolutionRate: 0.5 });
    assert.deepEqual(summarizeSweBenchEvaluations([]), { total: 0, resolved: 0, unresolved: 0, resolutionRate: 0 });
  });

  it("round-trips import -> evaluate -> export -> parse end to end", () => {
    const document = `${taskLine()}\n${taskLine({ instance_id: "django__django-1", FAIL_TO_PASS: ["test_d"] })}\n`;
    const imported = importSweBenchTasks(document);
    assert.deepEqual(imported.issues, []);
    const exported = exportSweBenchEvaluations(imported.tasks.map((t) => evaluateSweBenchRun(t, outcomeFor(t.instanceId, { test_one: "passed", test_two: "passed", test_keep: "passed", test_d: "failed" }))));
    const records = exported.split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line) as SweBenchEvaluation);
    assert.deepEqual(records.map((record) => record.resolved), [true, false]);
  });
});

describe("H04 review regressions (deepseek-v4.1-flash, 1017 high)", () => {
  it("never resolves an instance whose FAIL_TO_PASS list is empty", () => {
    const lines = [
      JSON.stringify({ instance_id: "org__repo-1", repo: "org/repo", base_commit: "abc123", patch: "diff", FAIL_TO_PASS: [], PASS_TO_PASS: ["keep"] }),
    ].join("\n");
    const imported = importSweBenchTasks(lines);
    assert.equal(imported.tasks.length, 1);
    const evaluation = evaluateSweBenchRun(imported.tasks[0]!, {
      instanceId: "org__repo-1", model: "m", modelPatch: "diff",
      testResults: { keep: "passed" },
    });
    assert.equal(evaluation.resolved, false, "an empty fail-to-pass set cannot prove a fix");
    assert.deepEqual(summarizeSweBenchEvaluations([evaluation]), { total: 1, resolved: 0, unresolved: 1, resolutionRate: 0 });
  });
});
