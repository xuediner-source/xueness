/** Model-monitor records and the prefix route. Disabled answers 403 and does not write. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import { createModelMonitorHttp, readObservations, recordObservation } from "../src/index.ts";

const SID = "ab".repeat(16);
const OTHER = "cd".repeat(16);

describe("model monitor", () => {
  it("records only when enabled, filters by session, and clears on numeric true", () => {
    const state = mkdtempSync(`${tmpdir()}\\xueness-monitor-`);
    try {
      recordObservation(state, { providerId: "p", requestedModel: "asked", returnedModels: ["got"], protocol: "openai", outcome: "success", sessionId: SID }, false);
      assert.deepEqual(readObservations(state), []);
      recordObservation(state, { providerId: "p", requestedModel: "asked", returnedModels: ["got", "got"], protocol: "openai", outcome: "success", sessionId: SID }, true);
      recordObservation(state, { providerId: "p", requestedModel: "other", returnedModels: ["x"], sessionId: OTHER }, true);
      const mine = readObservations(state, SID);
      assert.equal(mine.length, 1);
      assert.equal(mine[0]?.requestedModel, "asked");
      assert.deepEqual(mine[0]?.returnedModels, ["got"]);
      const http = createModelMonitorHttp({ stateDir: state, enabled: () => true });
      assert.equal(http.owns("POST", ["api", "model_monitor", "nope"]), true);
      assert.deepEqual(http.dispatch("POST", ["api", "model_monitor", "clear"], {}, { confirmed: true, extra: 1 }), [400, { error: "confirm clearing local monitoring records" }]);
      assert.equal(readObservations(state).length, 2);
      assert.deepEqual(http.dispatch("POST", ["api", "model_monitor", "clear"], {}, { confirmed: 1 }), [200, { cleared: true, observations: [] }]);
      assert.deepEqual(readObservations(state), []);
      recordObservation(state, { requestedModel: "again", sessionId: SID }, true);
      assert.deepEqual(http.dispatch("POST", ["api", "model_monitor", "clear"], {}, { confirmed: 1.0 }), [200, { cleared: true, observations: [] }]);
    } finally { rmSync(state, { recursive: true, force: true }); }
  });

  it("rejects a bad session id and does not write while disabled", () => {
    const state = mkdtempSync(`${tmpdir()}\\xueness-monitor-`);
    try {
      const off = createModelMonitorHttp({ stateDir: state, enabled: () => false });
      const denied = off.dispatch("GET", ["api", "model_monitor"], {}, null);
      assert.deepEqual(denied, [403, { error: "plugin disabled or dependency unavailable: model_monitor", plugin: "model_monitor" }]);
      const body = denied?.[1];
      if (body === null || typeof body !== "object") throw new Error("expected a disabled body");
      assert.equal(Object.hasOwn(body, "code"), false);
      assert.deepEqual(readObservations(state), []);
      const on = createModelMonitorHttp({ stateDir: state, enabled: () => true });
      assert.deepEqual(on.dispatch("GET", ["api", "model_monitor"], { session_id: ["nope"] }, null), [400, { error: "invalid session id" }]);
      assert.equal(on.dispatch("GET", ["api", "elsewhere"], {}, null), null);
      assert.deepEqual(on.dispatch("GET", ["api", "model_monitor"], {}, null), [200, { observations: [] }]);
    } finally { rmSync(state, { recursive: true, force: true }); }
  });
});
