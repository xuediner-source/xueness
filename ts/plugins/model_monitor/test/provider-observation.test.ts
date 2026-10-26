import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import type { ChatProvider } from "@xueness/providers";
import { mkdtempSync } from "../../../test-support/canonical-temp.ts";
import { observeProvider, readObservations } from "../src/index.ts";

it("records real response metadata once without probing, and respects disable during a request", async () => {
  const state = mkdtempSync(join(tmpdir(), "xueness-observation-"));
  try {
    let calls = 0, enabled = true;
    const result = { content: "ok", _response_models: ["returned-model"] };
    const provider = { model: "requested-model", requestDeadline: null, capabilities: new Set(), runtimeProfile: "standard", contextWindow: null, maxOutputTokens: null, toolCalling: "native",
      complete: async () => { calls++; return result; }, stream: async () => { calls++; return result; } } satisfies ChatProvider;
    const observed = observeProvider(provider, { stateDir: state, sessionId: "ab".repeat(16), providerId: "fixture", enabled: () => enabled });
    assert.equal(await observed.stream([], []), result); assert.equal(calls, 1);
    const rows = readObservations(state); assert.equal(rows.length, 1);
    assert.equal(rows[0]?.requestedModel, "requested-model"); assert.deepEqual(rows[0]?.returnedModels, ["returned-model"]);
    observed.requestDeadline = 123; assert.equal(provider.requestDeadline, 123);
    enabled = false; assert.equal(await observed.complete([], []), result); assert.equal(calls, 2); assert.equal(readObservations(state).length, 1);
  } finally { rmSync(state, { recursive: true, force: true }); }
});
