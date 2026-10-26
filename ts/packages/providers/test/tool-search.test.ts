import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveToolSearchMode } from "../src/tool-search.ts";

describe("resolveToolSearchMode", () => {
  it("resolves local without a provider view or any declared capability", () => {
    assert.equal(resolveToolSearchMode(null), "local");
    assert.equal(resolveToolSearchMode(undefined), "local");
    assert.equal(resolveToolSearchMode({}), "local");
    assert.equal(resolveToolSearchMode({ protocol: "openai", toolCalling: "native" }), "local");
    assert.equal(resolveToolSearchMode({ protocol: "anthropic", toolCalling: "native" }), "local");
    assert.equal(resolveToolSearchMode({ protocol: "anthropic", toolCalling: "native", nativeToolSearch: false }), "local");
  });

  it("enables native only when the protocol adapter declares the deferred-loading surface", () => {
    assert.equal(resolveToolSearchMode({ protocol: "anthropic", toolCalling: "native", nativeToolSearch: true }), "native");
    assert.equal(resolveToolSearchMode({ protocol: "custom-protocol", toolCalling: "native", nativeToolSearch: true }), "native",
      "the gate is the declared protocol capability, never a brand or model list");
  });

  it("keeps a JSON tool-calling provider on the local path", () => {
    assert.equal(resolveToolSearchMode({ protocol: "anthropic", toolCalling: "json", nativeToolSearch: true }), "local",
      "a JSON tool envelope has no protocol-native tool surface");
  });
});
