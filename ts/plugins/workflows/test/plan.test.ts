/**
 * Plan validation, digests, workspace fingerprints and the provider governor
 * (Python `workflows.validate_plan`, `workflow_plan_digest`,
 * `workspace_fingerprint`, `ProviderGovernor`). The error texts and the
 * normalised plan are compared against the Python oracle so both backends
 * accept exactly the same documents.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pyJsonDumps } from "@xueness/contracts";
import { ProviderGovernor } from "../src/governor.ts";
import { validatePlan, workflowPlanDigest, workspaceFingerprint, type Row } from "../src/plan.ts";
import { pythonUnavailableReason, runPythonAsync } from "../../../test-support/python-oracle.ts";

const unavailable = pythonUnavailableReason();

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "xueness-plan-"));
  mkdirSync(join(root, "sub"), { recursive: true });
  writeFileSync(join(root, "a.txt"), "one\n");
  writeFileSync(join(root, "sub", "b.txt"), "two\n");
  return root;
}

const command = (extra: Row = {}): Row => ({ nodes: [{ id: "build", argv: ["echo", "hi"] }], ...extra });

describe("validatePlan", () => {
  it("fills the documented defaults and normalises cwd, needs and timeout", () => {
    const root = workspace();
    try {
      const plan = validatePlan(command({ name: "Nightly", concurrency: 3 }), root);
      assert.equal(plan.name, "Nightly");
      assert.equal(plan.concurrency, 3);
      const [node] = plan.nodes as Row[];
      assert.deepEqual(node, { id: "build", argv: ["echo", "hi"], kind: "command", needs: [], cwd: ".", timeout: 300 });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("defaults the name and concurrency and keeps a nested cwd relative", () => {
    const root = workspace();
    try {
      const plan = validatePlan({ nodes: [{ id: "a", argv: ["true"], cwd: "sub", timeout: 1.5 }] }, root);
      assert.equal(plan.name, "Workflow");
      assert.equal(plan.concurrency, 2);
      const [node] = plan.nodes as Row[];
      assert.ok(node);
      assert.equal(node.cwd, "sub");
      assert.equal(node.timeout, 1.5);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("truncates a long name to 120 characters instead of refusing it", () => {
    const root = workspace();
    try {
      assert.equal((validatePlan(command({ name: "n".repeat(200) }), root).name as string).length, 120);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("refuses each malformed document with Python's own message", () => {
    const root = workspace();
    const cases: Array<[string, unknown, string]> = [
      ["extra plan field", { ...command(), extra: 1 }, "plan fields: name, nodes, concurrency"],
      ["concurrency out of range", command({ concurrency: 9 }), "concurrency must be 1..8"],
      ["concurrency not an int", command({ concurrency: 1.5 }), "concurrency must be 1..8"],
      ["empty nodes", { nodes: [] }, "nodes must contain 1..64 entries"],
      ["too many nodes", { nodes: Array.from({ length: 65 }, (_, i) => ({ id: `n${i}`, argv: ["true"] })) }, "nodes must contain 1..64 entries"],
      ["extra node field", { nodes: [{ id: "a", argv: ["true"], nope: 1 }] }, "invalid node fields"],
      ["duplicate id", { nodes: [{ id: "a", argv: ["true"] }, { id: "a", argv: ["true"] }] }, "node ids must be unique names"],
      ["bad id", { nodes: [{ id: "a b", argv: ["true"] }] }, "node ids must be unique names"],
      ["unknown kind", { nodes: [{ id: "a", kind: "task", argv: ["true"] }] }, "kind must be command or agent"],
      ["duplicate needs", { nodes: [{ id: "a", argv: ["true"] }, { id: "b", argv: ["true"], needs: ["a", "a"] }] }, "needs must be unique node ids"],
      ["cwd outside root", { nodes: [{ id: "a", argv: ["true"], cwd: ".." }] }, "node cwd must be an existing directory inside root"],
      ["cwd missing", { nodes: [{ id: "a", argv: ["true"], cwd: "nope" }] }, "node cwd must be an existing directory inside root"],
      ["timeout zero", { nodes: [{ id: "a", argv: ["true"], timeout: 0 }] }, "node timeout must be 0..3600 seconds"],
      ["timeout too big", { nodes: [{ id: "a", argv: ["true"], timeout: 3601 }] }, "node timeout must be 0..3600 seconds"],
      ["timeout boolean", { nodes: [{ id: "a", argv: ["true"], timeout: true }] }, "node timeout must be 0..3600 seconds"],
      ["empty argv", { nodes: [{ id: "a", argv: [] }] }, "command argv must be a nonempty string array"],
      ["empty program", { nodes: [{ id: "a", argv: [""] }] }, "command argv must be a nonempty string array"],
      ["argv not strings", { nodes: [{ id: "a", argv: [1] }] }, "command argv must be a nonempty string array"],
      ["empty prompt", { nodes: [{ id: "a", kind: "agent", prompt: "" }] }, "agent prompt must be 1..5000 characters"],
      ["long prompt", { nodes: [{ id: "a", kind: "agent", prompt: "p".repeat(5001) }] }, "agent prompt must be 1..5000 characters"],
      ["writable on a command", { nodes: [{ id: "a", argv: ["true"], writable: true }] }, "writable is an explicit boolean opt-in for agent nodes only"],
      ["blank phase", { nodes: [{ id: "a", kind: "agent", prompt: "p", phase: "  " }] }, "phase must be a nonempty title up to 120 characters"],
      ["long model", { nodes: [{ id: "a", kind: "agent", prompt: "p", model: "m".repeat(201) }] }, "invalid model selection"],
      ["unknown dependency", { nodes: [{ id: "a", argv: ["true"], needs: ["ghost"] }] }, "dependency cycle or unknown dependency"],
      ["cycle", { nodes: [{ id: "a", argv: ["true"], needs: ["b"] }, { id: "b", argv: ["true"], needs: ["a"] }] }, "dependency cycle or unknown dependency"],
    ];
    try {
      for (const [label, value, message] of cases) {
        assert.throws(() => validatePlan(value, root), { name: "ValueError", message }, label);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("normalises the same plan as the Python oracle", async () => {
    if (unavailable) return;
    const root = workspace();
    try {
      const plan = { name: "Parity", concurrency: 2, nodes: [
        { id: "one", kind: "agent", prompt: "do it", phase: "Plan", writable: true, timeout: 12 },
        { id: "two", argv: ["echo", "ok"], needs: ["one"], cwd: "sub" },
      ] };
      const script = `
import json, sys
from xueness.bundled_plugins.workflows.workflows import validate_plan
payload = json.load(sys.stdin)
print(json.dumps(validate_plan(payload['plan'], payload['root']), ensure_ascii=False, sort_keys=True))
`;
      const expected = JSON.parse(await runPythonAsync(script, JSON.stringify({ plan, root }))) as unknown;
      assert.deepEqual(JSON.parse(pyJsonDumps(validatePlan(plan, root), { sortKeys: true })), expected);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("refuses the same documents as the Python oracle", async () => {
    if (unavailable) return;
    const root = workspace();
    const rejected: unknown[] = [
      { nodes: [{ id: "a", argv: ["true"], timeout: true }] },
      { nodes: [{ id: "a", argv: ["true"], cwd: ".." }] },
      { nodes: [{ id: "a", kind: "agent", prompt: "p", writable: "yes" }] },
      { nodes: [{ id: "a", argv: ["true"], needs: ["b"] }, { id: "b", argv: ["true"], needs: ["a"] }] },
    ];
    try {
      const script = `
import json, sys
from xueness.bundled_plugins.workflows.workflows import validate_plan
payload = json.load(sys.stdin)
out = []
for value in payload['cases']:
    try:
        validate_plan(value, payload['root'])
        out.append(None)
    except ValueError as error:
        out.append(str(error))
print(json.dumps(out, ensure_ascii=False))
`;
      const expected = JSON.parse(await runPythonAsync(script, JSON.stringify({ root, cases: rejected }))) as (string | null)[];
      rejected.forEach((value, index) => {
        assert.notEqual(expected[index], null, `case ${index} must be refused by Python too`);
        assert.throws(() => validatePlan(value, root), { name: "ValueError", message: expected[index]! });
      });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("workflowPlanDigest", () => {
  it("is the sha256 of the compact, key-sorted {root, plan} JSON", () => {
    const root = workspace();
    try {
      const plan = validatePlan(command(), root);
      const record = { root, plan };
      assert.match(workflowPlanDigest(record), /^[0-9a-f]{64}$/);
      assert.equal(workflowPlanDigest({ plan, root }), workflowPlanDigest(record));
      assert.notEqual(workflowPlanDigest({ root: root + "x", plan }), workflowPlanDigest(record));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("matches the Python digest for the same run", async () => {
    if (unavailable) return;
    const root = workspace();
    try {
      const plan = validatePlan(command(), root);
      const script = `
import json, sys
from xueness.bundled_plugins.workflows.workflows import workflow_plan_digest
payload = json.load(sys.stdin)
print(workflow_plan_digest({'root': payload['root'], 'plan': payload['plan']}))
`;
      const expected = (await runPythonAsync(script, JSON.stringify({ root, plan }))).trim();
      assert.equal(workflowPlanDigest({ root, plan }), expected);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("workspaceFingerprint", () => {
  it("changes when a file changes and stays stable when nothing does", () => {
    const root = workspace();
    try {
      const first = workspaceFingerprint(root);
      assert.match(first!, /^[0-9a-f]{64}$/);
      assert.equal(workspaceFingerprint(root), first);
      writeFileSync(join(root, "a.txt"), "changed\n");
      assert.notEqual(workspaceFingerprint(root), first);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("ignores .git and the state directory but not its siblings", () => {
    const root = workspace(), state = join(root, "state");
    try {
      mkdirSync(join(root, ".git"), { recursive: true });
      mkdirSync(state, { recursive: true });
      const before = workspaceFingerprint(root, state);
      writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
      writeFileSync(join(state, "sessions.json"), "{}\n");
      assert.equal(workspaceFingerprint(root, state), before);
      writeFileSync(join(root, "new.txt"), "new\n");
      assert.notEqual(workspaceFingerprint(root, state), before);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("ProviderGovernor", () => {
  it("admits one ticket at a time in round-robin order between owners", () => {
    const state = mkdtempSync(join(tmpdir(), "xueness-governor-"));
    try {
      const governor = new ProviderGovernor(state, 1);
      governor.enqueue("k", "run-a", "a1");
      governor.enqueue("k", "run-b", "b1");
      assert.equal(governor.tryAcquire("k", "a1"), true);
      assert.equal(governor.tryAcquire("k", "b1"), false, "the bucket limit is one");
      governor.finish("k", "a1", true);
      assert.equal(governor.tryAcquire("k", "b1"), true);
      governor.finish("k", "b1", true);
      governor.enqueue("k", "run-a", "a2");
      governor.enqueue("k", "run-b", "b2");
      assert.equal(governor.tryAcquire("k", "a2"), true, "round-robin cycles back to run-a after run-b");
      assert.equal(governor.tryAcquire("k", "b2"), true);
      governor.finish("k", "b2", true);
    } finally { rmSync(state, { recursive: true, force: true }); }
  });

  it("widens on success, halves on failure and cools down before retrying", () => {
    const state = mkdtempSync(join(tmpdir(), "xueness-governor-"));
    try {
      const governor = new ProviderGovernor(state, 2);
      governor.enqueue("k", "w", "t1");
      assert.equal(governor.tryAcquire("k", "t1"), true);
      governor.finish("k", "t1", true);
      governor.enqueue("k", "w", "t2");
      assert.equal(governor.tryAcquire("k", "t2"), true);
      governor.finish("k", "t2", false);
      governor.enqueue("k", "w", "t3");
      assert.equal(governor.tryAcquire("k", "t3"), false, "a failure starts a cooldown");
      const saved = JSON.parse(readGovernor(state)) as { buckets: Record<string, { limit: number; cooldown_until: number }> };
      assert.equal(saved.buckets.k!.limit, 1);
      assert.ok(saved.buckets.k!.cooldown_until > Date.now() / 1000);
    } finally { rmSync(state, { recursive: true, force: true }); }
  });

  it("drops a cancelled ticket without touching the others", () => {
    const state = mkdtempSync(join(tmpdir(), "xueness-governor-"));
    try {
      const governor = new ProviderGovernor(state, 2);
      governor.enqueue("k", "w", "t1");
      governor.enqueue("k", "w", "t2");
      governor.cancel("k", "t1");
      assert.equal(governor.tryAcquire("k", "t1"), false);
      assert.equal(governor.tryAcquire("k", "t2"), true);
      governor.finish("k", "t2", true);
    } finally { rmSync(state, { recursive: true, force: true }); }
  });
});

function readGovernor(state: string): string {
  return readFileSync(join(state, ".workflow-provider-governor.json"), "utf8");
}
