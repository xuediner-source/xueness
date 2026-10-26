import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ModelSelectionLookupError } from "@xueness/agent";
import { OpenAICompatible } from "@xueness/providers";
import { providerExecutionModelScope } from "../src/execution-selection.ts";
import { ProfileStore } from "../src/profile-store.ts";

function storeWithProfile(): { store: ProfileStore; close: () => void } {
  const directory = mkdtempSync(join(tmpdir(), "xueness-execution-"));
  const store = new ProfileStore(join(directory, "state"));
  store.save({ id: "temp-provider", name: "Temporary", baseUrl: "http://127.0.0.1:9/v1", model: "GLM-5.3-Turbo", apiKey: "k", allowLoopbackHttp: true });
  store.save({ id: "session-provider", name: "Session", baseUrl: "http://127.0.0.1:9/v1", model: "GLM-5.3", apiKey: "k", allowLoopbackHttp: true });
  return { store, close: () => rmSync(directory, { recursive: true, force: true }) };
}

describe("providerExecutionModelScope", () => {
  it("resolves the execution selection and fallback targets through the profile registry", () => {
    const { store, close } = storeWithProfile();
    try {
      const scope = providerExecutionModelScope(store, {
        selection: { providerId: "temp-provider", model: "GLM-5.3-Turbo" },
        fallback: { providerId: "temp-provider", rules: [{ reason: "expired", providerErrorCode: "3402" }, { reason: "failed" }], target: { providerId: "session-provider", model: "GLM-5.3" } },
      });
      assert.equal(scope.selection.providerId, "temp-provider");
      assert.equal(scope.fallback?.providerId, "temp-provider");
      assert.equal(scope.fallback?.rules.length, 2);
      const temporary = scope.resolveProvider(scope.selection);
      const target = scope.resolveProvider(scope.fallback!.target!);
      assert.ok(temporary instanceof OpenAICompatible);
      assert.ok(target instanceof OpenAICompatible);
      assert.equal((target as OpenAICompatible).model, "GLM-5.3");
    } finally { close(); }
  });

  it("normalizes registry lookup failures to the pre-request selection-failure class", () => {
    const { store, close } = storeWithProfile();
    try {
      const scope = providerExecutionModelScope(store, { selection: { providerId: "temp-provider", model: "GLM-5.3-Turbo" } });
      const missing = scope.resolveProvider({ providerId: "no-such-provider", modelId: "GLM-5.3" });
      void missing;
      assert.fail("expected a lookup failure");
    } catch (error) {
      assert.ok(error instanceof ModelSelectionLookupError, String(error));
      assert.equal((error as ModelSelectionLookupError).selection.providerId, "no-such-provider");
    } finally { close(); }
  });

  it("rejects declarations that name neither provider nor model and fallbacks without rules", () => {
    const { store, close } = storeWithProfile();
    try {
      assert.throws(() => providerExecutionModelScope(store, { selection: { providerId: null, model: null } }), TypeError);
      assert.throws(() => providerExecutionModelScope(store, { selection: { providerId: "temp-provider" }, fallback: { providerId: "temp-provider", rules: [] } }), TypeError);
      assert.throws(() => providerExecutionModelScope(store, { selection: { providerId: "temp-provider" }, fallback: { providerId: "  ", rules: [{ reason: "failed" }] } }), TypeError);
    } finally { close(); }
  });
});
