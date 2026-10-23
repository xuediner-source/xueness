/** Workflow DSL compiler: accepted forms, phase stamping and every rejection. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PyValueError } from "@xueness/contracts";
import { compileWorkflowScript } from "../src/dsl.ts";

const ROOT = "C:/work";
const compile = (source: string): Record<string, unknown> => compileWorkflowScript(source, ROOT);
const nodes = (source: string): Record<string, unknown>[] => compile(source).nodes as Record<string, unknown>[];

describe("workflow DSL", () => {
  it("compiles one agent call into agent_001", () => {
    const plan = compile('agent("prompt")');
    assert.deepEqual(plan, {
      name: "Workflow",
      nodes: [{ id: "agent_001", kind: "agent", prompt: "prompt" }],
    });
  });

  it("keeps the caller's default name", () => {
    assert.equal(compileWorkflowScript('agent("x")', ROOT, "Custom").name, "Custom");
  });

  it("stamps only the nodes declared after phase()", () => {
    const rows = nodes('agent("before")\nphase("Research")\nagent("after")');
    assert.equal(rows[0]!.phase, undefined);
    assert.equal(rows[1]!.phase, "Research");
  });

  it("strips the phase title", () => {
    assert.equal(nodes('phase("  Research  ")\nagent("x")')[0]!.phase, "Research");
  });

  it("links pipeline stages to the previous stage", () => {
    const rows = nodes('a = agent("x")\nb = agent("y")\npipeline([a, b])');
    assert.deepEqual(rows[0]!.needs, []);
    assert.deepEqual(rows[1]!.needs, ["agent_001"]);
  });

  it("links every stage to the union of the previous stage", () => {
    const rows = nodes('a = agent("a")\nb = agent("b")\nc = agent("c")\npipeline([a, parallel([b, c]), agent("d")])');
    assert.deepEqual(rows[2]!.needs, ["agent_001"]);
    assert.deepEqual(rows[3]!.needs, ["agent_002", "agent_003"]);
  });

  it("flattens parallel children without linking them", () => {
    const rows = nodes('parallel([agent("x"), agent("y")])');
    assert.deepEqual(rows.map((row) => row.id), ["agent_001", "agent_002"]);
    assert.equal(rows[0]!.needs, undefined);
    assert.equal(rows[1]!.needs, undefined);
  });

  it("accepts agent options, await, tuples and dict-free literals", () => {
    const rows = nodes('a = await agent("x", cwd="sub", timeout=5, provider_id="p", model="m", writable=True)');
    assert.deepEqual(rows[0], {
      id: "agent_001", kind: "agent", prompt: "x", cwd: "sub", timeout: 5,
      provider_id: "p", model: "m", writable: true,
    });
    assert.deepEqual(nodes('parallel((agent("a"), agent("b")))').map((row) => row.prompt), ["a", "b"]);
  });

  it("reads name = \"My flow\" as the plan name", () => {
    assert.equal(compile('name = "My flow"\nagent("x")').name, "My flow");
  });

  it("returns no concurrency key", () => {
    assert.equal(Object.hasOwn(compile('agent("x")'), "concurrency"), false);
  });

  it("rejects a script that is empty, blank or over 32000 characters", () => {
    const over = 'agent("' + "x".repeat(32_000) + '")';
    assert.throws(() => compile(""), /^ValueError: workflow script must be 1\.\.32000 characters$/);
    assert.throws(() => compile("   \n  "), /workflow script must be 1\.\.32000 characters/);
    assert.throws(() => compile(over), /workflow script must be 1\.\.32000 characters/);
  });

  it("rejects a script with no agent", () => {
    assert.throws(() => compile('name = "Only a name"'), /workflow script must declare at least one agent/);
    assert.throws(() => compile("# just a comment"), /workflow script must declare at least one agent/);
  });

  it("caps the plan at 64 agents", () => {
    assert.equal(nodes('parallel([' + Array.from({ length: 64 }, () => 'agent("x")').join(", ") + "])").length, 64);
    const over = 'parallel([' + Array.from({ length: 65 }, () => 'agent("x")').join(", ") + "])";
    assert.throws(() => compile(over), /workflow has more than 64 agents/);
  });

  it("rejects bad syntax with Python's message", () => {
    assert.throws(() => compile("agent("), /invalid workflow expression syntax/);
    assert.throws(() => compile("agent('x'"), /invalid workflow expression syntax/);
    assert.throws(() => compile("  agent('x')"), /invalid workflow expression syntax/);
  });

  it("rejects unsupported statements", () => {
    for (const source of ["pass", "import os", "if True:\n    agent('x')", "a += 1", "a: int = 1", "x = y = agent('x')"]) {
      assert.throws(() => compile(source), /workflow scripts only support DSL expressions and simple assignments/, source);
    }
  });

  it("rejects a bare literal or a bare name expression statement", () => {
    assert.throws(() => compile('"just a string"'), /workflow scripts only support DSL expressions and simple assignments/);
    assert.throws(() => compile("1"), /workflow scripts only support DSL expressions and simple assignments/);
  });

  it("rejects every bad agent() call", () => {
    assert.throws(() => compile("agent()"), /agent\(\) needs one literal prompt string/);
    assert.throws(() => compile("agent('a', 'b')"), /agent\(\) needs one literal prompt string/);
    assert.throws(() => compile("agent(name)"), /agent\(\) needs one literal prompt string/);
    assert.throws(() => compile("agent(prompt=1)"), /agent\(\) needs one literal prompt string/);
    assert.throws(() => compile("agent(*a)"), /agent\(\) needs one literal prompt string/);
    assert.throws(() => compile("agent('x', bogus=1)"), /agent\(\) has an unsupported or duplicate option/);
    assert.throws(() => compile("agent('x', cwd='.', cwd='.')"), /agent\(\) has an unsupported or duplicate option/);
    assert.throws(() => compile("agent('x', **kw)"), /agent\(\) has an unsupported or duplicate option/);
  });

  it("rejects non-literal agent options", () => {
    assert.throws(() => compile("agent('x', timeout=-1)"), /workflow arguments must be literal values/);
    assert.throws(() => compile("agent('x', cwd=name)"), /workflow arguments must be literal values/);
    assert.throws(() => compile("agent('x', cwd={**d})"), /workflow arguments must be literal values/);
    assert.throws(() => compile("agent('x', cwd={1, 2})"), /workflow arguments must be literal values/);
  });

  it("rejects phase() outside a top-level statement or with a bad title", () => {
    assert.throws(() => compile("x = phase('T')"), /phase\(\) is only allowed as a top-level statement/);
    assert.throws(() => compile("parallel([phase('T')])"), /phase\(\) is only allowed as a top-level statement/);
    assert.throws(() => compile("phase()"), /phase\(\) accepts one literal title/);
    assert.throws(() => compile("phase('a', 'b')"), /phase\(\) accepts one literal title/);
    assert.throws(() => compile("phase(title='T')"), /phase\(\) accepts one literal title/);
    assert.throws(() => compile("phase('   ')"), /phase title must be 1\.\.120 characters/);
    assert.throws(() => compile('phase("' + "x".repeat(121) + '")'), /phase title must be 1\.\.120 characters/);
  });

  it("rejects a bad or over-long plan name", () => {
    assert.throws(() => compile('name = ""\nagent("x")'), /workflow name must be 1\.\.120 characters/);
    assert.throws(() => compile('name = "   "\nagent("x")'), /workflow name must be 1\.\.120 characters/);
    assert.throws(() => compile('name = "' + "x".repeat(121) + '"\nagent("x")'), /workflow name must be 1\.\.120 characters/);
    assert.throws(() => compile('name = 42\nagent("x")'), /workflow name must be 1\.\.120 characters/);
  });

  it("rejects an unsupported primitive and a non-name callee", () => {
    assert.throws(() => compile("foo('x')"), /^ValueError: unsupported workflow primitive: foo$/);
    assert.throws(() => compile("agent('x').run()"), /workflow calls must use a named DSL primitive/);
  });

  it("rejects parallel()/pipeline() with a bad stage list", () => {
    assert.throws(() => compile("parallel()"), /parallel\(\) accepts one list of agent stages/);
    assert.throws(() => compile("parallel(agent('x'))"), /parallel\(\) accepts one list of agent stages/);
    assert.throws(() => compile("parallel([agent('x')], [agent('y')])"), /parallel\(\) accepts one list of agent stages/);
    assert.throws(() => compile("parallel(x for x in a)"), /parallel\(\) accepts one list of agent stages/);
    assert.throws(() => compile("pipeline()"), /pipeline\(\) accepts one list of sequential stages/);
    assert.throws(() => compile("pipeline(agent('x'))"), /pipeline\(\) accepts one list of sequential stages/);
  });

  it("rejects an unknown name and a non-literal dictionary key", () => {
    assert.throws(() => compile("pipeline([a, b])"), /^ValueError: unknown workflow name: a$/);
    assert.throws(() => compile("agent('x', cwd={1: 2})"), /workflow dictionaries need unique string keys/);
    assert.throws(() => compile("agent('x', cwd={'a': 1, 'a': 2})"), /workflow dictionaries need unique string keys/);
  });

  it("rejects expressions that only combine DSL calls and names", () => {
    for (const source of ["x = 1 + 2", "x = f'{a}'", "x = lambda: 1", "x = [i for i in y]", "x = -1"]) {
      assert.throws(() => compile(source), /workflow expressions may only combine DSL calls and assigned stage names/, source);
    }
  });

  it("rejects nesting past the depth guard with the Python message", () => {
    assert.throws(() => compile("x = " + "[".repeat(400) + "]".repeat(400)), /workflow DSL nesting is too deep|invalid workflow expression syntax/);
  });

  it("throws PyValueError so callers can classify it", () => {
    assert.throws(() => compile(""), (error: unknown) => error instanceof PyValueError && error.name === "ValueError");
  });
});
