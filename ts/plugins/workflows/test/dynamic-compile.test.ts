import assert from "node:assert/strict";
import test from "node:test";
import { compileDynamicWorkflow } from "../src/dynamic-compile.ts";

test("synthesizes ask schemas and stable source-ordered sites", () => {
  const source = `interface Base { id: string }
interface Result extends Base {
  status: "ok" | "retry";
  value?: number | null;
  marks: Array<string>;
  tags: Record<string, string>;
}
const worker = agent("writer", { system: "write" });
const result = await worker.ask<Result>("draft");
files.read("input.txt");
report(result);
hole("review", "check the draft");
phase("review");`;
  const compiled = compileDynamicWorkflow(source);
  assert.deepEqual(compiled.diagnostics, []);
  const askStart = source.indexOf("worker.ask<Result>");
  const askCall = compiled.sourceFile.statements[3] as import("typescript").VariableStatement;
  const expression = (askCall.declarationList.declarations[0]!.initializer as import("typescript").AwaitExpression).expression as import("typescript").CallExpression;
  assert.equal(expression.getStart(compiled.sourceFile), askStart);
  const schema = compiled.schemas.get(askStart) as {
    type: string;
    properties: Record<string, { type?: string; enum?: unknown[]; anyOf?: unknown[]; items?: unknown; additionalProperties?: unknown }>;
    required: string[];
  };
  assert.equal(schema.type, "object");
  assert.deepEqual(schema.required, ["id", "status", "marks", "tags"]);
  assert.deepEqual(schema.properties.status!.enum, ["ok", "retry"]);
  assert.equal(schema.properties.value!.anyOf?.length, 2);
  assert.deepEqual(schema.properties.marks!.items, { type: "string" });
  assert.deepEqual(schema.properties.tags!.additionalProperties, { type: "string" });
  assert.deepEqual(compiled.sites.map(({ id, kind }) => `${kind}:${id}`), [
    "actor:actor#1", "ask:ask#1", "read:read#1", "report:report#1", "hole:hole#1", "phase:phase#1",
  ]);
  assert.deepEqual(compiled.sites.map((site) => site.start), [
    source.indexOf("agent("), askStart, source.indexOf("files.read("), source.indexOf("report("), source.indexOf("hole("), source.indexOf("phase("),
  ]);
});

test("accepts the documented control flow and pure callback subset", () => {
  const source = `const values = [1, 2, 3];
let total = 0;
for (let i = 0; i < values.length; i++) {
  total += values[i];
}
for (const value of values) {
  if (value === 2) continue;
  total += value;
}
while (total < 12) {
  total++;
  if (total === 10) break;
}
const selected = values.filter((value) => value > 1).map(async (value) => await Promise.all([value + 1]));
const label = selected.length > 0 ? String(total).trim() : "empty";
report({ total, label });`;
  const compiled = compileDynamicWorkflow(source);
  assert.deepEqual(compiled.diagnostics, []);
  assert.deepEqual(compiled.sites.map((site) => site.id), ["report#1"]);
});

test("reports forbidden globals, prototype paths, and duplicate actor names with locations", () => {
  const source = `const first = agent("writer");
const second = agent("writer");
const secret = process.env.TOKEN;
const value = row["__proto__"];`;
  const compiled = compileDynamicWorkflow(source);
  const duplicates = compiled.diagnostics.filter((item) => item.code === "DYN_DUPLICATE_ACTOR_NAME");
  const ambient = compiled.diagnostics.find((item) => item.code === "DYN_FORBIDDEN_GLOBAL");
  const prototype = compiled.diagnostics.find((item) => item.code === "DYN_FORBIDDEN_PROPERTY");
  assert.equal(duplicates.length, 1);
  assert.deepEqual([duplicates[0]!.line, duplicates[0]!.column], [2, 16]);
  assert.deepEqual([ambient!.line, ambient!.column], [3, 16]);
  assert.deepEqual([prototype!.line, prototype!.column], [4, 15]);
});

test("returns located TypeScript parse and unsupported type diagnostics", () => {
  const syntax = compileDynamicWorkflow("const result = ;");
  assert.ok(syntax.diagnostics.some((item) => item.code.startsWith("TS") && item.line === 1 && item.column > 1));

  const unsupported = compileDynamicWorkflow(`const worker = agent("writer");
await worker.ask<any>("draft");`);
  const typeIssue = unsupported.diagnostics.find((item) => item.code === "DYN_UNSUPPORTED_TYPE");
  assert.ok(typeIssue);
  assert.equal(typeIssue.line, 2);
  assert.ok(typeIssue.column > 1);
  assert.equal(unsupported.schemas.size, 0);

  const circular = compileDynamicWorkflow(`interface Link { next?: Link }
const worker = agent("writer");
await worker.ask<Link>("draft");`);
  assert.ok(circular.diagnostics.some((item) => item.code === "DYN_UNSUPPORTED_TYPE" && item.message.includes("Circular type")));
  assert.equal(circular.schemas.size, 0);
});

test("rejects out-of-range source lengths", () => {
  const compiled = compileDynamicWorkflow("x".repeat(32_001));
  assert.equal(compiled.diagnostics[0]?.code, "DYN_SOURCE_LENGTH");
  assert.deepEqual([compiled.diagnostics[0]?.line, compiled.diagnostics[0]?.column], [1, 1]);
});
