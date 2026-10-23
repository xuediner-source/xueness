import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compileDynamicWorkflow } from "../src/dynamic-compile.ts";
import { evaluateDynamicWorkflow } from "../src/dynamic-evaluate.ts";
import type { DynamicActor, DynamicScriptHost } from "../src/dynamic-types.ts";

function createHost(overrides: Partial<DynamicScriptHost> = {}): DynamicScriptHost {
  let actorId = 0;
  return {
    createActor: (_site, name, persona) => ({ id: `actor-${++actorId}`, name, persona: typeof persona === "string" ? { system: persona } : persona ?? {} }),
    ask: async (_site, _actor, instructions) => instructions,
    read: async (_site, operation, args) => ({ operation, args }),
    report: () => undefined,
    log: () => undefined,
    phase: () => undefined,
    hole: async (_site, name) => ({ name }),
    ...overrides,
  };
}

describe("dynamic workflow AST evaluation", () => {
  it("runs typed asks through loops, branches, and return", async () => {
    const source = `interface Answer { accepted: boolean; score: number }
const reviewer = agent("reviewer");
let total = 0;
for (const round of ["first", "second", "third"]) {
  const answer = await reviewer.ask<Answer>(round);
  if (answer.accepted && answer.score > 0) total += answer.score;
}
let visited = 0;
for (let index = 0; index < 3; index++) visited++;
if (total >= 5 && visited === 3) return { accepted: true, total };
return { accepted: false, total };`;
    const compiled = compileDynamicWorkflow(source);
    assert.deepEqual(compiled.diagnostics, []);
    const actor: DynamicActor = { id: "reviewer-1", name: "reviewer", persona: {} };
    const schemas: unknown[] = [];
    const result = await evaluateDynamicWorkflow(compiled, createHost({
      createActor: () => actor,
      ask: async (_site, current, instructions, schema) => {
        assert.equal(current, actor);
        assert.equal(typeof instructions, "string");
        schemas.push(schema);
        return instructions === "second" ? { accepted: false, score: 20 } : { accepted: true, score: 3 };
      },
    }));
    assert.deepEqual({ ...(result as Record<string, unknown>) }, { accepted: true, total: 6 });
    assert.equal(schemas.length, 3);
    assert.ok(schemas.every((schema) => schema === compiled.schemas.get(compiled.sites.find((site) => site.kind === "ask")!.start)));
  });

  it("starts async map asks together before Promise.all waits", async () => {
    const compiled = compileDynamicWorkflow(`const writer = agent("writer");
const inputs = ["one", "two", "three"];
return await Promise.all(inputs.map(async (input) => writer.ask(input)));`);
    assert.deepEqual(compiled.diagnostics, []);
    let active = 0;
    let maximum = 0;
    const result = await evaluateDynamicWorkflow(compiled, createHost({
      ask: async (_site, _actor, instructions) => {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
        return instructions;
      },
    }));
    assert.deepEqual(result, ["one", "two", "three"]);
    assert.equal(maximum, 3);
  });

  it("passes read, phase, report, log, and hole calls to the host", async () => {
    const compiled = compileDynamicWorkflow(`phase("research");
const paths = await files.glob("*.md");
const world = await files.read(args.worldPath);
report({ paths, world });
log("ready");
return await hole("missing detail", "ask the operator");`);
    assert.deepEqual(compiled.diagnostics, []);
    const seen: unknown[] = [];
    const result = await evaluateDynamicWorkflow(compiled, createHost({
      phase: (name) => seen.push(["phase", name]),
      read: async (_site, operation, args) => {
        seen.push(["read", operation, args]);
        return operation === "files.glob" ? ["a.md"] : "world data";
      },
      report: (_site, item) => seen.push(["report", item]),
      log: (message) => seen.push(["log", message]),
      hole: async (_site, name, prompt) => { seen.push(["hole", name, prompt]); return "filled"; },
    }), { args: { worldPath: "world.md" } });
    assert.equal(result, "filled");
    const normalized = seen.map((entry) => {
      const row = entry as unknown[];
      return row[0] === "report" ? [row[0], { ...(row[1] as Record<string, unknown>) }] : row;
    });
    assert.deepEqual(normalized, [
      ["phase", "research"],
      ["read", "files.glob", ["*.md"]],
      ["read", "files.read", ["world.md"]],
      ["report", { paths: ["a.md"], world: "world data" }],
      ["log", "ready"],
      ["hole", "missing detail", "ask the operator"],
    ]);
  });

  it("refuses ambient and forged actor calls, then enforces budget and cancellation", async () => {
    const ambient = compileDynamicWorkflow("return Date.now();");
    assert.ok(ambient.diagnostics.length > 0);
    await assert.rejects(evaluateDynamicWorkflow(ambient, createHost()), /workflow is not runnable/);

    const forged = compileDynamicWorkflow(`const fake = { id: "x", name: "fake", persona: {} };
return await fake.ask("hello");`);
    await assert.rejects(evaluateDynamicWorkflow(forged, createHost()), /only approved workflow and value methods can be called/);

    const infinite = compileDynamicWorkflow("while (true) {}");
    await assert.rejects(evaluateDynamicWorkflow(infinite, createHost(), { maxOperations: 80 }), (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "DYNAMIC_BUDGET");

    const controller = new AbortController();
    const running = evaluateDynamicWorkflow(infinite, createHost(), { signal: controller.signal });
    setTimeout(() => controller.abort(), 0);
    await assert.rejects(running, (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "DYNAMIC_CANCELLED");
  });

  it("keeps an unawaited ask pending and drains it when the script completes", async () => {
    const compiled = compileDynamicWorkflow(`const editor = agent("editor");
const pending = editor.ask("draft");
phase("after launch");
return "caller completed";`);
    const events: string[] = [];
    const result = await evaluateDynamicWorkflow(compiled, createHost({
      ask: async () => {
        events.push("ask started");
        await new Promise((resolve) => setTimeout(resolve, 15));
        events.push("ask finished");
        return "draft";
      },
      phase: () => events.push("phase ran"),
    }));
    assert.deepEqual(result, "caller completed");
    assert.deepEqual(events, ["ask started", "phase ran", "ask finished"]);
  });
});
