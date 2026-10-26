import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateSchema } from "@xueness/contracts";
import { DEFERRED_TOOL_CALL, DEFERRED_TOOL_CALL_SCHEMA, resolveDeferredToolCall } from "../src/deferred-call.ts";

describe("resolveDeferredToolCall (C-TOOL-04 envelope)", () => {
  it("unwraps a valid envelope into the target and its input, copying the object", () => {
    const input = { path: "a.txt" };
    const resolved = resolveDeferredToolCall({ tool: "alpha_two", input });
    assert.deepEqual(resolved, { target: "alpha_two", input: { path: "a.txt" } });
    assert.notEqual((resolved as { input: unknown }).input, input, "the envelope input is copied, not aliased");
  });

  it("defaults a missing input to an empty object and trims the target name", () => {
    assert.deepEqual(resolveDeferredToolCall({ tool: " alpha_two " }), { target: "alpha_two", input: {} });
  });

  it("rejects a non-object envelope, a missing or empty tool, a non-object input and unknown fields", () => {
    for (const envelope of [null, "alpha_two", 42, [], {}]) assert.ok(!("target" in resolveDeferredToolCall(envelope)), JSON.stringify(envelope));
    for (const tool of [null, "", "   "]) assert.ok(!("target" in resolveDeferredToolCall({ tool })));
    assert.ok(!("target" in resolveDeferredToolCall({ tool: "alpha_two", input: "x" })));
    assert.ok(!("target" in resolveDeferredToolCall({ tool: "alpha_two", input: [] })));
    assert.ok(!("target" in resolveDeferredToolCall({ tool: "alpha_two", input: {}, extra: true })), "additionalProperties stays closed");
    assert.match((resolveDeferredToolCall({}) as { issue: string }).issue, /\(input\)|tool/);
  });

  it("exposes the same schema the wrapper tool declares, and it rejects bad envelopes itself", () => {
    assert.equal(validateSchema(DEFERRED_TOOL_CALL_SCHEMA, { tool: "alpha_two" }).length, 0);
    assert.ok(validateSchema(DEFERRED_TOOL_CALL_SCHEMA, { tool: "" }).length > 0);
    assert.equal(DEFERRED_TOOL_CALL, "deferred_tool_call");
  });
});
