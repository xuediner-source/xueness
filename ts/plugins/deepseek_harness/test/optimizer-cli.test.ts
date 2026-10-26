/** H10.06 optimize CLI/RPC dry-run. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHarnessApi, harnessCommand } from "../src/index.ts";

describe("optimize RPC (H10.06)", () => {
  it("dry-run returns ok without mutating sandbox", async () => {
    const api = createHarnessApi();
    const row = await api.dispatch("deepseek_harness/optimize", {
      dryRun: true,
      seedPrompt: "Solve tasks.",
      budget: { maxGenerations: 1, maxEvaluations: 1 },
    });
    assert.equal(row.ok, true);
    assert.equal(row.dryRun, true);
  });

  it("CLI optimize dry-run exits 0", async () => {
    const result = await harnessCommand(["optimize", "--dry-run"]);
    assert.equal(result.code, 0);
    const parsed = JSON.parse(result.output);
    assert.equal(parsed.ok, true);
  });
});
