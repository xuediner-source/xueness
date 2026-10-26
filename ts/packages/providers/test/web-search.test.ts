import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { nativeSearchDelegation, resolveWebSearchMode, type WebSearchProviderView } from "../src/index.ts";

describe("resolveWebSearchMode (F12.04 negotiation)", () => {
  it("resolves endpoint for absent, partial and undeclaring views", () => {
    assert.equal(resolveWebSearchMode(null), "endpoint");
    assert.equal(resolveWebSearchMode(undefined), "endpoint");
    assert.equal(resolveWebSearchMode({}), "endpoint");
    assert.equal(resolveWebSearchMode({ protocol: "anthropic" }), "endpoint");
    assert.equal(resolveWebSearchMode({ protocol: "openai", toolCalling: "native" }), "endpoint");
    assert.equal(resolveWebSearchMode({ nativeWebSearch: false, protocol: "anthropic", toolCalling: "native" }), "endpoint");
  });
  it("resolves native only for a protocol adapter that declares the surface", () => {
    const view: WebSearchProviderView = { protocol: "anthropic", toolCalling: "native", nativeWebSearch: true };
    assert.equal(resolveWebSearchMode(view), "native");
    assert.equal(resolveWebSearchMode({ nativeWebSearch: true }), "native");
  });
  it("never resolves native for JSON tool-calling providers", () => {
    assert.equal(resolveWebSearchMode({ protocol: "openai", toolCalling: "json", nativeWebSearch: true }), "endpoint");
    assert.equal(resolveWebSearchMode({ toolCalling: "json", nativeWebSearch: true }), "endpoint");
  });
  it("is keyed on the declared capability, never a brand list", () => {
    // Any protocol string can carry the surface; the boolean is the only gate.
    assert.equal(resolveWebSearchMode({ protocol: "private-adapter", toolCalling: "native", nativeWebSearch: true }), "native");
    assert.equal(resolveWebSearchMode({ protocol: "anthropic", nativeWebSearch: true }), "native");
  });
});

describe("nativeSearchDelegation", () => {
  it("returns a stable delegation result for the provider-native face", () => {
    const result = nativeSearchDelegation("glacier retreat");
    assert.equal(result.ok, true);
    assert.equal(result.query, "glacier retreat");
    assert.equal(result.native, "provider_web_search");
    assert.equal(result.searchMode, "native");
    assert.deepEqual(result.provenance, { kind: "provider_native_search", delegated: true });
    assert.match(String(result.notice), /natively/u);
  });
});
