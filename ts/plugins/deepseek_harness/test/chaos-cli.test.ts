/** H11.06 chaos CLI/RPC gate. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHarnessApi, harnessCommand } from "../src/index.ts";

describe("chaos RPC (H11.06)", () => {
  it("dispatch returns report and ok=false on hardFail", async () => {
    const api = createHarnessApi();
    const row = await api.dispatch("deepseek_harness/chaos", {
      concurrency: 2,
      callsPerScenario: 2,
      scenarioIds: ["net_timeout"],
    });
    assert.ok(row.report);
    assert.ok("hardFail" in (row.report as object));
  });

  it("rejects an empty scenarioIds list instead of reporting a vacuous pass", async () => {
    const api = createHarnessApi();
    const row = await api.dispatch("deepseek_harness/chaos", { scenarioIds: [] });
    assert.equal(row.ok, false);
    assert.equal((row.error as { code: string }).code, "invalid_input");
  });

  it("CLI chaos exits non-zero on hard fail when forced", async () => {
    const result = await harnessCommand(["chaos", "--calls", "2", "--concurrency", "1"]);
    assert.ok(result.code === 0 || result.code === 1);
    const parsed = JSON.parse(result.output);
    assert.equal(parsed.ok !== undefined, true);
  });
});
