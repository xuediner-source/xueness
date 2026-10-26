import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { optionalArtifact, optionalInstalled, optionalRoot } from "@xueness/kernel";
import { mkdtempSync } from "../../../test-support/canonical-temp.ts";
import { installOptionalFixture } from "../../../test-support/optional-artifacts.ts";
import { createApplicationApi } from "../src/application-api.ts";
import { observeOptionalProvider } from "../src/optional-integrations.ts";

it("hot-loads downloaded account and monitor implementations, then uninstalls without deleting account state", async () => {
  const state = mkdtempSync(join(tmpdir(), "xueness-optional-runtime-")), runs = join(state, "runs");
  const api = await createApplicationApi({ projectRoot: join(import.meta.dirname, "../../../.."), stateDir: state, webRuns: runs, allowReal: false });
  try {
    const call = (method: string, parts: string[], data: Record<string, unknown> = {}) => api.dispatch(method, parts, {}, data);
    assert.equal((await call("GET", ["api", "subscriptions"]))?.[0], 403);
    for (const id of ["subscriptions", "workbuddy", "model_monitor"]) {
      assert.equal(api.enabled(id), false); installOptionalFixture(state, id);
      const enabled = await call("POST", ["api", "plugins", id], { enabled: true }); assert.equal(enabled?.[0], 200, JSON.stringify(enabled)); assert.equal(api.enabled(id), true);
    }
    assert.equal((await call("GET", ["api", "subscriptions"]))?.[0], 200);
    assert.equal((await call("GET", ["api", "workbuddy", "accounts"]))?.[0], 200);
    let calls = 0;
    const upstream = { model: "asked", requestDeadline: null, capabilities: new Set<string>(), runtimeProfile: "standard", contextWindow: null, maxOutputTokens: null, toolCalling: "native",
      complete: async () => { calls++; return { content: "ok", _response_models: ["got"] }; }, stream: async () => { calls++; return { content: "ok", _response_models: ["got"] }; } };
    const observed = observeOptionalProvider({ stateDir: state, enabled: api.enabled, env: {} }, upstream, "ab".repeat(16), "fixture");
    await observed.stream([], []); assert.equal(calls, 1);
    const monitor = await call("GET", ["api", "model_monitor"]); assert.equal(monitor?.[0], 200);
    assert.equal((monitor?.[1] as { observations: { returnedModels: string[] }[] }).observations[0]?.returnedModels[0], "got");
    const artifact = optionalArtifact("workbuddy")!, accountPath = join(state, "workbuddy/retained-fixture.txt");
    mkdirSync(join(state, "workbuddy"), { recursive: true }); writeFileSync(accountPath, "keep");
    const removed = await call("POST", ["api", "plugins", "marketplace", artifact.packageId, "uninstall"]);
    assert.equal(removed?.[0], 200, JSON.stringify(removed)); assert.equal(api.enabled("workbuddy"), false);
    assert.equal(optionalInstalled(state, "workbuddy"), false); assert.equal(existsSync(optionalRoot(state, artifact)), false);
    assert.equal(readFileSync(accountPath, "utf8"), "keep"); assert.equal((await call("GET", ["api", "workbuddy", "accounts"]))?.[0], 403);
  } finally { await api.close(); rmSync(state, { recursive: true, force: true }); }
});
