import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatSchemaIssues, schemaShapeIssues, validateSchema, type JsonSchema } from "../src/index.ts";

const READ_INPUT: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["path"],
  properties: {
    path: { type: "string", minLength: 1 },
    offset: { type: "integer", minimum: 1 },
    mode: { enum: ["text", "bytes"] },
    tags: { type: "array", items: { type: "string" }, maxItems: 2 },
  },
};

describe("json schema subset", () => {
  it("accepts conforming input", () => {
    assert.deepEqual(validateSchema(READ_INPUT, { path: "a.txt", offset: 3, mode: "text", tags: ["x"] }), []);
  });

  it("reports every problem with a JSON pointer", () => {
    const issues = validateSchema(READ_INPUT, { offset: 0.5, mode: "zip", tags: ["a", 1, "c"], extra: true });
    assert.equal(formatSchemaIssues(issues), [
      "/path is required", "/offset must be integer", '/mode must be one of "text", "bytes"',
      "/tags must have at most 2 items", "/tags/1 must be string", "/extra is not allowed",
    ].join("; "));
  });

  it("checks lengths in code points", () => {
    assert.deepEqual(validateSchema({ type: "string", maxLength: 2 }, "😀😀"), []);
  });

  it("enforces union branches and typed dictionary values", () => {
    const schema: JsonSchema = { type: "object", additionalProperties: { anyOf: [{ type: "string" }, { type: "number" }] } };
    assert.deepEqual(schemaShapeIssues(schema), []);
    assert.deepEqual(validateSchema(schema, { label: "ok", count: 2 }), []);
    assert.deepEqual(validateSchema(schema, { invalid: false }), [{ path: "/invalid", message: "must match one of the allowed schemas" }]);
    assert.equal(schemaShapeIssues({ anyOf: [] }).length, 1);
  });
});
