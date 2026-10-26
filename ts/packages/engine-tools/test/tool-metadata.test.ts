import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BUILTIN_TOOLS } from "../src/index.ts";
import { toolExposure, toolSafetyMetadata } from "../src/tool.ts";

describe("tool safety metadata", () => {
  it("normalizes to deterministic defaults when a field is undeclared", () => {
    assert.deepEqual(toolSafetyMetadata({ mutating: false, concurrencySafe: true }), { readOnly: true, mutating: false, destructive: false, concurrencySafe: true });
    assert.deepEqual(toolSafetyMetadata({ mutating: true, concurrencySafe: false }), { readOnly: false, mutating: true, destructive: false, concurrencySafe: false });
    // An undeclared concurrencySafe follows the read-only verdict; destructive is opt-in.
    assert.deepEqual(toolSafetyMetadata({ readOnly: true }), { readOnly: true, mutating: false, destructive: false, concurrencySafe: true });
    assert.deepEqual(toolSafetyMetadata({ mutating: true }), { readOnly: false, mutating: true, destructive: false, concurrencySafe: false });
  });
  it("lets declared values win over the derived defaults", () => {
    assert.equal(toolSafetyMetadata({ mutating: false, concurrencySafe: true, readOnly: false }).readOnly, false);
    assert.equal(toolSafetyMetadata({ mutating: true, concurrencySafe: false, readOnly: true }).readOnly, true);
    assert.equal(toolSafetyMetadata({ mutating: false, concurrencySafe: true, destructive: true }).destructive, true);
  });
  it("keeps every shipped builtin tool's declared values untouched", () => {
    for (const tool of BUILTIN_TOOLS) {
      const safety = toolSafetyMetadata(tool);
      assert.equal(safety.mutating, tool.mutating);
      assert.equal(safety.concurrencySafe, tool.concurrencySafe);
      assert.equal(safety.readOnly, !tool.mutating);
      assert.equal(safety.destructive, false);
      assert.equal(toolExposure(tool), "default");
    }
  });
});

describe("tool exposure classification", () => {
  it("classifies unclassified tools as default and honors shouldDefer", () => {
    assert.equal(toolExposure({}), "default");
    assert.equal(toolExposure({ shouldDefer: false }), "default");
    assert.equal(toolExposure({ shouldDefer: true }), "deferred");
    assert.equal(toolExposure({ alwaysLoad: true }), "always");
    // Non-boolean noise is not a declaration.
    assert.equal(toolExposure({ alwaysLoad: "yes" as unknown as boolean }), "default");
    assert.equal(toolExposure({ shouldDefer: 1 as unknown as boolean }), "default");
  });
  it("resolves the alwaysLoad-shouldDefer conflict deterministically in favor of alwaysLoad", () => {
    assert.equal(toolExposure({ alwaysLoad: true, shouldDefer: true }), "always");
  });
});
