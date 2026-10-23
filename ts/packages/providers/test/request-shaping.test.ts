import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isAnthropicFirstPartyModelId, toStrictToolSchema } from "../src/strict-tool-schema.ts";
import { normalizeOpenAiCompatibleSystemMessages } from "../src/system-message-compat.ts";

describe("provider request shaping helpers", () => {
  it("folds strict-schema constraints recursively without changing the input", () => {
    const input = {
      type: "object",
      description: "  submit a record  ",
      properties: {
        name: { type: "string", minLength: 2, maxLength: 8, format: "custom-name" },
        values: { type: "array", minItems: 1, items: { type: "object", properties: {
          count: { type: "integer", minimum: 1, multipleOf: 2 },
        } } },
        mode: { anyOf: [{ type: "string", enum: ["fast"] }, { type: "null" }] },
      },
      required: ["name", "values", "mode"],
    };
    const original = structuredClone(input);

    assert.deepEqual(toStrictToolSchema(input), {
      type: "object",
      description: "  submit a record  ",
      properties: {
        name: { type: "string", description: "at least 2 characters; at most 8 characters; format custom-name" },
        values: { type: "array", items: { type: "object", properties: {
          count: { type: "integer", description: "minimum 1; multiple of 2" },
        }, additionalProperties: false }, description: "at least 1 items" },
        mode: { anyOf: [{ type: "string", enum: ["fast"] }, { type: "null" }] },
      },
      required: ["name", "values", "mode"],
      additionalProperties: false,
    });
    assert.deepEqual(input, original);
  });

  it("declines strict schemas whose shape cannot be represented", () => {
    const ineligible = [
      {},
      { $ref: "#/$defs/value", type: "string" },
      { $defs: { value: { type: "string" } }, type: "string" },
      { type: "array", prefixItems: [{ type: "string" }] },
      { type: "object", additionalProperties: { type: "string" } },
      { type: "object", properties: { value: {} } },
    ];
    for (const schema of ineligible) {
      const original = structuredClone(schema);
      assert.equal(toStrictToolSchema(schema), undefined);
      assert.deepEqual(schema, original);
    }
  });

  it("qualifies only bare Claude model IDs", () => {
    assert.equal(isAnthropicFirstPartyModelId("claude-3-7-sonnet"), true);
    assert.equal(isAnthropicFirstPartyModelId("anthropic/claude-3-7-sonnet"), false);
    assert.equal(isAnthropicFirstPartyModelId("Claude-3-7-sonnet"), false);
    assert.equal(isAnthropicFirstPartyModelId(undefined), false);
  });

  it("merges only consecutive leading system messages and keeps the last cache boundary", () => {
    const first = { role: "system", content: "A", cacheControl: { type: "ephemeral", ttl: "5m" } };
    const second = { role: "system", content: [
      { type: "text", text: "B" },
      { type: "reasoning", text: "hidden" },
      { type: "image", mediaType: "image/png", source: { placeholder: "diagram" } },
      { type: "file", mediaType: "text/plain", text: "file text", name: "ignored.txt" },
      { type: "resource_link", uri: "https://example.test/r", title: "resource" },
    ], cacheControl: { type: "ephemeral", ttl: "1h" } };
    const user = { role: "user", content: "after prefix" };
    const laterSystem = { role: "system", content: "leave untouched", cacheControl: { type: "ephemeral" } };
    const messages = [first, second, user, laterSystem];
    const normalized = normalizeOpenAiCompatibleSystemMessages(messages);

    assert.equal(normalized.length, 3);
    assert.equal(normalized[0]?.content, "AB\n\n[Attached image/png: diagram]\n\nfile text\n\n[Resource: resource]");
    assert.deepEqual(normalized[0]?.cacheControl, { type: "ephemeral", ttl: "1h" });
    assert.notEqual(normalized[0]?.cacheControl, second.cacheControl);
    assert.equal(normalized[1], user);
    assert.equal(normalized[2], laterSystem);
    assert.deepEqual(normalizeOpenAiCompatibleSystemMessages([first]), [first]);
  });
});
